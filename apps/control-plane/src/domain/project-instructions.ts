import { type ProjectInstructions, validateProjectInstructions } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { errAsync, type ResultAsync } from "neverthrow";

export interface ProjectInstructionsError {
  readonly type: "project_instructions_error";
  readonly code: "invalid" | "not_found" | "conflict" | "unavailable" | "internal";
  readonly message: string;
}
export interface ProjectInstructionsStore {
  read(
    task: SimulationTask,
    projectId: string,
  ): ResultAsync<ProjectInstructions, ProjectInstructionsError>;
  /** Atomic assignment fenced against project deletion. */
  replace(
    task: SimulationTask,
    projectId: string,
    content: string,
  ): ResultAsync<ProjectInstructions, ProjectInstructionsError>;
}
export const readProjectInstructions = (
  task: SimulationTask,
  store: ProjectInstructionsStore,
  projectId: string,
) => store.read(task, projectId);
export function saveProjectInstructions(
  task: SimulationTask,
  store: ProjectInstructionsStore,
  projectId: string,
  body: unknown,
) {
  const content = validateProjectInstructions(body);
  return content.isErr()
    ? errAsync<ProjectInstructions, ProjectInstructionsError>({
        type: "project_instructions_error",
        code: "invalid",
        message: content.error.message,
      })
    : store.replace(task, projectId, content.value);
}
