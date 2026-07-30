import type { SimulationTask } from "determined";
import { err, ok, type Result } from "neverthrow";

/**
 * Runtime-side broker token client (DESIGN.md §15.1): fetches short-lived
 * access tokens from the control plane's `/runtime/v1/model-token`, with
 * singleflight, bounded retry windows, and typed terminal outcomes. Pure
 * domain logic — the HTTP transport sits behind `BrokerEndpoint`.
 */

export type TokenReason = "startup" | "expiring" | "rejected";

export interface TokenRequestBody {
  readonly reason: TokenReason;
  readonly staleGeneration?: number;
}

export interface BrokerTokenGrant {
  readonly accessToken: string;
  readonly accountId: string;
  /** Wall-clock ms. */
  readonly expiresAt: number;
  readonly generation: number;
}

export type BrokerEndpointResult =
  | { readonly kind: "grant"; readonly grant: BrokerTokenGrant }
  /** 409: the control plane has no usable credential; device login must run. */
  | { readonly kind: "auth_required" }
  /** 401: the orb token was not accepted. */
  | { readonly kind: "unauthorized" }
  /** 503/429/network: back off and retry. */
  | { readonly kind: "retryable"; readonly message: string; readonly retryAfterMs?: number }
  /** Anything else (e.g. 400): a bug, not a condition to retry. */
  | { readonly kind: "fatal"; readonly message: string };

export interface BrokerEndpoint {
  requestToken(task: SimulationTask, body: TokenRequestBody): Promise<BrokerEndpointResult>;
}

export interface BrokerClientConstants {
  /**
   * How long startup fetches tolerate 401s: the host can be running before
   * the control plane commits its token hash (DESIGN.md §15.1 read-back).
   */
  readonly bootRetryWindowMs: number;
  /** Retry window for non-startup fetches (503s, transient network). */
  readonly retryWindowMs: number;
  readonly backoffBaseMs: number;
  readonly backoffCapMs: number;
}

export const DEFAULT_BROKER_CLIENT_CONSTANTS: BrokerClientConstants = {
  bootRetryWindowMs: 60_000,
  retryWindowMs: 30_000,
  backoffBaseMs: 500,
  backoffCapMs: 5_000,
};

export type BrokerClientError =
  | { readonly type: "auth_required" }
  | { readonly type: "unauthorized" }
  | { readonly type: "unavailable"; readonly message: string }
  | { readonly type: "fatal"; readonly message: string };

interface Flight {
  settled: boolean;
  outcome: Result<BrokerTokenGrant, BrokerClientError> | null;
}

export class BrokerTokenClient {
  private readonly endpoint: BrokerEndpoint;
  private readonly constants: BrokerClientConstants;
  private lastGrant: BrokerTokenGrant | null = null;
  private flight: Flight | null = null;

  constructor(
    endpoint: BrokerEndpoint,
    constants: BrokerClientConstants = DEFAULT_BROKER_CLIENT_CONSTANTS,
  ) {
    this.endpoint = endpoint;
    this.constants = constants;
  }

  /** The most recently granted token, if any (in memory only). */
  currentGrant(): BrokerTokenGrant | null {
    return this.lastGrant;
  }

  /**
   * Fetch a token. Concurrent calls coalesce onto one in-flight request.
   * Waiters poll on their own timers instead of awaiting the owner's
   * promise: a task awaiting a promise settled by another task's timer
   * deadlocks the deterministic simulation (DESIGN.md §14).
   */
  async fetch(
    task: SimulationTask,
    reason: TokenReason,
  ): Promise<Result<BrokerTokenGrant, BrokerClientError>> {
    for (;;) {
      const running = this.flight;
      if (running === null) {
        const flight: Flight = { settled: false, outcome: null };
        this.flight = flight;
        const outcome = await this.run(task, reason);
        flight.outcome = outcome;
        flight.settled = true;
        this.flight = null;
        return outcome;
      }
      while (!running.settled) {
        await task.sleep(25, "await in-flight token fetch");
      }
      if (running.outcome !== null) return running.outcome;
    }
  }

  private async run(
    task: SimulationTask,
    reason: TokenReason,
  ): Promise<Result<BrokerTokenGrant, BrokerClientError>> {
    const windowMs =
      reason === "startup" ? this.constants.bootRetryWindowMs : this.constants.retryWindowMs;
    const deadline = task.monotonicNow() + windowMs;
    const staleGeneration = this.lastGrant?.generation;
    const body: TokenRequestBody = {
      reason,
      ...(staleGeneration !== undefined ? { staleGeneration } : {}),
    };

    let attempt = 0;
    for (;;) {
      const outcome = await this.endpoint.requestToken(task, body);
      switch (outcome.kind) {
        case "grant":
          this.lastGrant = outcome.grant;
          return ok(outcome.grant);
        case "auth_required":
          return err({ type: "auth_required" });
        case "fatal":
          return err({ type: "fatal", message: outcome.message });
        case "unauthorized":
          if (task.monotonicNow() >= deadline) return err({ type: "unauthorized" });
          break;
        case "retryable":
          if (task.monotonicNow() >= deadline) {
            return err({ type: "unavailable", message: outcome.message });
          }
          break;
      }
      attempt += 1;
      const backoff = Math.min(
        this.constants.backoffCapMs,
        this.constants.backoffBaseMs * 2 ** (attempt - 1),
      );
      const waitMs =
        outcome.kind === "retryable" && outcome.retryAfterMs !== undefined
          ? Math.max(outcome.retryAfterMs, backoff)
          : backoff;
      await task.sleep(waitMs, "broker client backoff");
    }
  }
}
