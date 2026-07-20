import type { OrbState } from "@pi-orb/protocol";

/** Storage failure. `retryable` distinguishes outages from corruption. */
export interface StoreError {
  readonly type: "store_error";
  readonly code: "unavailable" | "corruption";
  readonly message: string;
  readonly retryable: boolean;
}

/** The optimistic compare-and-swap on `replication_cursor` affected zero rows. */
export interface CursorConflict {
  readonly type: "cursor_conflict";
}

/**
 * A replication problem no retry can repair (DESIGN.md §8.4): unknown cursor,
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
  readonly operation: "provision" | "start" | "stop" | "observe" | "list";
  readonly code: "unavailable" | "conflict" | "invalid_state" | "operation_failed" | "cancelled";
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
