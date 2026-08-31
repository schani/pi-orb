import type { OrbState } from "@pi-orb/protocol";

/**
 * Storage failure. `retryable` distinguishes outages from corruption.
 *
 * `invariant` is a deterministic bug — a bad parameter encoding, a missing
 * column, malformed SQL — that no retry can fix. It must never be advertised
 * as retryable to a client and no loop may keep re-attempting it
 * (docs/postmortems/2026-08-11-orb-message-jsonb-param-encoding.md).
 */
export interface StoreError {
  readonly type: "store_error";
  readonly code: "unavailable" | "corruption" | "invariant";
  readonly message: string;
  readonly retryable: boolean;
}

/** The optimistic compare-and-swap on `replication_cursor` affected zero rows. */
export interface CursorConflict {
  readonly type: "cursor_conflict";
}

/**
 * A replication problem no retry can repair (docs/history-replication.md): unknown cursor,
 * session-header mismatch, conflicting immutable record, mapping/validation
 * failure.
 */
export interface ReplicationIntegrityError {
  readonly type: "replication_integrity";
  readonly reason:
    | "cursor_not_found"
    | "session_mismatch"
    | "record_conflict"
    | "mapping_failure"
    | "orb_mismatch";
  readonly message: string;
}

export type CommitPullError = StoreError | CursorConflict | ReplicationIntegrityError;

export interface RuntimeClientError {
  readonly type: "runtime_client_error";
  readonly code:
    | "unreachable"
    | "http_error"
    | "invalid_response"
    | "cursor_not_found"
    | "history_unavailable"
    | "cancelled";
  readonly message: string;
  readonly retryable: boolean;
}

export interface OrbHostProviderError {
  readonly type: "orb_host_provider_error";
  readonly provider: string;
  readonly operation: "provision" | "start" | "stop" | "discard" | "destroy" | "observe" | "list";
  readonly code: "unavailable" | "conflict" | "invalid_state" | "operation_failed" | "cancelled";
  readonly message: string;
  readonly retryable: boolean;
}

/**
 * Tailscale control-API failure (docs/ports.md). `rejected` is the terminal
 * class — bad OAuth credentials, a key request the tailnet refuses — while
 * `unavailable` covers network trouble and 5xx, which a later attempt may
 * survive.
 */
export interface TailscaleError {
  readonly type: "tailscale_error";
  readonly code: "unavailable" | "rejected";
  readonly message: string;
  readonly retryable: boolean;
}

export interface AuthGateError {
  readonly type: "auth_gate_error";
  readonly message: string;
  readonly retryable: boolean;
}

/** Typed values recorded in `orbs.last_error` when transitioning to `failed`. */
export type OrbFailureCode =
  | "deadline_exceeded"
  | "replication_integrity"
  | "runtime_failed"
  | "runtime_never_answered"
  | "provider_failed"
  | "auth_failed"
  | "drain_runtime_unrecoverable";

export function formatOrbFailure(code: OrbFailureCode, message: string): string {
  return `${code}: ${message}`;
}

/** CAS on `state_version` affected zero rows: another actor transitioned first. */
export interface StateConflict {
  readonly type: "state_conflict";
  readonly currentState?: OrbState;
}

/** The parent project disappeared or no longer accepts child creation. */
export interface ProjectConflict {
  readonly type: "project_conflict";
  readonly reason: "not_found" | "deleting" | "children_remain" | "concurrent_change";
}

// ---------------------------------------------------------------------------
// Project secrets (docs/credentials.md)

/** CAS on one project's project-secret pointer lost to another writer. */
export interface ProjectSecretPointerConflict {
  readonly type: "project_secret_pointer_conflict";
}

export type ProjectSecretError =
  | { readonly type: "project_secret_not_found"; readonly message: string }
  | { readonly type: "project_secret_conflict"; readonly message: string }
  | { readonly type: "project_secret_invalid"; readonly message: string }
  | { readonly type: "project_secret_retryable"; readonly message: string }
  | { readonly type: "project_secret_corruption"; readonly message: string };

// ---------------------------------------------------------------------------
// Credential broker (docs/credentials.md)

/** CAS on the credential pointer's `row_version` affected zero rows. */
export interface PointerConflict {
  readonly type: "pointer_conflict";
}

/** Upstream OAuth refresh outcome that is not a new credential. */
export type UpstreamRefreshError =
  /** The refresh token was rejected: terminal, forces re-login. */
  | { readonly type: "invalid_grant"; readonly message: string }
  | {
      readonly type: "upstream_transient";
      readonly message: string;
      readonly retryAfterMs?: number;
    };

/**
 * What a runtime's token request can fail with. Store and upstream failures
 * are folded into `token_retryable` — for the runtime every non-terminal
 * failure means the same thing: back off and ask again.
 */
export type TokenError =
  | { readonly type: "auth_required" }
  | {
      readonly type: "token_retryable";
      readonly message: string;
      readonly retryAfterMs?: number;
    };

// ---------------------------------------------------------------------------
// Workload identity (docs/workload-identity.md)

/**
 * Why one mint was denied, for the deduplicated operator log edge and nothing
 * else (docs/workload-identity.md). Never the audience, the bearer, or the
 * token, and never persisted. `unauthorized` has no code here: a bearer that
 * does not resolve to an orb has no orb to log the denial against, and logging
 * one would say that the bearer resolved to something.
 */
export type MintDenialCode =
  | "invalid_request"
  | "not_mintable"
  | "rate_limited"
  | "signer_failure"
  | "store_unavailable";

/** CAS on a signing key's `row_version` affected zero rows. */
export interface SigningKeyConflict {
  readonly type: "signing_key_conflict";
}

/**
 * Signing failed. `retryable` is the literal `true` on purpose: the issuer
 * fails closed (docs/workload-identity.md), so an unavailable key, an
 * unreachable secret store, and a failed signature all mean "ask again" and
 * never "here is a token signed some other way".
 */
export interface SignerError {
  readonly type: "signer_error";
  /** `unavailable`: no usable key material. `signing_failed`: the operation itself. */
  readonly code: "unavailable" | "signing_failed";
  readonly message: string;
  readonly retryable: true;
  readonly retryAfterMs?: number;
}

/**
 * What one identity-mint attempt can fail with. Every variant mirrors a
 * protocol error code exactly (`IdTokenErrorSchema`), so the HTTP layer is a
 * fold with no decisions of its own beyond the status code; `unauthorized`
 * deliberately carries no detail, because unknown, stale, and fenced bearers
 * must be indistinguishable.
 *
 * `internal` is a store failure no retry can fix — `StoreError` code
 * `invariant` (a deterministic bug of ours) or `corruption` (a row the schema
 * refuses outright) — and must never be advertised as retryable
 * (docs/lifecycle.md).
 */
export type MintError =
  | { readonly type: "invalid_request"; readonly message: string }
  | { readonly type: "unauthorized" }
  | { readonly type: "not_mintable"; readonly state: OrbState }
  | { readonly type: "rate_limited"; readonly retryAfterMs: number }
  | {
      readonly type: "retryable";
      readonly message: string;
      readonly retryAfterMs?: number;
    }
  | { readonly type: "internal"; readonly message: string };
