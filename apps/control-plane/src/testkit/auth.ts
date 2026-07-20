import { ApplicationFailure, type SimulationTask } from "determined";
import { ResultAsync } from "neverthrow";
import type { AuthGateError } from "../domain/errors.ts";
import type { AuthGate, AuthResolution, DeviceChallenge } from "../domain/ports.ts";

export type FakeAuthMode =
  | { kind: "always_ok" }
  | {
      kind: "requires_login";
      /** Login auto-completes this long after the flow starts; null = only manual completion. */
      autoCompleteAfterMs: number | null;
      challengeTtlMs: number;
      /** When true the flow fails/expires instead of completing. */
      failFlow?: boolean;
    };

/**
 * Fake Codex auth gate. Enforces the single-global-device-flow rule and lets
 * tests observe how many flows ever started.
 */
export class FakeAuthGate implements AuthGate {
  private state: "ok" | "unauthenticated" | "failed" = "ok";
  private flow: { challenge: DeviceChallenge; startedAtMonotonic: number } | null = null;
  flowStartCount = 0;

  private readonly mode: FakeAuthMode;

  constructor(mode: FakeAuthMode) {
    this.mode = mode;
    this.state = mode.kind === "always_ok" ? "ok" : "unauthenticated";
  }

  /** Manually complete the pending login (test driver). */
  completeLogin(): void {
    this.flow = null;
    this.state = "ok";
  }

  /** Drop the credential so the next ensureAuth needs a fresh flow. */
  invalidateCredential(): void {
    this.state = "unauthenticated";
  }

  /** Simulate a control-plane restart: in-memory flow state is lost. */
  simulateProcessRestart(): void {
    this.flow = null;
  }

  ensureAuth(task: SimulationTask): ResultAsync<AuthResolution, AuthGateError> {
    const run = async (): Promise<AuthResolution> => {
      await task.sleep(1 + task.random("auth latency") * 10, "auth resolve");
      if (this.state === "ok") return { status: "ok" };
      if (this.mode.kind === "always_ok") return { status: "ok" };
      const mode = this.mode;
      const now = task.monotonicNow();
      if (this.flow !== null) {
        // Existing global flow: auto-complete, expire, or keep waiting.
        const elapsed = now - this.flow.startedAtMonotonic;
        if (mode.failFlow === true && elapsed >= mode.challengeTtlMs) {
          // The flow is gone; a later start request may initiate a new one.
          this.flow = null;
          this.state = "unauthenticated";
          return { status: "failed", message: "device login expired", retryable: true };
        }
        if (
          mode.failFlow !== true &&
          mode.autoCompleteAfterMs !== null &&
          elapsed >= mode.autoCompleteAfterMs
        ) {
          this.completeLogin();
          return { status: "ok" };
        }
        return { status: "pending", challenge: this.flow.challenge };
      }
      this.flowStartCount += 1;
      this.flow = {
        challenge: {
          verificationUri: "https://auth.example/device",
          userCode: `CODE-${this.flowStartCount}`,
          expiresAt: task.wallNow() + mode.challengeTtlMs,
        },
        startedAtMonotonic: now,
      };
      return { status: "pending", challenge: this.flow.challenge };
    };
    return ResultAsync.fromPromise(run(), (error) => {
      if (error instanceof ApplicationFailure) {
        return { type: "auth_gate_error", message: error.message, retryable: true } as const;
      }
      return task.abortSimulation(error);
    });
  }
}
