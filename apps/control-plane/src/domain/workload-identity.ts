import type { OrbState } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import type { MintError, MintFailureCode, StoreError } from "./errors.ts";
import type { IdTokenClaims, MintDeps } from "./ports.ts";

/**
 * Identity minting (docs/workload-identity.md). The control plane is the OIDC
 * issuer for the code running inside an orb: it authenticates the
 * per-incarnation runtime bearer, derives every claim from the orb row, and
 * signs a short-lived JWT. The caller supplies only an audience and a
 * lifetime; no identity input is ever accepted from the request.
 */

/**
 * Lifecycle states allowed to mint. Deliberately narrower than the broker's
 * `RUNTIME_TOKEN_STATES` (`domain/broker.ts`), which also admits `stopping`
 * and `archiving` so a draining runtime can finish and seal its transcript
 * with credentials it already relies on. Identity is different: a stop request
 * must close minting immediately, before host shutdown completes, and an
 * archiving orb must not acquire fresh cloud access on its way out. `creating`
 * is included because the first boot mints while the orb has not yet reached
 * `running`.
 */
export const MINT_STATES: readonly OrbState[] = ["creating", "starting", "running"];

export interface MintRequest {
  /** SHA-256 hex of the presented bearer; hashing stays at the HTTP boundary. */
  readonly tokenHash: string;
  readonly audience: string;
  readonly ttlSeconds?: number;
}

const UNAUTHORIZED: MintError = { type: "unauthorized" };

/**
 * Constant-time equality over two hex digests. The route helper uses
 * `timingSafeEqual`, but domain code may not import `node:crypto`
 * (docs/testing.md), so this compares character codes without an early exit
 * instead. Lengths are equal by construction for real digests; an unequal
 * length is a mismatch and leaks nothing an attacker does not already know.
 */
function hashesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

/** UTF-8 length of the caller's audience; the cap is in bytes, not characters. */
function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Store failures asking again cannot repair. `invariant` is a deterministic bug
 * of ours — a bad parameter encoding, a missing column, malformed SQL — and
 * `corruption` is a row shape the schema refuses outright; both carry
 * `retryable: false` for the same reason. Advertising either as retryable is
 * precisely the defect of
 * docs/postmortems/2026-08-11-orb-message-jsonb-param-encoding.md: a client
 * spinning forever on a refusal that will never change its answer.
 */
function isNonRetryable(error: StoreError): boolean {
  return error.code === "invariant" || error.code === "corruption";
}

/** A store failure as a mint failure; a non-retryable one is `internal`. */
function mapStoreError(error: StoreError): MintError {
  return isNonRetryable(error)
    ? { type: "internal", message: error.message }
    : { type: "retryable", message: error.message };
}

/**
 * Mints one identity token for the orb the bearer hash resolves to. The
 * decisions run in the order of docs/workload-identity.md's request path:
 * authenticate, then check the lifecycle state, then validate the request,
 * then claim the rate-limit slot, then sign. Everything after authentication
 * records a durable typed denial, so a user asking "why can my orb not get
 * credentials?" has an answer that outlives the request.
 */
export function mintIdToken(
  task: SimulationTask,
  deps: MintDeps,
  request: MintRequest,
): ResultAsync<{ token: string }, MintError> {
  const run = async (): Promise<Result<{ token: string }, MintError>> => {
    const orbResult = await deps.store.getOrbByRuntimeTokenHash(task, request.tokenHash);
    if (orbResult.isErr()) return err(mapStoreError(orbResult.error));
    const orb = orbResult.value;
    // Unknown, stale, and discard-fenced bearers are one indistinguishable
    // answer, and none of them is recorded: there is no orb identity to record
    // it on, and answering differently would reveal that another orb exists.
    if (
      orb === null ||
      orb.runtimeTokenHash === null ||
      orb.hostDiscardThroughIncarnation !== null ||
      !hashesEqual(orb.runtimeTokenHash, request.tokenHash)
    ) {
      return err(UNAUTHORIZED);
    }
    const orbId = orb.id;

    /**
     * Best-effort: the status is advisory, so a failed status write must never
     * replace the real denial with a store error the caller cannot act on.
     *
     * Deduplicated against the code already on the orb row, because two of the
     * denials below — `not_mintable` and `invalid_request` — are decided
     * *before* the rate-limit slot is claimed. Without this, nothing throttles
     * them at all: a caller holding a stopped orb's bearer drives one UPDATE
     * per request, forever. The dedup lives here rather than at each call site
     * so every path gets the same floor, and a *different* code still writes —
     * `rate_limited` becoming `not_mintable` is a state change the user needs
     * to see.
     *
     * The price is a stale `mintFailureAt`: through a run of identical denials
     * the timestamp stays at the first one instead of tracking the latest, and
     * that staleness is accepted deliberately in exchange for not writing per
     * request. The product reads this status as "the last identity mint attempt
     * failed" — a *last failure*, not a *latest timestamp*
     * (docs/workload-identity.md).
     */
    const record = async (code: MintFailureCode): Promise<void> => {
      // Skipped only while the row already says this *and* still says it
      // visibly. Currency is decided on read (`http/views.ts`): a failure older
      // than `lastMintAt` is hidden as superseded by the later success. So a
      // bare code comparison would keep deduplicating against a status the user
      // can no longer see, and an orb that starts failing again after a healthy
      // stretch would go silent forever.
      const visible =
        orb.mintFailureAt !== null &&
        (orb.lastMintAt === null || orb.mintFailureAt >= orb.lastMintAt);
      if (orb.mintFailureCode === code && visible) return;
      await deps.store.recordMintFailure(task, { orbId, code, at: task.wallNow() });
    };

    if (!MINT_STATES.includes(orb.state)) {
      await record("not_mintable");
      return err({ type: "not_mintable", state: orb.state });
    }

    // Validated after the orb resolves so the denial is recordable; the
    // protocol schema and the CLI reject these shapes earlier anyway.
    const constants = deps.constants;
    const audienceBytes = utf8Bytes(request.audience);
    if (audienceBytes === 0 || audienceBytes > constants.maxAudienceBytes) {
      await record("invalid_request");
      return err({
        type: "invalid_request",
        message: `audience must be 1..${constants.maxAudienceBytes} UTF-8 bytes`,
      });
    }
    const ttlSeconds = request.ttlSeconds ?? constants.defaultTtlSeconds;
    if (ttlSeconds < constants.minTtlSeconds || ttlSeconds > constants.maxTtlSeconds) {
      await record("invalid_request");
      return err({
        type: "invalid_request",
        message: `ttlSeconds must be ${constants.minTtlSeconds}..${constants.maxTtlSeconds}`,
      });
    }

    const now = task.wallNow();
    const claim = await deps.store.claimMintSlot(task, {
      orbId,
      at: now,
      minIntervalMs: constants.minMintIntervalMs,
    });
    if (claim.isErr()) {
      if (isNonRetryable(claim.error)) return err(mapStoreError(claim.error));
      // A store outage is what the user sees as "identity unavailable"; the
      // status write goes to the same store and may well fail too, which is
      // exactly what best-effort recording is for.
      await record("store_unavailable");
      return err({ type: "retryable", message: claim.error.message });
    }
    if (!claim.value.claimed) {
      await record("rate_limited");
      return err({ type: "rate_limited", retryAfterMs: claim.value.retryAfterMs });
    }

    const issuedAt = Math.floor(now / 1000);
    const claims: IdTokenClaims = {
      iss: deps.issuerUrl,
      aud: request.audience,
      sub: orb.id,
      iat: issuedAt,
      exp: issuedAt + ttlSeconds,
      jti: deps.mintIds.newJti(task),
      project_id: orb.projectId,
      orb_id: orb.id,
      host_incarnation: orb.hostIncarnation,
      token_use: "exchanged",
    };

    const signed = await deps.signer.signIdToken(task, claims);
    if (signed.isErr()) {
      // The claimed slot is deliberately not refunded: a signer outage under
      // load must not become an unthrottled retry loop against the signer.
      await record("signer_failure");
      return err({
        type: "retryable",
        message: signed.error.message,
        ...(signed.error.retryAfterMs === undefined
          ? {}
          : { retryAfterMs: signed.error.retryAfterMs }),
      });
    }
    return ok({ token: signed.value.jwt });
  };
  return new ResultAsync(run());
}
