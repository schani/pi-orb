import type { HarnessKind } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { ok, type Result, ResultAsync } from "neverthrow";
import type { AuthGateError } from "./errors.ts";
import type { AuthGate, AuthResolution } from "./ports.ts";

/**
 * Singleflight per owner and selected harness. Provider gates own their shared
 * login ceremonies (docs/credentials.md).
 */
export class SerializedAuthGate implements AuthGate {
  private readonly gate: AuthGate;
  private readonly inFlight = new Map<string, Promise<Result<AuthResolution, AuthGateError>>>();

  constructor(gate: AuthGate) {
    this.gate = gate;
  }

  ensureAuth(
    task: SimulationTask,
    userId: string,
    harness?: HarnessKind,
  ): ResultAsync<AuthResolution, AuthGateError> {
    const key = `${userId}:${harness ?? "pi"}`;
    const active = this.inFlight.get(key);
    if (active !== undefined) return new ResultAsync(active);

    const run = async (): Promise<Result<AuthResolution, AuthGateError>> =>
      await this.gate.ensureAuth(task, userId, harness);
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
    this.inFlight.set(key, operation);
    void operation.then(() => {
      if (this.inFlight.get(key) === operation) this.inFlight.delete(key);
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

  ensureAuth(
    task: SimulationTask,
    userId: string,
    harness?: HarnessKind,
  ): ResultAsync<AuthResolution, AuthGateError> {
    const run = async (): Promise<Result<AuthResolution, AuthGateError>> => {
      for (const gate of this.gates) {
        const resolution = await gate.ensureAuth(task, userId, harness);
        if (resolution.isErr() || resolution.value.status !== "ok") return resolution;
      }
      return ok({ status: "ok" });
    };
    return new ResultAsync(run());
  }
}
