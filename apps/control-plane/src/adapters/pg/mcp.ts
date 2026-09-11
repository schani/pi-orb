import { type McpCatalog, McpCatalogSchema, missingMcpSecrets } from "@pi-orb/protocol";
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
        const secrets = await query(
          "SELECT entries FROM project_secret_pointers WHERE project_id = $1",
          [projectId],
        );
        if (secrets.isErr()) return err(unavailable());
        const missingSecrets = missingMcpSecrets(
          catalog.servers,
          (secrets.value.rows[0]?.["entries"] ?? {}) as Record<string, unknown>,
        );
        if (missingSecrets.length)
          return err({
            type: "mcp_config_error" as const,
            code: "conflict" as const,
            message: `MCP secrets don't exist: ${missingSecrets.join(", ")}`,
          });
        const next = { revision: catalog.revision + 1, servers: catalog.servers };
        const written = await query(
          `INSERT INTO project_mcp (project_id, revision, servers) VALUES ($1, $2, $3) ON CONFLICT (project_id) DO UPDATE SET revision = EXCLUDED.revision, servers = EXCLUDED.servers, updated_at = now()`,
          [projectId, next.revision, jsonParam(next.servers)],
        );
        if (written.isErr()) return err(unavailable());
        const invalidated = await query(
          `WITH changed AS (
          UPDATE mcp_oauth SET state = state || jsonb_build_object(
            'secretVersion', NULL, 'attempt', NULL, 'refreshLeaseUntil', 0,
            'rowVersion', (state->>'rowVersion')::bigint + 1,
            'generation', (state->>'generation')::bigint + 1)
          WHERE project_id = $1 AND (state->>'secretVersion' IS NOT NULL OR state->>'attempt' IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements($2::jsonb) s WHERE s->'oauth'->>'id' = connection_id::text AND s->>'url' = mcp_oauth.url)
          RETURNING connection_id, state
        ) INSERT INTO mcp_oauth_events(project_id,connection_id,row_version,generation,edge)
          SELECT $1, connection_id, (state->>'rowVersion')::bigint, (state->>'generation')::bigint, 'removed' FROM changed`,
          [projectId, jsonParam(next.servers)],
        );
        return invalidated.isErr() ? err(unavailable()) : ok(next);
      })
      .mapErr((error) => (error.type === "mcp_config_error" ? error : unavailable()));
  }
}
