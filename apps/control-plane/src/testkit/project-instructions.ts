import type { ProjectInstructions } from "@pi-orb/protocol";
import { ApplicationFailure, type SimulationTask } from "determined";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import type {
  ProjectInstructionsError,
  ProjectInstructionsStore,
} from "../domain/project-instructions.ts";

/** The commit callback is the simulation's atomic project-row transaction. */
export class FakeProjectInstructionsStore implements ProjectInstructionsStore {
  readonly snapshots = new Map<string, ProjectInstructions>();
  readonly commits: { projectId: string; snapshot: ProjectInstructions }[] = [];
  private readonly state: (id: string) => "active" | "deleting" | null;
  constructor(state: (id: string) => "active" | "deleting" | null) {
    this.state = state;
  }

  read(task: SimulationTask, projectId: string) {
    return this.operation(task, "read", projectId);
  }
  replace(task: SimulationTask, projectId: string, content: string) {
    return this.operation(task, "write", projectId, content);
  }
  private operation(task: SimulationTask, name: string, projectId: string, content?: string) {
    return ResultAsync.fromPromise(
      (async (): Promise<Result<ProjectInstructions, ProjectInstructionsError>> => {
        await task.sleep(1 + task.random("instructions latency") * 5, name);
        await task.failpoint(`project-instructions.${name}.before`);
        const state = this.state(projectId);
        if (state !== "active")
          return err({
            type: "project_instructions_error",
            code: state === null ? "not_found" : "conflict",
            message: state === null ? "Project doesn't exist" : "Project is deleting",
          });
        const current = this.snapshots.get(projectId) ?? { content: "", revision: 0 };
        const snapshot =
          content === undefined ? { ...current } : { content, revision: current.revision + 1 };
        if (content !== undefined) {
          this.snapshots.set(projectId, snapshot);
          this.commits.push({ projectId, snapshot });
        }
        await task.sleep(1 + task.random("instructions reply latency") * 5, `${name} reply`);
        await task.failpoint(`project-instructions.${name}.after`);
        return ok({ ...snapshot });
      })(),
      (error) =>
        error instanceof ApplicationFailure
          ? {
              type: "project_instructions_error" as const,
              code: "unavailable" as const,
              message: "Project instructions unavailable",
            }
          : task.abortSimulation(error),
    ).andThen((result) => result);
  }
}
