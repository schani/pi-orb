import {
  type ProjectInstructions,
  ProjectInstructionsSchema,
  validateProjectInstructions,
} from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, errAsync, ok, type ResultAsync } from "neverthrow";
import { Check } from "typebox/value";
import type { StoreError } from "../../domain/errors.ts";
import type {
  ProjectInstructionsError,
  ProjectInstructionsStore,
} from "../../domain/project-instructions.ts";
import type { PgQueryResult, PostgreSQLClient } from "./client.ts";

const projectIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const missing = (): ProjectInstructionsError => ({
  type: "project_instructions_error",
  code: "not_found",
  message: "Project doesn't exist",
});
const conflict = (): ProjectInstructionsError => ({
  type: "project_instructions_error",
  code: "conflict",
  message: "Project is deleting",
});
const storageError = (error?: StoreError): ProjectInstructionsError => ({
  type: "project_instructions_error",
  code: error?.code === "unavailable" ? "unavailable" : "internal",
  message:
    error?.code === "unavailable"
      ? "Project instructions unavailable"
      : "Project instructions storage is inconsistent",
});
function snapshot(result: PgQueryResult) {
  const row = result.rows[0];
  if (!row) return err<ProjectInstructions, ProjectInstructionsError>(missing());
  if (row["state"] !== "active")
    return err<ProjectInstructions, ProjectInstructionsError>(conflict());
  const value = {
    content: row["instructions_content"],
    revision: Number(row["instructions_revision"]),
  };
  return Check(ProjectInstructionsSchema, value) &&
    validateProjectInstructions({ content: value.content }).isOk()
    ? ok<ProjectInstructions, ProjectInstructionsError>(value)
    : err<ProjectInstructions, ProjectInstructionsError>(storageError());
}
export class PostgreSQLProjectInstructionsStore implements ProjectInstructionsStore {
  private readonly db: PostgreSQLClient;
  constructor(db: PostgreSQLClient) {
    this.db = db;
  }
  read(
    _task: SimulationTask,
    projectId: string,
  ): ResultAsync<ProjectInstructions, ProjectInstructionsError> {
    if (!projectIdPattern.test(projectId)) return errAsync(missing());
    return this.db
      .query(
        "SELECT state, instructions_content, instructions_revision FROM projects WHERE id = $1",
        [projectId],
      )
      .mapErr(storageError)
      .andThen(snapshot);
  }
  replace(
    _task: SimulationTask,
    projectId: string,
    content: string,
  ): ResultAsync<ProjectInstructions, ProjectInstructionsError> {
    if (!projectIdPattern.test(projectId)) return errAsync(missing());
    return this.db
      .transaction<ProjectInstructions, ProjectInstructionsError>(async (query) => {
        const locked = await query("SELECT state FROM projects WHERE id = $1 FOR UPDATE", [
          projectId,
        ]);
        if (locked.isErr()) return err(storageError(locked.error));
        const row = locked.value.rows[0];
        if (!row) return err(missing());
        if (row["state"] !== "active") return err(conflict());
        const written = await query(
          "UPDATE projects SET instructions_content = $2, instructions_revision = instructions_revision + 1 WHERE id = $1 RETURNING state, instructions_content, instructions_revision",
          [projectId, content],
        );
        return written.isErr() ? err(storageError(written.error)) : snapshot(written.value);
      })
      .mapErr((error) =>
        error.type === "project_instructions_error" ? error : storageError(error),
      );
  }
}
