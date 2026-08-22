import {
  DEFAULT_TTL_SECONDS,
  MAX_AUDIENCE_BYTES,
  MAX_TTL_SECONDS,
  MIN_TTL_SECONDS,
} from "@pi-orb/protocol";

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
   * How long the create/start deadline is held off while the runtime keeps
   * reporting `setup_running` (docs/orb-setup-hook.md). It bounds the hold to
   * the runtime's own 20-minute setup deadline plus room to kill the hook and
   * finish booting — past that a runtime still claiming setup is stuck, and a
   * runtime that stops reporting drops the hold on its next probe.
   */
  readonly setupHookHoldMs: number;
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

/**
 * Identity-issuer bounds (docs/workload-identity.md). The three lifetime
 * numbers and the audience cap are the protocol's, re-exported here so the
 * domain has one constants object to inject and simulations can tighten the
 * rate-limit floor without touching the wire contract.
 */
export interface IssuerConstants {
  /** Applied when the caller requests no explicit lifetime. */
  readonly defaultTtlSeconds: number;
  readonly minTtlSeconds: number;
  readonly maxTtlSeconds: number;
  /** UTF-8 bytes, not characters: the audience is user-chosen text. */
  readonly maxAudienceBytes: number;
  /** Durable per-orb floor between successful mints; the abuse backstop. */
  readonly minMintIntervalMs: number;
  /**
   * How long a retired key keeps being published in JWKS. It must cover the
   * longest token that key could have signed plus the time a verifier may
   * serve a stale cached JWKS and a skewed clock — otherwise a token still
   * inside its own lifetime meets a key set that no longer explains it
   * (docs/workload-identity.md, "Issuer and signing requirements").
   */
  readonly jwksOverlapMs: number;
  /**
   * How long a signer may keep reusing private key material it has already
   * read. The active *row* is read per signature, so a rotation takes effect
   * immediately; this bounds the other revocation the row cannot express —
   * destroying the secret version under a still-active key, which is how an
   * operator kills a leaked key without waiting for a rotation to converge.
   * A warm signer would otherwise keep signing with destroyed material
   * indefinitely, so this is the revocation window for that case.
   */
  readonly signingKeyMaterialTtlMs: number;
  /**
   * How long a newly published key must sit in JWKS before it may start
   * signing. It has to exceed the `max-age` the JWKS endpoint serves
   * (`http/issuer-routes.ts`, five minutes), so that a verifier which fetched
   * the key set the instant before publication has refreshed before the first
   * token it cannot otherwise explain arrives. The emergency rotation of a
   * leaked key overrides it deliberately: a few rejected tokens beat a key
   * that keeps signing.
   */
  readonly rotationSoakMs: number;
}

export const DEFAULT_ISSUER_CONSTANTS: IssuerConstants = {
  defaultTtlSeconds: DEFAULT_TTL_SECONDS,
  minTtlSeconds: MIN_TTL_SECONDS,
  maxTtlSeconds: MAX_TTL_SECONDS,
  maxAudienceBytes: MAX_AUDIENCE_BYTES,
  minMintIntervalMs: 2_000,
  // The maximum token lifetime plus five minutes of verifier cache and clock
  // skew, which is the allowance the federation recipes ask relying parties for.
  jwksOverlapMs: MAX_TTL_SECONDS * 1_000 + 5 * 60_000,
  signingKeyMaterialTtlMs: 60_000,
  // Twice the JWKS `max-age`, so even a verifier that fetched the key set one
  // instant before the new key was published has re-fetched before it signs.
  rotationSoakMs: 10 * 60_000,
};

export const DEFAULT_LIFECYCLE_CONSTANTS: LifecycleConstants = {
  readinessPollMs: 5_000,
  unreachableGraceMs: 30_000,
  postRestartGraceMs: 3 * 60_000,
  createStartDeadlineMs: 15 * 60_000,
  setupHookHoldMs: 22 * 60_000,
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
