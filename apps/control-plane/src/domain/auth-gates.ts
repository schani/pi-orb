import type { SimulationTask } from "determined";
import { ok, type Result, ResultAsync } from "neverthrow";
import type { AuthGateError } from "./errors.ts";
import type { AuthGate, AuthResolution } from "./ports.ts";

/**
 * Process-local singleflight boundary for the global login ceremony. Concurrent
 * orb reconciliation is per-orb, but auth state and its displayed challenge are
 * intentionally fleet-global (docs/credentials.md).
 */
export class SerializedAuthGate implements AuthGate {
  private readonly gate: AuthGate;
  private inFlight: Promise<Result<AuthResolution, AuthGateError>> | null = null;

  constructor(gate: AuthGate) {
    this.gate = gate;
  }

  ensureAuth(task: SimulationTask): ResultAsync<AuthResolution, AuthGateError> {
    const active = this.inFlight;
    if (active !== null) return new ResultAsync(active);

    const run = async (): Promise<Result<AuthResolution, AuthGateError>> =>
      await this.gate.ensureAuth(task);
    const operation = Promise.resolve(
      ResultAsync.fromPromise(
        run(),
        (error): AuthGateError => ({
          type: "auth_gate_error",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        }),
      ).andThen((result) => result),
    );
    this.inFlight = operation;
    void operation.then(() => {
      if (this.inFlight === operation) this.inFlight = null;
    });
    return new ResultAsync(operation);
  }
}

/**
 * Chains auth gates in order (docs/credentials.md): the first non-ok resolution
 * wins, so a later ceremony (GitHub) never starts while an earlier one
 * (Codex) still blocks — the user sees one device challenge at a time.
 */
export class CompositeAuthGate implements AuthGate {
  private readonly gates: readonly AuthGate[];

  constructor(gates: readonly AuthGate[]) {
    this.gates = gates;
  }

  ensureAuth(task: SimulationTask): ResultAsync<AuthResolution, AuthGateError> {
    const run = async (): Promise<Result<AuthResolution, AuthGateError>> => {
      for (const gate of this.gates) {
        const resolution = await gate.ensureAuth(task);
        if (resolution.isErr() || resolution.value.status !== "ok") return resolution;
      }
      return ok({ status: "ok" });
    };
    return new ResultAsync(run());
  }
}
