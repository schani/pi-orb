/**
 * Lifecycle timing constants (docs/lifecycle.md/docs/lifecycle.md). All time flows through the
 * injected `SimulationTask` clock, so simulations tune these freely.
 */
export interface LifecycleConstants {
  /** Readiness health poll interval during create/start. */
  readonly readinessPollMs: number;
  /** Grace period before an unreachable runtime triggers a host restart. */
  readonly unreachableGraceMs: number;
  /**
   * Grace granted to a liveness baseline seeded by a host restart. A restarted
   * host must boot before anything can answer, so this has to exceed a full
   * boot (~60–70s on GCE) with margin; anything shorter concludes "unreachable"
   * against a booting host and livelocks
   * (docs/postmortems/2026-08-05-unreachable-restart-livelock.md).
   */
  readonly postRestartGraceMs: number;
  /** Deadline for `creating`/`starting`, measured from `state_changed_at`. */
  readonly createStartDeadlineMs: number;
  /**
   * Sub-deadline: the runtime health server starts before slow init, so a
   * host observed running whose runtime has never answered for this long is
   * a boot failure, not a slow clone (docs/lifecycle.md).
   */
  readonly unreachableBootDeadlineMs: number;
  /** Approximate history-pull interval per active orb. */
  readonly historyPullIntervalMs: number;
  /** Reconciler wake-up tick. */
  readonly reconcileTickMs: number;
  /** Exponential retry backoff for retryable provider/network failures. */
  readonly retryBackoffBaseMs: number;
  readonly retryBackoffCapMs: number;
  /** Deadline for a single runtime HTTP request (health or pull). */
  readonly runtimeRequestTimeoutMs: number;
  /** Deadline for a single provider operation. */
  readonly providerOperationTimeoutMs: number;
  /** Page size for history pulls. */
  readonly pullLimit: number;
  /** How often stopped/failed orbs are checked for stray running hosts. */
  readonly hostBackstopIntervalMs: number;
  /** Idle duration after which a running orb is automatically stopped (docs/lifecycle.md). */
  readonly idleStopAfterMs: number;
  /** Interval between orphan-host sweeps (docs/lifecycle.md). */
  readonly orphanSweepIntervalMs: number;
  /** Race-fencing window before deletion can remove its durable row. */
  readonly deletionQuarantineMs: number;
}

/** Credential-broker timing constants (docs/credentials.md). */
export interface BrokerConstants {
  /** Refresh proactively when remaining credential lifetime falls below this. */
  readonly refreshThresholdMs: number;
  /** Global floor between upstream refreshes unless the token is expired. */
  readonly minRefreshIntervalMs: number;
  /** Refresh-coalescing lease duration; must exceed the upstream deadline. */
  readonly leaseMs: number;
  /** Deadline for one upstream refresh call. */
  readonly upstreamTimeoutMs: number;
  /** Poll interval while waiting on another instance's lease. */
  readonly waiterPollMs: number;
  /** Overall deadline for one token request. */
  readonly requestDeadlineMs: number;
}

export const DEFAULT_BROKER_CONSTANTS: BrokerConstants = {
  refreshThresholdMs: 5 * 60_000,
  minRefreshIntervalMs: 30_000,
  leaseMs: 30_000,
  upstreamTimeoutMs: 20_000,
  waiterPollMs: 500,
  requestDeadlineMs: 45_000,
};

export const DEFAULT_LIFECYCLE_CONSTANTS: LifecycleConstants = {
  readinessPollMs: 5_000,
  unreachableGraceMs: 30_000,
  postRestartGraceMs: 3 * 60_000,
  createStartDeadlineMs: 15 * 60_000,
  unreachableBootDeadlineMs: 3 * 60_000,
  historyPullIntervalMs: 10_000,
  reconcileTickMs: 1_000,
  retryBackoffBaseMs: 500,
  retryBackoffCapMs: 10_000,
  runtimeRequestTimeoutMs: 10_000,
  providerOperationTimeoutMs: 60_000,
  pullLimit: 100,
  hostBackstopIntervalMs: 30_000,
  idleStopAfterMs: 15 * 60_000,
  orphanSweepIntervalMs: 5 * 60_000,
  // Exceeds the 60-second bound on one provider operation.
  deletionQuarantineMs: 65_000,
};
