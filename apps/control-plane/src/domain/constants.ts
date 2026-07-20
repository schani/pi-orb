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

export const DEFAULT_LIFECYCLE_CONSTANTS: LifecycleConstants = {
  readinessPollMs: 5_000,
  unreachableGraceMs: 30_000,
  createStartDeadlineMs: 15 * 60_000,
  historyPullIntervalMs: 10_000,
  reconcileTickMs: 1_000,
  retryBackoffBaseMs: 500,
  retryBackoffCapMs: 10_000,
  runtimeRequestTimeoutMs: 10_000,
  providerOperationTimeoutMs: 60_000,
  pullLimit: 100,
  hostBackstopIntervalMs: 30_000,
};
