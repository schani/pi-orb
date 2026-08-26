import type { OrbState } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import type { MintDenialCode, MintError, StoreError } from "./errors.ts";
import { logOrbEvent } from "./log.ts";
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

/**
 * How many orbs one process remembers a denial for. Entries are added only for
 * a denied orb and dropped on its next successful mint, so this bounds what a
 * long-lived process accumulates from orbs that were denied and then deleted.
 * Overflowing clears the whole map, which costs at most one repeated line per
 * still-failing orb.
 */
const MAX_TRACKED_DENIALS = 1_024;

/**
 * Edge-deduplicated operator log for mint denials (docs/workload-identity.md).
 * Nothing durable records a denial — the party who can act on it is the caller
 * inside the orb, which gets the typed error and the CLI's exit code — so this
 * line is what an operator has, and it must stay an edge. `not_mintable` and
 * `invalid_request` are decided before the rate-limit slot is claimed, so a
 * caller holding a stopped orb's bearer would otherwise write one line per
 * request forever.
 *
 * One line per orb per code, until that orb mints successfully or the code
 * changes. The state is per process and per instance on purpose: each control
 * plane reports the decisions it took, and there is nothing to reconcile.
 */
export class MintDenialLog {
  private readonly lastCode = new Map<string, MintDenialCode>();

  /** Logs the edge into a new code; a repeat of the same code is silent. */
  denied(
    task: SimulationTask,
    orb: { readonly id: string; readonly hostIncarnation: number },
    code: MintDenialCode,
  ): void {
    if (this.lastCode.get(orb.id) === code) return;
    if (this.lastCode.size >= MAX_TRACKED_DENIALS) this.lastCode.clear();
    this.lastCode.set(orb.id, code);
    logOrbEvent(task, orb.id, "identity-mint-denied", {
      incarnation: orb.hostIncarnation,
      code,
    });
  }

  /** A healthy mint logs nothing and re-arms the edge for the next denial. */
  succeeded(orbId: string): void {
    this.lastCode.delete(orbId);
  }
}

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
 * then claim the rate-limit slot, then sign. A denial is reported to the
 * caller as a typed error and nowhere else: `deps.denials` turns the ones that
 * belong to a resolved orb into a deduplicated operator log edge, and the
 * control plane keeps no record of the attempt.
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
    // answer, and none of them is logged: there is no orb identity to log it
    // against, and a per-orb line would reveal that the bearer resolved to
    // something.
    if (
      orb === null ||
      orb.runtimeTokenHash === null ||
      orb.hostDiscardThroughIncarnation !== null ||
      !hashesEqual(orb.runtimeTokenHash, request.tokenHash)
    ) {
      return err(UNAUTHORIZED);
    }
    const orbId = orb.id;

    if (!MINT_STATES.includes(orb.state)) {
      deps.denials.denied(task, orb, "not_mintable");
      return err({ type: "not_mintable", state: orb.state });
    }

    // Validated after the orb resolves so the denial names an orb; the
    // protocol schema and the CLI reject these shapes earlier anyway.
    const constants = deps.constants;
    const audienceBytes = utf8Bytes(request.audience);
    if (audienceBytes === 0 || audienceBytes > constants.maxAudienceBytes) {
      deps.denials.denied(task, orb, "invalid_request");
      return err({
        type: "invalid_request",
        message: `audience must be 1..${constants.maxAudienceBytes} UTF-8 bytes`,
      });
    }
    const ttlSeconds = request.ttlSeconds ?? constants.defaultTtlSeconds;
    if (ttlSeconds < constants.minTtlSeconds || ttlSeconds > constants.maxTtlSeconds) {
      deps.denials.denied(task, orb, "invalid_request");
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
      deps.denials.denied(task, orb, "store_unavailable");
      return err({ type: "retryable", message: claim.error.message });
    }
    if (!claim.value.claimed) {
      deps.denials.denied(task, orb, "rate_limited");
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
      deps.denials.denied(task, orb, "signer_failure");
      return err({
        type: "retryable",
        message: signed.error.message,
        ...(signed.error.retryAfterMs === undefined
          ? {}
          : { retryAfterMs: signed.error.retryAfterMs }),
      });
    }
    deps.denials.succeeded(orbId);
    return ok({ token: signed.value.jwt });
  };
  return new ResultAsync(run());
}
