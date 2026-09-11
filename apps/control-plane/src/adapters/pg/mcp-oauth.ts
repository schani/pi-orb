import type { SimulationTask } from "determined";
import { err, ok } from "neverthrow";
import {
  type McpOAuthBinding,
  type McpOAuthNext,
  type McpOAuthRow,
  type McpOAuthStore,
  oauthError,
} from "../../domain/mcp-oauth.ts";
import { jsonParam, type PostgreSQLClient } from "./client.ts";

export class PostgreSQLMcpOAuthStore implements McpOAuthStore {
  private readonly db: PostgreSQLClient;
  constructor(db: PostgreSQLClient) {
    this.db = db;
  }
  async pending(_task: SimulationTask) {
    return (
      await this.db.query(
        "SELECT secret_version FROM mcp_oauth_garbage ORDER BY secret_version LIMIT 100",
      )
    )
      .map((r) => r.rows.map((row) => String(row["secret_version"])))
      .mapErr(() => oauthError("unavailable"));
  }
  async finish(_task: SimulationTask, version: string, destroyed: boolean) {
    return (
      await this.db.transaction(async (query) => {
        // Same parent-before-child lock order as catalog mutation and project deletion.
        const owner = await query(
          "SELECT p.id FROM projects p JOIN mcp_oauth_garbage g ON g.project_id = p.id WHERE g.secret_version = $1 FOR UPDATE OF p",
          [version],
        );
        if (owner.isErr()) return err(oauthError("unavailable"));
        if (!owner.value.rows.length) return ok(undefined);
        const read = await query(
          "SELECT * FROM mcp_oauth_garbage WHERE secret_version = $1 FOR UPDATE",
          [version],
        );
        if (read.isErr()) return err(oauthError("unavailable"));
        const row = read.value.rows[0];
        if (!row) return ok(undefined);
        if (destroyed || !row["failed"]) {
          const event = await query(
            "INSERT INTO mcp_oauth_events(project_id,connection_id,row_version,generation,edge) VALUES($1,$2,$3,$4,$5)",
            [
              row["project_id"],
              row["connection_id"],
              row["row_version"],
              row["generation"],
              destroyed ? "credential_destroyed" : "credential_cleanup_failed",
            ],
          );
          if (event.isErr()) return err(oauthError("unavailable"));
        }
        const result = await query(
          destroyed
            ? "DELETE FROM mcp_oauth_garbage WHERE secret_version = $1"
            : "UPDATE mcp_oauth_garbage SET failed = true WHERE secret_version = $1",
          [version],
        );
        return result.isErr() ? err(oauthError("unavailable")) : ok(undefined);
      })
    ).mapErr((e) => (e.type === "mcp_oauth_error" ? e : oauthError("unavailable")));
  }
  private async locked(query: PostgreSQLClient["query"], b: McpOAuthBinding) {
    const p = await query("SELECT state FROM projects WHERE id = $1 FOR UPDATE", [b.projectId]);
    if (p.isErr()) return err(oauthError("unavailable"));
    if (p.value.rows[0]?.["state"] !== "active") return err(oauthError("not_found"));
    const config = await query(
      `SELECT 1 FROM project_mcp, jsonb_array_elements(servers) s WHERE project_id = $1 AND s->'oauth'->>'id' = $2 AND s->>'url' = $3`,
      [b.projectId, b.id, b.url],
    );
    if (config.isErr()) return err(oauthError("unavailable"));
    if (!config.value.rows.length) return err(oauthError("not_found"));
    const result = await query(
      "SELECT project_id, url, state FROM mcp_oauth WHERE connection_id = $1",
      [b.id],
    );
    if (result.isErr()) return err(oauthError("unavailable"));
    const row = result.value.rows[0];
    if (row && (row["project_id"] !== b.projectId || row["url"] !== b.url))
      return err(oauthError("conflict"));
    return ok(row ? (row["state"] as McpOAuthRow) : null);
  }
  async read(_task: SimulationTask, b: McpOAuthBinding) {
    return (await this.db.transaction((query) => this.locked(query, b))).mapErr((e) =>
      e.type === "mcp_oauth_error" ? e : oauthError("unavailable"),
    );
  }
  async cas(
    _task: SimulationTask,
    b: McpOAuthBinding,
    expected: number | null,
    next: McpOAuthNext,
    edge: string | null,
  ) {
    return (
      await this.db.transaction(async (query) => {
        const read = await this.locked(query, b);
        if (read.isErr()) return err(read.error);
        if ((read.value?.rowVersion ?? null) !== expected) return err(oauthError("conflict"));
        const row: McpOAuthRow = { ...next, provider: b.id, rowVersion: (expected ?? 0) + 1 };
        const written = await query(
          `INSERT INTO mcp_oauth(connection_id, project_id, url, state) VALUES ($1,$2,$3,$4) ON CONFLICT (connection_id) DO UPDATE SET state = EXCLUDED.state`,
          [b.id, b.projectId, b.url, jsonParam(row)],
        );
        if (written.isErr()) return err(oauthError("unavailable"));
        if (edge) {
          const event = await query(
            `INSERT INTO mcp_oauth_events(project_id,connection_id,row_version,generation,edge)
             SELECT $1,$2,$3,$4,$5 WHERE $5 <> 'refresh_failed' OR
             (SELECT edge FROM mcp_oauth_events WHERE connection_id = $2 ORDER BY id DESC LIMIT 1) IS DISTINCT FROM 'refresh_failed'`,
            [b.projectId, b.id, row.rowVersion, row.generation, edge],
          );
          if (event.isErr()) return err(oauthError("unavailable"));
        }
        return ok(row);
      })
    ).mapErr((e) => (e.type === "mcp_oauth_error" ? e : oauthError("unavailable")));
  }
}
