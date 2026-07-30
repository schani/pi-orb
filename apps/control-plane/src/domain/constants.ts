/**
 * Lifecycle timing constants (DESIGN.md §3.4/§5.2). All time flows through the
 * injected `SimulationTask` clock, so simulations tune these freely.
 */
export interface LifecycleConstants {
  /** Readiness health poll interval during create/start. */
  readonly readinessPollMs: number;
  /** Grace period before an unreachable runtime triggers a host restart. */
  readonly unreachableGraceMs: number;
  /** Deadline for `creating`/`starting`, measured from `state_changed_at`. */
  readonly createStartDeadlineMs: number;
  /**
   * Sub-deadline: the runtime health server starts before slow init, so a
   * host observed running whose runtime has never answered for this long is
   * a boot failure, not a slow clone (DESIGN.md §5.2).
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
}

/** Credential-broker timing constants (DESIGN.md §15.1). */
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
};
