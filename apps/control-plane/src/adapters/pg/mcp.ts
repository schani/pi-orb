import { type McpCatalog, McpCatalogSchema } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, errAsync, ok, type ResultAsync } from "neverthrow";
import { Check } from "typebox/value";
import type { McpConfigError, McpStore } from "../../domain/mcp.ts";
import { jsonParam, type PostgreSQLClient } from "./client.ts";

const projectIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const unavailable = (): McpConfigError => ({
  type: "mcp_config_error",
  code: "unavailable",
  message: "MCP configuration unavailable",
});
const missing = (): McpConfigError => ({
  type: "mcp_config_error",
  code: "not_found",
  message: "Project doesn't exist",
});
const conflict = (): McpConfigError => ({
  type: "mcp_config_error",
  code: "conflict",
  message: "Project or MCP configuration changed; reload before saving",
});
export class PostgreSQLMcpStore implements McpStore {
  private readonly db: PostgreSQLClient;
  constructor(db: PostgreSQLClient) {
    this.db = db;
  }
  read(_task: SimulationTask, projectId: string): ResultAsync<McpCatalog, McpConfigError> {
    if (!projectIdPattern.test(projectId)) return errAsync(missing());
    return this.db
      .query(
        `SELECT p.state, m.revision, m.servers FROM projects p LEFT JOIN project_mcp m ON m.project_id = p.id WHERE p.id = $1`,
        [projectId],
      )
      .mapErr(unavailable)
      .andThen((result) => {
        const row = result.rows[0];
        if (!row) return err(missing());
        if (row["state"] !== "active") return err(conflict());
        const value = { revision: Number(row["revision"] ?? 0), servers: row["servers"] ?? [] };
        return Check(McpCatalogSchema, value) ? ok(value) : err(unavailable());
      });
  }
  replace(
    _task: SimulationTask,
    projectId: string,
    catalog: McpCatalog,
  ): ResultAsync<McpCatalog, McpConfigError> {
    if (!projectIdPattern.test(projectId)) return errAsync(missing());
    return this.db
      .transaction<McpCatalog, McpConfigError>(async (query) => {
        const project = await query("SELECT state FROM projects WHERE id = $1 FOR UPDATE", [
          projectId,
        ]);
        if (project.isErr()) return err(unavailable());
        const row = project.value.rows[0];
        if (!row) return err(missing());
        if (row["state"] !== "active") return err(conflict());
        const current = await query("SELECT revision FROM project_mcp WHERE project_id = $1", [
          projectId,
        ]);
        if (current.isErr()) return err(unavailable());
        if (Number(current.value.rows[0]?.["revision"] ?? 0) !== catalog.revision)
          return err(conflict());
        const next = { revision: catalog.revision + 1, servers: catalog.servers };
        const written = await query(
          `INSERT INTO project_mcp (project_id, revision, servers) VALUES ($1, $2, $3) ON CONFLICT (project_id) DO UPDATE SET revision = EXCLUDED.revision, servers = EXCLUDED.servers, updated_at = now()`,
          [projectId, next.revision, jsonParam(next.servers)],
        );
        return written.isErr() ? err(unavailable()) : ok(next);
      })
      .mapErr((error) => (error.type === "mcp_config_error" ? error : unavailable()));
  }
}
