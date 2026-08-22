import type {
  HarnessSessionMetadata,
  MessageInputBlock,
  OrbMessageStatus,
  OrbState,
  ProjectState,
  StopReason,
} from "@pi-orb/protocol";
import type { MintFailureCode } from "./errors.ts";

/**
 * Domain view of an orb row (docs/history-replication.md). Timestamps are wall-clock
 * milliseconds; adapters convert to/from `timestamptz`.
 */
export type HostDiscardReason = "failed" | "host_spec_changed";

export type BootHook = "setup" | "resume";
export type BootHookFailureReason = "failed" | "timeout" | "hook_not_executable";

export interface OrbRow {
  readonly id: string;
  readonly projectId: string;
  readonly name: string | null;
  readonly autoNameLeaseUntil: number | null;
  readonly autoNameAttempts: number;
  readonly autoNameNextAttemptAt: number | null;
  readonly state: OrbState;
  readonly stateVersion: number;
  readonly hostKind: string;
  readonly hostRef: string | null;
  /** Monotone identity of disposable compute; workspace identity is not incarnation-scoped. */
  readonly hostIncarnation: number;
  /** Immutable launch specification committed for the current compute incarnation. */
  readonly hostSpecFingerprint: string | null;
  readonly hostSpecGeneration: number | null;
  /** Durable authority to discard compute at or below this incarnation. */
  readonly hostDiscardThroughIncarnation: number | null;
  readonly hostDiscardReason: HostDiscardReason | null;
  readonly hostDiscardError: string | null;
  readonly hostDiscardEvidence: string | null;
  readonly hostDiscardRequestedAt: number | null;
  /** Persisted when the runtime first reports ready; doubles as the "has ever been ready" marker. */
  readonly checkoutCommit: string | null;
  readonly harnessSessionId: string | null;
  readonly harnessSessionHeader: HarnessSessionMetadata | null;
  readonly lastError: string | null;
  /**
   * SHA-256 of the per-host-incarnation runtime token (docs/credentials.md);
   * follows what the provisioned host actually carries. Never the plaintext.
   */
  readonly runtimeTokenHash: string | null;
  readonly replicationCursor: string | null;
  readonly replicatedHeadId: string | null;
  /**
   * Restart-stable activity timestamp for idle auto-stop (docs/lifecycle.md).
   * Advisory and monotone: written outside the state_version CAS.
   */
  readonly lastBusyAt: number | null;
  /** Why the orb last entered `stopping`; null for explicit stops. */
  readonly stopReason: StopReason | null;
  /**
   * Latest identity-mint denial, shown to the orb user when identity is
   * unavailable (docs/workload-identity.md). Advisory and always paired: both
   * columns are set together or both are null.
   */
  readonly mintFailureCode: MintFailureCode | null;
  readonly mintFailureAt: number | null;
  /** Durable per-orb mint rate-limit floor; monotone, written outside the CAS. */
  readonly lastMintAt: number | null;
  readonly stateChangedAt: number;
  readonly archivedAt?: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface OrbMessageRow {
  readonly orbId: string;
  readonly messageId: string;
  readonly ordinal: number;
  readonly content: readonly MessageInputBlock[];
  readonly status: OrbMessageStatus;
  readonly delivery: "turn" | "steer" | null;
  readonly operationId: string | null;
  readonly deliveryBatchId: string | null;
  readonly autoStart: boolean;
  /**
   * The orb `state_version` this wake intent was admitted against, or null
   * when the message carries no intent. A `failed` orb wakes only for an
   * intent naming its current version (docs/lifecycle.md).
   */
  readonly wakeStateVersion: number | null;
  readonly lastError: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface OrbDeletionRow {
  readonly orbId: string;
  readonly hostKind: string;
  readonly kind: "archive" | "delete";
  readonly requestedAt: number;
  readonly cleanupAfter: number;
  readonly historySealedAt: number | null;
  readonly sealedCursor: string | null;
  readonly sealedHeadId: string | null;
  readonly lastError: string | null;
  readonly updatedAt: number;
}

export interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly repositoryUrl: string;
  readonly state: ProjectState;
  readonly stateVersion: number;
  readonly deletionRequestedAt: number | null;
  readonly deletionInitialOrbCount: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ProjectDeletionProgress {
  readonly total: number;
  readonly remaining: number;
  readonly blocked: number;
}

/** True when the orb has never reached runtime-ready (docs/lifecycle.md drain skip). */
export function hasNeverBeenReady(orb: OrbRow): boolean {
  return orb.checkoutCommit === null && orb.harnessSessionId === null;
}
