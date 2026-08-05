import type { SimulationTask } from "determined";
import { ok, type Result, ResultAsync } from "neverthrow";
import type { AuthGateError } from "./errors.ts";
import type { AuthGate, AuthResolution } from "./ports.ts";

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
