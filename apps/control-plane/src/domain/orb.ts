import type { HarnessSessionMetadata, OrbState, StopReason } from "@pi-orb/protocol";

/**
 * Domain view of an orb row (DESIGN.md §8.6). Timestamps are wall-clock
 * milliseconds; adapters convert to/from `timestamptz`.
 */
export interface OrbRow {
  readonly id: string;
  readonly projectId: string;
  readonly state: OrbState;
  readonly stateVersion: number;
  readonly hostKind: string;
  readonly hostRef: string | null;
  /** Persisted when the runtime first reports ready; doubles as the "has ever been ready" marker. */
  readonly checkoutCommit: string | null;
  readonly harnessSessionId: string | null;
  readonly harnessSessionHeader: HarnessSessionMetadata | null;
  readonly lastError: string | null;
  /**
   * SHA-256 of the per-host-incarnation runtime token (DESIGN.md §15.1);
   * follows what the provisioned host actually carries. Never the plaintext.
   */
  readonly runtimeTokenHash: string | null;
  readonly replicationCursor: string | null;
  readonly replicatedHeadId: string | null;
  /**
   * Restart-stable activity timestamp for idle auto-stop (DESIGN.md §3.4).
   * Advisory and monotone: written outside the state_version CAS.
   */
  readonly lastBusyAt: number | null;
  /** Why the orb last entered `stopping`; null for explicit stops. */
  readonly stopReason: StopReason | null;
  readonly stateChangedAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly repositoryUrl: string;
  readonly createdAt: number;
}

/** True when the orb has never reached runtime-ready (DESIGN.md §5.2 drain skip). */
export function hasNeverBeenReady(orb: OrbRow): boolean {
  return orb.checkoutCommit === null && orb.harnessSessionId === null;
}
