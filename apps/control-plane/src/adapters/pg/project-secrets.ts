import { McpCatalogSchema, mcpSecretUsers } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import { Check } from "typebox/value";
import type {
  ProjectConflict,
  ProjectSecretPointerConflict,
  StoreError,
} from "../../domain/errors.ts";
import type {
  ProjectSecretPointerRow,
  ProjectSecretPointerStore,
  ProjectSecretPointerWrite,
} from "../../domain/ports.ts";
import { jsonParam, type PgRow, type PostgreSQLClient } from "./client.ts";

function toMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") return new Date(value).getTime();
  return Number(value);
}

function mapRow(row: PgRow): ProjectSecretPointerRow {
  const raw = (row["entries"] ?? {}) as Record<string, unknown>;
  return {
    projectId: String(row["project_id"]),
    rowVersion: Number(row["row_version"]),
    revision: Number(row["revision"]),
    entries: Object.fromEntries(Object.entries(raw).map(([name, at]) => [name, Number(at)])),
    secretVersion: String(row["secret_version"]),
    updatedAt: toMs(row["updated_at"]),
  };
}

const projectConflict = (reason: ProjectConflict["reason"]): ProjectConflict => ({
  type: "project_conflict",
  reason,
});

/** Exact-version metadata and active-project fence for project secrets. */
export class PostgreSQLProjectSecretPointerStore implements ProjectSecretPointerStore {
  private readonly db: PostgreSQLClient;

  constructor(db: PostgreSQLClient) {
    this.db = db;
  }

  readProjectSecretPointer(
    _task: SimulationTask,
    projectId: string,
  ): ResultAsync<ProjectSecretPointerRow | null, StoreError | ProjectConflict> {
    const run = async (): Promise<
      Result<ProjectSecretPointerRow | null, StoreError | ProjectConflict>
    > => {
      const result = await this.db.query(
        `SELECT p.state AS project_state, s.project_id, s.row_version, s.revision,
                s.entries, s.secret_version, s.updated_at
         FROM projects p LEFT JOIN project_secret_pointers s ON s.project_id = p.id
         WHERE p.id = $1`,
        [projectId],
      );
      if (result.isErr()) return err(result.error);
      const row = result.value.rows[0];
      if (row === undefined) return err(projectConflict("not_found"));
      if (row["project_state"] !== "active") return err(projectConflict("deleting"));
      return ok(row["project_id"] == null ? null : mapRow(row));
    };
    return new ResultAsync(run());
  }

  casWriteProjectSecretPointer(
    _task: SimulationTask,
    projectId: string,
    expectedRowVersion: number | null,
    next: ProjectSecretPointerWrite,
  ): ResultAsync<
    ProjectSecretPointerRow,
    StoreError | ProjectConflict | ProjectSecretPointerConflict
  > {
    return this.db.transaction<
      ProjectSecretPointerRow,
      StoreError | ProjectConflict | ProjectSecretPointerConflict
    >(async (query) => {
      const project = await query("SELECT state FROM projects WHERE id = $1 FOR UPDATE", [
        projectId,
      ]);
      if (project.isErr()) return err(project.error);
      const state = project.value.rows[0]?.["state"];
      if (state === undefined) return err(projectConflict("not_found"));
      if (state !== "active") return err(projectConflict("deleting"));
      // Catalog replacement takes the same parent lock: reference checks and deletion publish atomically.
      const before = await query("SELECT * FROM project_secret_pointers WHERE project_id = $1", [
        projectId,
      ]);
      if (before.isErr()) return err(before.error);
      const pointer = before.value.rows[0] ? mapRow(before.value.rows[0]) : null;
      if ((pointer?.rowVersion ?? null) !== expectedRowVersion)
        return err({ type: "project_secret_pointer_conflict" as const });
      const removed = Object.keys(pointer?.entries ?? {}).filter(
        (name) => !Object.hasOwn(next.entries, name),
      );
      if (removed.length) {
        const stored = await query(
          "SELECT revision, servers FROM project_mcp WHERE project_id = $1",
          [projectId],
        );
        if (stored.isErr()) return err(stored.error);
        const catalog = {
          revision: Number(stored.value.rows[0]?.["revision"] ?? 0),
          servers: stored.value.rows[0]?.["servers"] ?? [],
        };
        if (!Check(McpCatalogSchema, catalog))
          return err({
            type: "store_error" as const,
            code: "corruption" as const,
            message: "Invalid MCP catalog",
            retryable: false,
          });
        const used = removed.filter((name) => mcpSecretUsers(catalog.servers, name).length > 0);
        if (used.length)
          return err({
            type: "project_secret_in_use" as const,
            secrets: used,
            servers: [
              ...new Set(used.flatMap((name) => mcpSecretUsers(catalog.servers, name))),
            ].sort(),
          });
      }
      const result =
        expectedRowVersion === null
          ? await query(
              `INSERT INTO project_secret_pointers
                 (project_id, row_version, revision, entries, secret_version, updated_at)
               VALUES ($1, 1, $2, $3, $4, $5)
               ON CONFLICT (project_id) DO NOTHING RETURNING *`,
              [
                projectId,
                next.revision,
                jsonParam(next.entries),
                next.secretVersion,
                new Date(next.updatedAt),
              ],
            )
          : await query(
              `UPDATE project_secret_pointers
               SET row_version = row_version + 1, revision = $3, entries = $4,
                   secret_version = $5, updated_at = $6
               WHERE project_id = $1 AND row_version = $2 RETURNING *`,
              [
                projectId,
                expectedRowVersion,
                next.revision,
                jsonParam(next.entries),
                next.secretVersion,
                new Date(next.updatedAt),
              ],
            );
      if (result.isErr()) return err(result.error);
      const row = result.value.rows[0];
      return row === undefined
        ? err({ type: "project_secret_pointer_conflict" as const })
        : ok(mapRow(row));
    });
  }

  deleteProjectSecretPointer(
    _task: SimulationTask,
    projectId: string,
  ): ResultAsync<void, StoreError | ProjectConflict> {
    return this.db.transaction<void, StoreError | ProjectConflict>(async (query) => {
      const project = await query("SELECT state FROM projects WHERE id = $1 FOR UPDATE", [
        projectId,
      ]);
      if (project.isErr()) return err(project.error);
      const state = project.value.rows[0]?.["state"];
      if (state === undefined) return err(projectConflict("not_found"));
      if (state !== "deleting") return err(projectConflict("concurrent_change"));
      const deleted = await query("DELETE FROM project_secret_pointers WHERE project_id = $1", [
        projectId,
      ]);
      return deleted.isErr() ? err(deleted.error) : ok(undefined);
    });
  }
}
