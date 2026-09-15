import type { ActiveSubagent } from "@pi-orb/protocol";
import { err, ok, type Result } from "neverthrow";

export interface SubagentError {
  readonly type: "subagent_admission_rejected" | "subagent_adapter_error";
  readonly message: string;
}

/** Identity of one admitted execution, not the extension's mutable status record. */
export interface SubagentRun {
  readonly childId: string;
  readonly operationId: string;
}

interface OwnedRun {
  readonly token: SubagentRun;
  active: boolean;
  cancelled: boolean;
  description: string;
  phase: ActiveSubagent["phase"];
}

/**
 * Synchronous admission/drain ownership. Scheduling lives at the caller's SDK,
 * persistence and notification boundaries; no clocks, polling or grace periods.
 * Keep the last run's correlation after drain for withheld wake decisions.
 */
export class SubagentWork {
  private readonly runs = new Map<string, OwnedRun>();

  get busy(): boolean {
    return [...this.runs.values()].some((run) => run.active);
  }

  get active(): readonly SubagentRun[] {
    return [...this.runs.values()].filter((run) => run.active).map((run) => run.token);
  }

  get view(): readonly ActiveSubagent[] {
    return [...this.runs.values()]
      .filter((run) => run.active)
      .map((run) => ({ id: run.token.childId, description: run.description, phase: run.phase }));
  }

  start(token: SubagentRun): boolean {
    const run = this.runs.get(token.childId);
    if (run?.token !== token || !run.active || run.cancelled || run.phase === "running")
      return false;
    run.phase = "running";
    return true;
  }

  admit(
    childId: string,
    operationId: string,
    description = childId,
  ): Result<SubagentRun, { type: "ownership_conflict" }> {
    const existing = this.runs.get(childId);
    if (existing?.active) {
      return existing.token.operationId === operationId
        ? ok(existing.token)
        : err({ type: "ownership_conflict" });
    }
    const token = { childId, operationId };
    this.runs.set(childId, { token, active: true, cancelled: false, description, phase: "queued" });
    return ok(token);
  }

  correlation(childId: string): SubagentRun | undefined {
    return this.runs.get(childId)?.token;
  }

  release(token: SubagentRun): boolean {
    const run = this.runs.get(token.childId);
    if (run?.token !== token || !run.active) return false;
    run.active = false;
    return true;
  }

  cancel(operationId: string): void {
    for (const run of this.runs.values()) {
      if (run.token.operationId === operationId) {
        run.cancelled = true;
        if (run.active) run.phase = "finishing";
      }
    }
  }

  mayWake(childId: string, operationId: string | null): boolean {
    const run = this.runs.get(childId);
    return run !== undefined && run.token.operationId === operationId && !run.cancelled;
  }
}
