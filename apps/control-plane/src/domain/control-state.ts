import type { DeviceChallenge } from "./ports.ts";

export interface LivenessEntry {
  /** Monotonic ms of the last successful pull (or seeded baseline). */
  lastSuccessAt: number;
  activity: "idle" | "busy";
  runtimeInstanceId: string | null;
  /**
   * Non-null only while the baseline rests on a host restart rather than on a
   * pull: the entitled grace must then outlast a boot, and a second expiry
   * with no pull success in between is evidence the restart did not help
   * (docs/lifecycle.md).
   */
  restartGraceMs: number | null;
}

export interface DrainStatus {
  retrying: boolean;
  message?: string;
}

/** Live picture of a boot in progress (creating/starting). */
export interface BootProbe {
  hostState: string | null;
  hostRunningSinceWall: number | null;
  hostRunningSinceMono: number | null;
  attempts: number;
  /** Whether the runtime has answered health at all this boot. */
  everAnswered: boolean;
  /**
   * Monotonic ms of the first health report of this boot that said the
   * repository's setup hook is running (docs/orb-setup-hook.md), or null if
   * none did. It anchors the deadline hold and is deliberately sticky for the
   * episode: the hold has to cover the hook *and* the boot that follows it,
   * and its own bound — not the next probe — is what ends it, so a runtime
   * that stops reporting is still a dead runtime, just on a longer clock.
   */
  setupRunningSinceMono: number | null;
  /** Wall companion of the above, for the user-visible "running setup" detail. */
  setupRunningSinceWall: number | null;
  /** Whether the *latest* answered probe still said setup is running. */
  setupRunning: boolean;
  /** Whether the most recent probe got any answer at all. */
  lastProbeAnswered: boolean;
  /** Monotonic ms of the most recent answered probe; null before the first. */
  lastAnswerMono: number | null;
  lastError?: string;
}

/**
 * When this boot's setup hook started, in both clocks. An anchor already held
 * wins; otherwise a live `setup_running` answer anchors at now, and a finished
 * hook anchors at the start time the runtime persisted — the only evidence
 * that survives a control-plane restart.
 */
function resolveSetupAnchor(
  existing: BootProbe | undefined,
  outcome: {
    readonly setupRunning?: boolean;
    readonly setupStartedAtWall?: number;
    readonly nowMono?: number;
    readonly nowWall?: number;
  },
): { readonly mono: number | null; readonly wall: number | null } {
  if (existing?.setupRunningSinceMono != null) {
    return { mono: existing.setupRunningSinceMono, wall: existing.setupRunningSinceWall };
  }
  const { nowMono, nowWall } = outcome;
  if (nowMono === undefined || nowWall === undefined) return { mono: null, wall: null };
  if (outcome.setupRunning === true) return { mono: nowMono, wall: nowWall };
  const startedAt = outcome.setupStartedAtWall;
  if (startedAt === undefined) return { mono: null, wall: null };
  return { mono: nowMono - Math.max(0, nowWall - startedAt), wall: startedAt };
}

/**
 * Per-process in-memory reconciliation state (docs/control-plane-api.md, docs/credentials.md). It is
 * deliberately reconstructible: a control-plane restart loses it and the
 * durable orb rows drive recovery.
 */
export class ControlState {
  private readonly liveness = new Map<string, LivenessEntry>();
  /** orbId → `state_changed_at` of the episode this process's memory describes. */
  private readonly episodes = new Map<string, number>();
  private readonly nextAttemptAt = new Map<string, number>();
  private readonly retryAttempts = new Map<string, number>();
  private readonly authBlocked = new Set<string>();
  private readonly drainStatus = new Map<string, DrainStatus>();
  private challenge: DeviceChallenge | null = null;
  private readonly stoppingOrbs = new Set<string>();

  /**
   * Drop everything this process remembers about a *previous* visit to a
   * state, keyed by the orb row's durable `state_changed_at`.
   *
   * The boot probe, the drain status, a half-finished restart and the liveness
   * baseline with the grace it was granted all describe one episode: this
   * boot, this drain. A reconciler that did not make the transition itself
   * never clears them — and during a deploy there is always such a reconciler
   * (docs/testing.md: version skew is part of the model). Carrying that memory
   * into the next episode makes it act on an expired clock: a boot window from
   * the previous start fails the next one as `runtime_never_answered`, and a
   * restart grace from the previous drain fails the next one as
   * `drain_runtime_unrecoverable`. Both were found by
   * `mixed-generation.dst.test.ts`. Deriving the window from the row instead
   * of from an observed transition makes it hold for every reconciler.
   *
   * Forgetting is always safe: it is exactly the state a control-plane restart
   * loses, and every path reseeds it from the row on the next pass.
   */
  noteStateEpisode(orbId: string, stateChangedAt: number): void {
    if (this.episodes.get(orbId) === stateChangedAt) return;
    this.episodes.set(orbId, stateChangedAt);
    this.bootProbes.delete(orbId);
    this.bootEvidenceSince.delete(orbId);
    this.drainStatus.delete(orbId);
    this.restartPending.delete(orbId);
    this.liveness.delete(orbId);
  }

  // -- runtime liveness (successful pulls double as the liveness signal) --

  recordPullSuccess(
    orbId: string,
    at: number,
    activity: "idle" | "busy",
    runtimeInstanceId: string,
  ): void {
    this.liveness.set(orbId, {
      lastSuccessAt: at,
      activity,
      runtimeInstanceId,
      restartGraceMs: null,
    });
  }

  /**
   * The runtime answered a non-pull control-plane request — currently an inbox
   * delivery. That is the same evidence a successful pull carries, so it
   * refreshes the baseline: the reconciler must never declare a runtime
   * unreachable in the same second it is demonstrably serving us
   * (docs/lifecycle.md). Only an existing entry is refreshed; the baseline is
   * seeded by entering `running`, by a restart, or by a pull.
   */
  noteRuntimeAnswered(orbId: string, at: number): void {
    const existing = this.liveness.get(orbId);
    if (existing === undefined) return;
    this.liveness.set(orbId, { ...existing, lastSuccessAt: at, restartGraceMs: null });
  }

  /**
   * Seed/reset the liveness baseline (orb became running, or host restarted).
   * `restartGraceMs` is passed only by a restart, which must outlast a boot.
   */
  resetLivenessBaseline(orbId: string, at: number, restartGraceMs: number | null = null): void {
    const existing = this.liveness.get(orbId);
    this.liveness.set(orbId, {
      lastSuccessAt: at,
      activity: existing?.activity ?? "idle",
      runtimeInstanceId: null,
      restartGraceMs,
    });
  }

  getLiveness(orbId: string): LivenessEntry | null {
    return this.liveness.get(orbId) ?? null;
  }

  // -- browser presence (idle auto-stop, docs/lifecycle.md) --

  /** orbId → connectionId → tab visible. */
  private readonly browserVisibility = new Map<string, Map<string, boolean>>();
  private readonly browserClosers = new Map<string, Map<string, () => void>>();
  /** Wall ms when the orb last had a visible tab; lost on process restart. */
  private readonly lastVisibleAt = new Map<string, number>();

  /** A connection counts as hidden until it affirmatively reports visible. */
  registerBrowserConnection(orbId: string, connectionId: string, close?: () => void): void {
    let connections = this.browserVisibility.get(orbId);
    if (connections === undefined) {
      connections = new Map();
      this.browserVisibility.set(orbId, connections);
    }
    connections.set(connectionId, false);
    if (close !== undefined) {
      let closers = this.browserClosers.get(orbId);
      if (closers === undefined) {
        closers = new Map();
        this.browserClosers.set(orbId, closers);
      }
      closers.set(connectionId, close);
    }
  }

  closeBrowserConnections(orbId: string): void {
    const closers = this.browserClosers.get(orbId);
    if (closers === undefined) return;
    for (const close of closers.values()) close();
  }

  setBrowserVisibility(orbId: string, connectionId: string, visible: boolean, at: number): void {
    const connections = this.browserVisibility.get(orbId);
    if (connections === undefined || !connections.has(connectionId)) return;
    const wasVisible = connections.get(connectionId) === true;
    connections.set(connectionId, visible);
    // Both edges stamp the time: becoming visible marks activity now, and
    // hiding marks the end of a visible stretch so the idle countdown starts
    // from the hide, not from whenever the tab first appeared.
    if (visible || wasVisible) this.lastVisibleAt.set(orbId, at);
  }

  unregisterBrowserConnection(orbId: string, connectionId: string, at: number): void {
    const connections = this.browserVisibility.get(orbId);
    if (connections === undefined) return;
    if (connections.get(connectionId) === true) this.lastVisibleAt.set(orbId, at);
    connections.delete(connectionId);
    const closers = this.browserClosers.get(orbId);
    closers?.delete(connectionId);
    if (closers?.size === 0) this.browserClosers.delete(orbId);
    if (connections.size === 0) this.browserVisibility.delete(orbId);
  }

  hasVisibleBrowser(orbId: string): boolean {
    const connections = this.browserVisibility.get(orbId);
    if (connections === undefined) return false;
    for (const visible of connections.values()) {
      if (visible) return true;
    }
    return false;
  }

  getLastVisibleAt(orbId: string): number | null {
    return this.lastVisibleAt.get(orbId) ?? null;
  }

  // -- per-orb scheduling --

  setNextAttemptAt(orbId: string, at: number): void {
    this.nextAttemptAt.set(orbId, at);
  }

  getNextAttemptAt(orbId: string): number {
    return this.nextAttemptAt.get(orbId) ?? 0;
  }

  bumpRetryAttempts(orbId: string): number {
    const next = (this.retryAttempts.get(orbId) ?? 0) + 1;
    this.retryAttempts.set(orbId, next);
    return next;
  }

  clearRetryAttempts(orbId: string): void {
    this.retryAttempts.delete(orbId);
  }

  // -- OAuth device flow --

  markAuthBlocked(orbId: string): void {
    this.authBlocked.add(orbId);
  }

  isAuthBlocked(orbId: string): boolean {
    return this.authBlocked.has(orbId);
  }

  clearAuthBlocked(orbId: string): void {
    this.authBlocked.delete(orbId);
  }

  /** The cohort of orbs waiting on the current device flow. */
  getAuthBlockedOrbs(): string[] {
    return [...this.authBlocked];
  }

  setChallenge(challenge: DeviceChallenge | null): void {
    this.challenge = challenge;
  }

  getChallenge(): DeviceChallenge | null {
    return this.challenge;
  }

  // -- boot probing (creating/starting visibility, docs/lifecycle.md) --

  private readonly bootProbes = new Map<string, BootProbe>();

  /** Record one readiness-probe outcome while the orb boots. */
  recordBootProbe(
    orbId: string,
    outcome: {
      hostState: string | null;
      /** Wall ms when the host was first observed running (null resets). */
      hostRunningSinceWall: number | null;
      /** Monotonic ms companion for deadline math. */
      hostRunningSinceMono: number | null;
      answered: boolean;
      /** The answer reported the `setup_running` readiness phase. */
      setupRunning?: boolean;
      /**
       * Wall ms at which this incarnation's setup hook started, as the runtime
       * itself reports it once the hook has finished. It reseeds the anchor
       * after a control-plane restart, which is the one loss `noteStateEpisode`
       * cannot call safe: without it a restart lands on a boot whose ordinary
       * deadline the hook legitimately outlasted, and fails a healthy orb.
       */
      setupStartedAtWall?: number;
      /** Clocks of this probe; required to time and display a setup hold. */
      nowMono?: number;
      nowWall?: number;
      lastError?: string;
    },
  ): void {
    const existing = this.bootProbes.get(orbId);
    const keepSince =
      existing?.hostRunningSinceMono != null && outcome.hostRunningSinceMono != null;
    // Once set, the anchor stands for the episode: the hold has to cover the
    // hook *and* the boot that follows it, so a later phase must not retire it
    // and drop the orb straight past an already-expired ordinary deadline. The
    // display flag is a level, not an edge, and follows the latest answer.
    const anchor = resolveSetupAnchor(existing, outcome);
    this.bootProbes.set(orbId, {
      setupRunningSinceMono: anchor.mono,
      setupRunningSinceWall: anchor.wall,
      setupRunning: outcome.setupRunning ?? existing?.setupRunning ?? false,
      lastProbeAnswered: outcome.answered,
      lastAnswerMono: outcome.answered
        ? (outcome.nowMono ?? existing?.lastAnswerMono ?? null)
        : (existing?.lastAnswerMono ?? null),
      hostState: outcome.hostState,
      hostRunningSinceWall: keepSince
        ? existing.hostRunningSinceWall
        : outcome.hostRunningSinceWall,
      hostRunningSinceMono: keepSince
        ? existing.hostRunningSinceMono
        : outcome.hostRunningSinceMono,
      attempts: (existing?.attempts ?? 0) + 1,
      everAnswered: (existing?.everAnswered ?? false) || outcome.answered,
      ...(outcome.lastError !== undefined
        ? { lastError: outcome.lastError }
        : existing?.lastError !== undefined
          ? { lastError: existing.lastError }
          : {}),
    });
  }

  getBootProbe(orbId: string): BootProbe | null {
    return this.bootProbes.get(orbId) ?? null;
  }

  clearBootProbe(orbId: string): void {
    this.bootProbes.delete(orbId);
    this.bootEvidenceSince.delete(orbId);
  }

  private readonly bootEvidenceSince = new Map<string, number>();

  /**
   * Monotonic ms at which this process first reconciled a booting `orbId`,
   * recorded on the first call and returned unchanged afterwards. A process
   * that has just started holds no boot probe at all, and the boot deadline
   * must not be decided on that emptiness (docs/orb-setup-hook.md).
   */
  noteBootEvidenceStart(orbId: string, at: number): number {
    const existing = this.bootEvidenceSince.get(orbId);
    if (existing !== undefined) return existing;
    this.bootEvidenceSince.set(orbId, at);
    return at;
  }

  // -- host restart tracking --

  private readonly restartPending = new Set<string>();

  /**
   * Set between the stop and start halves of an unreachable-runtime host
   * restart, so a stopped host mid-restart is completed rather than being
   * mistaken for an externally stopped host. Lost on process restart, which
   * falls back to the accepted replication caveat.
   */
  markRestartPending(orbId: string): void {
    this.restartPending.add(orbId);
  }

  clearRestartPending(orbId: string): void {
    this.restartPending.delete(orbId);
  }

  isRestartPending(orbId: string): boolean {
    return this.restartPending.has(orbId);
  }

  // -- stopping / drain presentation --

  /** While set, the HTTP layer rejects new live connections for the orb. */
  markStopping(orbId: string): void {
    this.stoppingOrbs.add(orbId);
  }

  isStopping(orbId: string): boolean {
    return this.stoppingOrbs.has(orbId);
  }

  setDrainStatus(orbId: string, status: DrainStatus): void {
    this.drainStatus.set(orbId, status);
  }

  getDrainStatus(orbId: string): DrainStatus | null {
    return this.drainStatus.get(orbId) ?? null;
  }

  // -- edge detection for logging (docs/lifecycle.md noise rule) --

  private readonly activeConditions = new Set<string>();

  /**
   * Returns true only when `key`'s condition changes, so a condition that
   * persists across loop ticks (a store outage, say) is logged once when it
   * starts and once when it clears instead of once per tick.
   */
  noteCondition(key: string, active: boolean): boolean {
    const wasActive = this.activeConditions.has(key);
    if (active === wasActive) return false;
    if (active) this.activeConditions.add(key);
    else this.activeConditions.delete(key);
    return true;
  }

  /** Both scheduling maps are keyed `<loop>:<orbId>` by their callers. */
  private static forgetOrb(map: Map<string, number>, orbId: string): void {
    map.delete(orbId);
    for (const key of map.keys()) {
      if (key.endsWith(`:${orbId}`)) map.delete(key);
    }
  }

  /** Drop all per-orb state after a terminal transition. */
  clearOrb(orbId: string): void {
    this.bootProbes.delete(orbId);
    this.bootEvidenceSince.delete(orbId);
    this.episodes.delete(orbId);
    this.liveness.delete(orbId);
    ControlState.forgetOrb(this.nextAttemptAt, orbId);
    // Without this a stale attempt counter would survive a stop/start and
    // swallow the first-failure log line of the next episode.
    ControlState.forgetOrb(this.retryAttempts, orbId);
    this.authBlocked.delete(orbId);
    this.drainStatus.delete(orbId);
    this.stoppingOrbs.delete(orbId);
    this.restartPending.delete(orbId);
    this.browserVisibility.delete(orbId);
    this.browserClosers.delete(orbId);
    this.lastVisibleAt.delete(orbId);
  }
}
