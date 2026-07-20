import type { DeviceChallenge } from "./ports.ts";

export interface LivenessEntry {
  /** Monotonic ms of the last successful pull (or seeded baseline). */
  lastSuccessAt: number;
  activity: "idle" | "busy";
  runtimeInstanceId: string | null;
}

export interface DrainStatus {
  retrying: boolean;
  message?: string;
}

/**
 * Per-process in-memory reconciliation state (DESIGN.md §11.3, §15.1). It is
 * deliberately reconstructible: a control-plane restart loses it and the
 * durable orb rows drive recovery.
 */
export class ControlState {
  private readonly liveness = new Map<string, LivenessEntry>();
  private readonly nextAttemptAt = new Map<string, number>();
  private readonly retryAttempts = new Map<string, number>();
  private readonly authBlocked = new Set<string>();
  private readonly drainStatus = new Map<string, DrainStatus>();
  private challenge: DeviceChallenge | null = null;
  private readonly stoppingOrbs = new Set<string>();

  // -- runtime liveness (successful pulls double as the liveness signal) --

  recordPullSuccess(
    orbId: string,
    at: number,
    activity: "idle" | "busy",
    runtimeInstanceId: string,
  ): void {
    this.liveness.set(orbId, { lastSuccessAt: at, activity, runtimeInstanceId });
  }

  /** Seed/reset the liveness baseline (orb became running, or host restarted). */
  resetLivenessBaseline(orbId: string, at: number): void {
    const existing = this.liveness.get(orbId);
    this.liveness.set(orbId, {
      lastSuccessAt: at,
      activity: existing?.activity ?? "idle",
      runtimeInstanceId: null,
    });
  }

  getLiveness(orbId: string): LivenessEntry | null {
    return this.liveness.get(orbId) ?? null;
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

  /** Drop all per-orb state after a terminal transition. */
  clearOrb(orbId: string): void {
    this.liveness.delete(orbId);
    this.nextAttemptAt.delete(orbId);
    this.retryAttempts.delete(orbId);
    this.authBlocked.delete(orbId);
    this.drainStatus.delete(orbId);
    this.stoppingOrbs.delete(orbId);
    this.restartPending.delete(orbId);
  }
}
