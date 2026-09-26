import type { TokenName } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, ok, type Result } from "neverthrow";
import { sleepResult, withDeadline } from "./dst.ts";
import type { OAuthRefreshDiagnostic, StoreError, TokenError } from "./errors.ts";
import type {
  BrokerDeps,
  CredentialPointerRow,
  CredentialPointerStoreFactory,
  StoredCredential,
} from "./ports.ts";

export interface UserBrokerDeps extends Omit<BrokerDeps, "pointers"> {
  readonly pointers: CredentialPointerStoreFactory;
}

/** Construct a cheap user-bound broker; shared secrets and upstream clients stay shared. */
export function bindUserBroker(deps: UserBrokerDeps, userId: string): BrokerDeps {
  return { ...deps, pointers: deps.pointers.forUser(userId) };
}

/**
 * Credential broker (docs/credentials.md): serves short-lived access tokens to
 * orb runtimes from the pointer-row + secret-store pair, coalescing upstream
 * refreshes behind a leased critical section. Every mutation is fenced by the
 * pointer's `rowVersion` CAS; a stale actor can never clobber a newer
 * credential. The refresh token itself never appears in a return value.
 */

/** The model-credential slot of the first slice. */
export const CODEX_PROVIDER = "openai-codex";

/** The GitHub user-credential slot (docs/credentials.md). */
export const GITHUB_PROVIDER = "github";

/**
 * Logical token name → backing provider. The runtime asks for a capability;
 * which upstream backs it never appears in the wire contract.
 */
export const TOKEN_PROVIDERS: Readonly<Record<TokenName, string>> = {
  model: CODEX_PROVIDER,
  github: GITHUB_PROVIDER,
};

/**
 * Orb states whose runtime token is honored: every state in which the host
 * is meant to be up. `creating` is included because the first boot fetches
 * its token while the orb has not yet reached `running`.
 */
export const RUNTIME_TOKEN_STATES: readonly string[] = [
  "creating",
  "starting",
  "running",
  "stopping",
  // Archive may temporarily restore a stopped runtime solely to finish and
  // seal its transcript; authorization is revoked at archived finalization.
  "archiving",
];

export interface TokenRequest {
  readonly reason: "startup" | "expiring" | "rejected";
  /** The generation the caller saw fail or near expiry; enables coalescing. */
  readonly staleGeneration?: number;
}

export interface TokenGrant {
  readonly accessToken: string;
  readonly accountId: string;
  /** Wall-clock ms. */
  readonly expiresAt: number;
  readonly generation: number;
}

const retryable = (message: string, retryAfterMs?: number): TokenError => ({
  type: "token_retryable",
  message,
  ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
});

const AUTH_REQUIRED: TokenError = { type: "auth_required" };

function grantOf(credential: StoredCredential, generation: number): TokenGrant {
  return {
    accessToken: credential.access,
    accountId: credential.accountId,
    expiresAt: credential.expiresAt,
    generation,
  };
}

/** Best-effort lease release; conflicts and store failures are ignored. */
async function releaseLease(
  task: SimulationTask,
  deps: BrokerDeps,
  provider: string,
  leased: CredentialPointerRow,
  diagnostic?: OAuthRefreshDiagnostic,
): Promise<void> {
  await deps.pointers.casWritePointer(
    task,
    provider,
    leased.rowVersion,
    {
      generation: leased.generation,
      secretVersion: leased.secretVersion,
      refreshLeaseUntil: 0,
      lastRefreshAt: leased.lastRefreshAt,
    },
    diagnostic,
  );
}

export async function getToken(
  task: SimulationTask,
  deps: BrokerDeps,
  provider: string,
  request: TokenRequest,
): Promise<Result<TokenGrant, TokenError>> {
  const constants = deps.constants;
  const deadline = task.monotonicNow() + constants.requestDeadlineMs;
  const pause = async (ms: number): Promise<void> => {
    await sleepResult(task, ms, "broker pause");
  };

  while (task.monotonicNow() <= deadline) {
    const pointerResult = await deps.pointers.readPointer(task, provider);
    if (pointerResult.isErr()) return err(retryable(pointerResult.error.message));
    const pointer = pointerResult.value;
    if (pointer === null || pointer.secretVersion === null) return err(AUTH_REQUIRED);

    const credentialResult = await deps.secrets.readSecret(task, provider, pointer.secretVersion);
    if (credentialResult.isErr()) return err(retryable(credentialResult.error.message));
    const credential = credentialResult.value;
    if (credential === null) {
      // The pointer moved between our reads (the old version was destroyed),
      // or the secret store is behind. Re-read; the deadline bounds us.
      await pause(constants.waiterPollMs);
      continue;
    }

    const now = task.wallNow();
    const expired = credential.expiresAt <= now;
    const nearExpiry = credential.expiresAt - now <= constants.refreshThresholdMs;
    /** The caller explicitly asked for something newer than what we hold. */
    const demandsNewer =
      (request.reason === "rejected" || request.reason === "expiring") &&
      request.staleGeneration === pointer.generation;
    const rejected = request.reason === "rejected" && demandsNewer;

    if (!demandsNewer && !expired && !nearExpiry) {
      return ok(grantOf(credential, pointer.generation));
    }

    if (pointer.refreshLeaseUntil > now) {
      // Another actor is refreshing. Serve the current token when it is
      // still usable and the caller did not demand a newer one.
      if (!expired && !demandsNewer) return ok(grantOf(credential, pointer.generation));
      await pause(constants.waiterPollMs);
      continue;
    }

    const sinceLastRefresh = now - pointer.lastRefreshAt;
    if (!expired && sinceLastRefresh < constants.minRefreshIntervalMs) {
      // Global refresh rate limit (abuse backstop). A still-valid token is
      // served unless the caller says the upstream rejected exactly it.
      if (!rejected) return ok(grantOf(credential, pointer.generation));
      return err(
        retryable("refresh rate limited", constants.minRefreshIntervalMs - sinceLastRefresh),
      );
    }

    const upstream = deps.upstreams[provider];
    if (upstream === undefined) {
      // No refresher wired for this provider (configuration gap). A
      // still-valid token is served; an expired one cannot recover here.
      if (!expired && !rejected) return ok(grantOf(credential, pointer.generation));
      return err(retryable(`no upstream refresher for provider ${provider}`));
    }

    const leaseResult = await deps.pointers.casWritePointer(task, provider, pointer.rowVersion, {
      generation: pointer.generation,
      secretVersion: pointer.secretVersion,
      refreshLeaseUntil: now + constants.leaseMs,
      lastRefreshAt: now,
    });
    if (leaseResult.isErr()) {
      // Conflict: someone moved first — re-read. Store failure: the write is
      // ambiguous; re-read resolves it either way.
      await pause(constants.waiterPollMs);
      continue;
    }
    const leased = leaseResult.value;

    const refreshResult = await withDeadline(
      task,
      constants.upstreamTimeoutMs,
      "upstream refresh",
      (context) => upstream.refresh(task, credential, context),
    );

    if (refreshResult.isOk()) {
      const fresh = refreshResult.value;
      let version: string | null = null;
      for (let attempt = 0; attempt < 3 && version === null; attempt++) {
        const write = await deps.secrets.writeSecret(task, provider, fresh);
        if (write.isOk()) {
          version = write.value.version;
        } else {
          await pause(constants.waiterPollMs);
        }
      }
      if (version === null) {
        // Acknowledged loss window: the rotation may only exist in memory.
        // Surface loudly; if the old refresh token is already dead this ends
        // in auth_required on a later attempt.
        await releaseLease(task, deps, provider, leased);
        return err(retryable("credential write failed after upstream refresh"));
      }
      let publicationSuperseded = false;
      let expectedRowVersion = leased.rowVersion;
      let firstPublicationAttempt = true;
      while (firstPublicationAttempt || task.monotonicNow() <= deadline) {
        firstPublicationAttempt = false;
        const commit = await deps.pointers.casWritePointer(task, provider, expectedRowVersion, {
          generation: pointer.generation + 1,
          secretVersion: version,
          refreshLeaseUntil: 0,
          lastRefreshAt: now,
        });
        if (commit.isOk()) {
          await deps.secrets.destroySecret(task, provider, pointer.secretVersion);
          return ok(grantOf(fresh, pointer.generation + 1));
        }

        // A conflict may be only a replacement lease over the credential that
        // this refresh consumed. Follow that exact fence; never overwrite a
        // newer generation or secret, including a concurrent login.
        for (;;) {
          const reread = await deps.pointers.readPointer(task, provider);
          if (reread.isOk()) {
            if (reread.value?.secretVersion === version) {
              await deps.secrets.destroySecret(task, provider, pointer.secretVersion);
              return ok(grantOf(fresh, reread.value.generation));
            }
            if (
              reread.value?.generation === pointer.generation &&
              reread.value.secretVersion === pointer.secretVersion
            ) {
              expectedRowVersion = reread.value.rowVersion;
              break;
            }
            await deps.secrets.destroySecret(task, provider, version);
            publicationSuperseded = true;
            break;
          }
          if (task.monotonicNow() > deadline) {
            return err(retryable("credential commit uncertain"));
          }
          await pause(constants.waiterPollMs);
        }
        if (publicationSuperseded) break;
      }
      if (publicationSuperseded) continue;
      return err(retryable("credential commit uncertain"));
    }

    if (refreshResult.error.type === "invalid_grant") {
      // Fenced clear: only the generation we actually submitted upstream.
      const clear = await deps.pointers.casWritePointer(
        task,
        provider,
        leased.rowVersion,
        {
          generation: pointer.generation + 1,
          secretVersion: null,
          refreshLeaseUntil: 0,
          lastRefreshAt: now,
        },
        refreshResult.error.diagnostic,
      );
      if (clear.isOk()) return err(AUTH_REQUIRED);
      if (clear.error.type === "pointer_conflict") {
        // A newer credential appeared while we were refreshing; serve it.
        continue;
      }
      return err(retryable(clear.error.message));
    }

    // Transient upstream failure.
    await releaseLease(task, deps, provider, leased, refreshResult.error.diagnostic);
    if (!expired && !rejected) return ok(grantOf(credential, pointer.generation));
    await pause(refreshResult.error.retryAfterMs ?? 2 * constants.waiterPollMs);
  }

  return err(retryable("token request deadline exceeded"));
}

/**
 * Commits a freshly logged-in credential. Last-writer-wins among concurrent
 * logins, fenced by `rowVersion` so no write is ever silently dropped —
 * a conflicting write is re-read and retried on top of the newer state.
 */
export interface LoginCommitUncertain {
  readonly type: "login_commit_uncertain";
  readonly message: string;
  readonly retryable: true;
}

export async function commitLoginCredential(
  task: SimulationTask,
  deps: BrokerDeps,
  provider: string,
  credential: StoredCredential,
): Promise<Result<void, StoreError | LoginCommitUncertain>> {
  const write = await deps.secrets.writeSecret(task, provider, credential);
  if (write.isErr()) return err(write.error);
  const version = write.value.version;

  for (let attempt = 0; attempt < 10; attempt++) {
    const pointerResult = await deps.pointers.readPointer(task, provider);
    if (pointerResult.isErr()) {
      await sleepResult(task, 200, "login commit backoff");
      continue;
    }
    const pointer = pointerResult.value;
    const commit = await deps.pointers.casWritePointer(
      task,
      provider,
      pointer?.rowVersion ?? null,
      {
        generation: (pointer?.generation ?? 0) + 1,
        secretVersion: version,
        refreshLeaseUntil: 0,
        lastRefreshAt: pointer?.lastRefreshAt ?? 0,
      },
    );
    if (commit.isOk()) {
      if (pointer?.secretVersion != null) {
        await deps.secrets.destroySecret(task, provider, pointer.secretVersion);
      }
      return ok(undefined);
    }
    if (commit.error.type !== "pointer_conflict") {
      // The CAS may have landed. Only an exact reread can acknowledge it;
      // reusing this staged version could resurrect a superseded, destroyed
      // version after another actor already rotated the credential.
      const reread = await deps.pointers.readPointer(task, provider);
      if (reread.isOk() && reread.value?.secretVersion === version) return ok(undefined);
      return err({
        type: "login_commit_uncertain",
        message: "login credential commit uncertain",
        retryable: true,
      });
    }
    await sleepResult(task, 200, "login commit retry");
  }
  // Every attempted CAS returned a definitive conflict (or no CAS was
  // attempted after a failed read), so this staged version was never
  // published. Destroy only that exact version before returning.
  const cleanup = await deps.secrets.destroySecret(task, provider, version);
  if (cleanup.isErr()) return err(cleanup.error);
  return err({
    type: "store_error",
    code: "unavailable",
    message: "login commit retries exhausted",
    retryable: true,
  });
}
