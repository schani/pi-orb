import type { SimulationTask } from "determined";
import { err, ok, type Result } from "neverthrow";

/**
 * Runtime-side broker token client (docs/credentials.md): fetches short-lived
 * access tokens from the control plane's `/runtime/v1/tokens/{name}`, with
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
  /** Model grants carry the account id; GitHub grants carry the user login. */
  readonly accountId?: string;
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
  | { readonly kind: "cancelled" }
  /** 503/429/network: back off and retry. */
  | { readonly kind: "retryable"; readonly message: string; readonly retryAfterMs?: number }
  /** Anything else (e.g. 400): a bug, not a condition to retry. */
  | { readonly kind: "fatal"; readonly message: string };

export interface BrokerEndpoint {
  /** Honor cancellation through body consumption; settle only after owned I/O drains. */
  requestToken(
    task: SimulationTask,
    body: TokenRequestBody,
    signal?: AbortSignal,
  ): Promise<BrokerEndpointResult>;
}

export interface BrokerClientConstants {
  /**
   * How long startup fetches tolerate 401s: the host can be running before
   * the control plane commits its token hash (docs/credentials.md read-back).
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
  | { readonly type: "cancelled" }
  | { readonly type: "unauthorized" }
  | { readonly type: "unavailable"; readonly message: string }
  | { readonly type: "fatal"; readonly message: string };

export class BrokerTokenClient {
  private readonly endpoint: BrokerEndpoint;
  private readonly constants: BrokerClientConstants;
  private lastGrant: BrokerTokenGrant | null = null;
  private inFlight: {
    controller: AbortController;
    waiters: number;
    promise: Promise<Result<BrokerTokenGrant, BrokerClientError>>;
  } | null = null;

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
   * Fetch a token. Concurrent calls share one in-flight request — sharing a
   * promise across simulation tasks requires `determined` >= 0.4.1
   * (docs/DETERMINED-BUG.md).
   */
  fetch(
    task: SimulationTask,
    reason: TokenReason,
    signal?: AbortSignal,
  ): Promise<Result<BrokerTokenGrant, BrokerClientError>> {
    if (signal?.aborted) return Promise.resolve(err({ type: "cancelled" }));
    let flight = this.inFlight;
    if (flight?.controller.signal.aborted) {
      // A new owner must not inherit an abandoned flight's cancellation.
      return flight.promise.then(() => this.fetch(task, reason, signal));
    }
    if (flight === null) {
      const controller = new AbortController();
      flight = { controller, waiters: 0, promise: this.run(task, reason, controller.signal) };
      this.inFlight = flight;
      const owned = flight;
      flight.promise = flight.promise.finally(() => {
        if (this.inFlight === owned) this.inFlight = null;
      });
    }
    const owned = flight;
    owned.waiters++;
    return new Promise((resolve) => {
      let finished = false;
      const finish = (): boolean => {
        if (finished) return false;
        finished = true;
        signal?.removeEventListener("abort", cancel);
        owned.waiters--;
        return true;
      };
      const cancel = (): void => {
        if (!finish()) return;
        const cancelled = err<BrokerTokenGrant, BrokerClientError>({ type: "cancelled" });
        if (owned.waiters === 0) {
          owned.controller.abort();
          // The final owner waits for I/O cleanup before releasing SDK credential locks.
          void owned.promise.then(() => resolve(cancelled));
        } else resolve(cancelled);
      };
      signal?.addEventListener("abort", cancel, { once: true });
      void owned.promise.then((outcome) => {
        if (finish()) resolve(outcome);
      });
      if (signal?.aborted) cancel();
    });
  }

  private async run(
    task: SimulationTask,
    reason: TokenReason,
    cancellation: AbortSignal,
  ): Promise<Result<BrokerTokenGrant, BrokerClientError>> {
    const windowMs =
      reason === "startup" ? this.constants.bootRetryWindowMs : this.constants.retryWindowMs;
    const deadline = task.monotonicNow() + windowMs;
    const staleGeneration = this.lastGrant?.generation;
    const body: TokenRequestBody = {
      reason,
      ...(staleGeneration !== undefined ? { staleGeneration } : {}),
    };

    const budget = task.createDeadline(windowMs, "broker token retry budget");
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    cancellation.addEventListener("abort", abort, { once: true });
    budget.signal.addEventListener("abort", abort, { once: true });
    if (cancellation.aborted || budget.signal.aborted) abort();
    const signal = controller.signal;
    let lastUnauthorized = false;
    const stopped = (): Result<BrokerTokenGrant, BrokerClientError> =>
      cancellation.aborted
        ? err({ type: "cancelled" })
        : lastUnauthorized
          ? err({ type: "unauthorized" })
          : err({ type: "unavailable", message: "broker token retry budget exhausted" });
    let attempt = 0;
    try {
      for (;;) {
        if (signal.aborted || task.monotonicNow() >= deadline) return stopped();
        await task.checkpoint("broker token request", reason, attempt);
        if (signal.aborted || task.monotonicNow() >= deadline) return stopped();
        const outcome = await this.endpoint.requestToken(task, body, signal);
        if (signal.aborted || task.monotonicNow() >= deadline) return stopped();
        lastUnauthorized = outcome.kind === "unauthorized";
        switch (outcome.kind) {
          case "grant":
            this.lastGrant = outcome.grant;
            return ok(outcome.grant);
          case "auth_required":
            return err({ type: "auth_required" });
          case "cancelled":
            return err({ type: "cancelled" });
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
        const slept = await task
          .sleep(
            Math.min(waitMs, Math.max(0, deadline - task.monotonicNow())),
            "broker client backoff",
            { signal },
          )
          .then(
            () => true,
            () => false,
          );
        if (!slept) return stopped();
      }
    } finally {
      cancellation.removeEventListener("abort", abort);
      budget.signal.removeEventListener("abort", abort);
      budget.cancel();
    }
  }
}
