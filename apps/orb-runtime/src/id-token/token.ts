import { MAX_AUDIENCE_BYTES, MAX_TTL_SECONDS, MIN_TTL_SECONDS } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, ok, type Result } from "neverthrow";

/**
 * Point-of-use workload-identity logic (docs/workload-identity.md) behind the
 * `pi-orb id-token` shim. Every invocation mints a fresh short-lived OIDC token
 * from the control plane with the incarnation bearer the provider injected;
 * nothing is cached, on disk or in memory. The HTTP transport sits behind
 * `IdTokenEndpoint` so the argument, validation, and retry rules are testable
 * without a network — the same split as the `gh` helper's broker client.
 */

export const USAGE = "usage: pi-orb id-token --audience <audience> [--ttl-seconds <60..3600>]";

/**
 * Exit codes, one per failure class. They are a contract: an executable
 * credential source distinguishes "this orb may never mint" from "try again"
 * by the code alone.
 */
export const EXIT_OK = 0;
/** Bad arguments, or no orb runtime environment to authenticate with. */
export const EXIT_USAGE = 2;
export const EXIT_UNAUTHORIZED = 3;
export const EXIT_NOT_MINTABLE = 4;
export const EXIT_RATE_LIMITED = 5;
/** Control plane unreachable, or still transiently failing at the deadline. */
export const EXIT_UNAVAILABLE = 6;
/** A deterministic control-plane bug: retrying it cannot help. */
export const EXIT_INTERNAL = 7;

export interface IdTokenRequest {
  readonly audience: string;
  /** Omitted entirely when the caller wants the issuer's default lifetime. */
  readonly ttlSeconds?: number;
}

/**
 * One transport outcome. The wire codes are the protocol's own
 * (`IdTokenErrorSchema`); this type adds nothing but the successful token.
 */
export type IdTokenEndpointResult =
  | { readonly kind: "token"; readonly token: string }
  | { readonly kind: "invalid_request"; readonly message: string }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "not_mintable"; readonly message: string }
  | { readonly kind: "rate_limited"; readonly retryAfterMs?: number }
  | { readonly kind: "retryable"; readonly message: string; readonly retryAfterMs?: number }
  | { readonly kind: "internal"; readonly message: string };

export interface IdTokenEndpoint {
  mint(task: SimulationTask, request: IdTokenRequest): Promise<IdTokenEndpointResult>;
}

export interface IdTokenClientConstants {
  /**
   * The whole invocation's budget. A CLI must answer fast, so this is the
   * `gh` helper's 10 s rather than the runtime's 30–60 s boot windows — long
   * enough to ride out the first-boot window before the bearer hash commits
   * and the 2 s per-orb mint floor, short enough that a credential chain
   * calling this helper does not hang.
   */
  readonly retryWindowMs: number;
  readonly backoffBaseMs: number;
  readonly backoffCapMs: number;
}

export const CLI_ID_TOKEN_CONSTANTS: IdTokenClientConstants = {
  retryWindowMs: 10_000,
  backoffBaseMs: 250,
  backoffCapMs: 2_000,
};

/**
 * A terminal failure. `usage` covers both locally rejected arguments and the
 * control plane's own `invalid_request`: either way the caller must change the
 * request. No variant ever carries the bearer or the token — the only place a
 * JWT appears is the successful stdout write.
 */
export type IdTokenFailure =
  | { readonly type: "usage"; readonly message: string }
  | { readonly type: "unauthorized" }
  | { readonly type: "not_mintable"; readonly message: string }
  | { readonly type: "rate_limited"; readonly message: string }
  | { readonly type: "unavailable"; readonly message: string }
  | { readonly type: "internal"; readonly message: string };

export function exitCodeFor(failure: IdTokenFailure): number {
  switch (failure.type) {
    case "usage":
      return EXIT_USAGE;
    case "unauthorized":
      return EXIT_UNAUTHORIZED;
    case "not_mintable":
      return EXIT_NOT_MINTABLE;
    case "rate_limited":
      return EXIT_RATE_LIMITED;
    case "unavailable":
      return EXIT_UNAVAILABLE;
    case "internal":
      return EXIT_INTERNAL;
  }
}

export function describeIdTokenFailure(failure: IdTokenFailure): string {
  switch (failure.type) {
    case "usage":
      return failure.message;
    case "unauthorized":
      // Unknown, stale, and fenced bearers are one indistinguishable answer
      // from the control plane, so the advice covers all three.
      return "the control plane rejected this orb's identity (replaced or retired compute?)";
    case "not_mintable":
      return `identity unavailable: ${failure.message}`;
    case "rate_limited":
      return `identity throttled: ${failure.message}`;
    case "unavailable":
      return `identity issuer unavailable: ${failure.message}`;
    case "internal":
      return `identity issuer error: ${failure.message}`;
  }
}

function usageError(message: string): IdTokenFailure {
  return { type: "usage", message: `${message}\n${USAGE}` };
}

/** UTF-8 length: the audience cap is in bytes, matching the control plane. */
function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Parses `--audience`/`--ttl-seconds` in both `--flag value` and `--flag=value`
 * forms and enforces every bound the protocol declares, so an invalid request
 * never reaches the network. A leading `id-token` word is accepted as well as
 * consumed by the shim: on the process host provider there is no shim and the
 * Node entry point is invoked directly.
 */
export function parseIdTokenArgs(argv: readonly string[]): Result<IdTokenRequest, IdTokenFailure> {
  const args = argv[0] === "id-token" ? argv.slice(1) : argv;
  let audience: string | null = null;
  let ttlText: string | null = null;

  for (let index = 0; index < args.length; index++) {
    const argument = args[index] ?? "";
    const equals = argument.indexOf("=");
    const inlineValue = equals > 0 ? argument.slice(equals + 1) : null;
    const flag = equals > 0 ? argument.slice(0, equals) : argument;
    if (flag !== "--audience" && flag !== "--ttl-seconds") {
      return err(usageError(`unknown argument: ${argument}`));
    }
    let value = inlineValue;
    if (value === null) {
      const next = args[index + 1];
      if (next === undefined) return err(usageError(`${flag} requires a value`));
      value = next;
      index += 1;
    }
    if (flag === "--audience") {
      if (audience !== null) return err(usageError("--audience given twice"));
      audience = value;
    } else {
      if (ttlText !== null) return err(usageError("--ttl-seconds given twice"));
      ttlText = value;
    }
  }

  if (audience === null || audience === "") return err(usageError("--audience is required"));
  if (utf8Bytes(audience) > MAX_AUDIENCE_BYTES) {
    return err(usageError(`--audience must be at most ${MAX_AUDIENCE_BYTES} UTF-8 bytes`));
  }
  if (ttlText === null) return ok({ audience });
  // Integer seconds only: `--ttl-seconds 90.5` and `--ttl-seconds 1e3` are
  // mistakes, not lifetimes to round.
  if (!/^\d+$/.test(ttlText)) {
    return err(usageError("--ttl-seconds must be a whole number of seconds"));
  }
  const ttlSeconds = Number(ttlText);
  if (ttlSeconds < MIN_TTL_SECONDS || ttlSeconds > MAX_TTL_SECONDS) {
    return err(usageError(`--ttl-seconds must be ${MIN_TTL_SECONDS}..${MAX_TTL_SECONDS}`));
  }
  return ok({ audience, ttlSeconds });
}

/**
 * Mints one token, retrying only the outcomes that a later attempt can change:
 * the first-boot 401 before the incarnation's bearer hash is durably committed,
 * the per-orb mint floor, and transient issuer/network failures. A refusal the
 * orb's lifecycle state or the request shape caused is returned immediately —
 * re-sending it would only burn the caller's budget.
 */
export async function fetchIdToken(
  task: SimulationTask,
  endpoint: IdTokenEndpoint,
  request: IdTokenRequest,
  constants: IdTokenClientConstants = CLI_ID_TOKEN_CONSTANTS,
): Promise<Result<string, IdTokenFailure>> {
  const deadline = task.monotonicNow() + constants.retryWindowMs;
  let attempt = 0;
  for (;;) {
    const outcome = await endpoint.mint(task, request);
    let terminal: IdTokenFailure;
    let retryAfterMs: number | undefined;
    switch (outcome.kind) {
      case "token":
        return ok(outcome.token);
      case "invalid_request":
        return err({ type: "usage", message: outcome.message });
      case "not_mintable":
        return err({ type: "not_mintable", message: outcome.message });
      case "internal":
        return err({ type: "internal", message: outcome.message });
      case "unauthorized":
        terminal = { type: "unauthorized" };
        break;
      case "rate_limited":
        terminal = { type: "rate_limited", message: "per-orb mint rate limit" };
        retryAfterMs = outcome.retryAfterMs;
        break;
      case "retryable":
        terminal = { type: "unavailable", message: outcome.message };
        retryAfterMs = outcome.retryAfterMs;
        break;
    }
    attempt += 1;
    const backoff = Math.min(constants.backoffCapMs, constants.backoffBaseMs * 2 ** (attempt - 1));
    const waitMs = retryAfterMs === undefined ? backoff : Math.max(retryAfterMs, backoff);
    // Give up rather than sleep past the window: a `Retry-After` longer than
    // the CLI's whole budget is an answer, not an instruction to hang.
    if (task.monotonicNow() + waitMs > deadline) return err(terminal);
    await task.sleep(waitMs, "id-token retry backoff");
  }
}
