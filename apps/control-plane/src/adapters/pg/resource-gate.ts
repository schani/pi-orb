import type { SimulationTask } from "determined";
import { err, errAsync, ok, okAsync, type ResultAsync } from "neverthrow";
import type { StoreError } from "../../domain/errors.ts";
import { logOrbEvent } from "../../domain/log.ts";
import type { OrbRow } from "../../domain/orb.ts";
import type { OperationContext } from "../../domain/ports.ts";
import {
  ResourceAcquisition,
  type ResourceError,
  type ResourceSource,
  type ResourceStatus,
  resourceError,
} from "../../domain/resources.ts";
import { jsonParam, type PostgreSQLClient } from "./client.ts";
import { PgResourceSnapshots, type ResourceQuery } from "./resource-snapshots.ts";

const resourceErrorCodes: ResourceError["code"][] = [
  "cancelled",
  "authentication",
  "fetch",
  "invalid",
  "limit",
  "storage",
  "conflict",
  "not_found",
];
const safeStoredMessage = (message: unknown): string =>
  typeof message === "string" && message.length > 0 && message.length <= 1536
    ? message
    : "Resource acquisition failed";

const revoked = (): StoreError => ({
  type: "store_error",
  code: "invariant",
  message: "Resource admission revoked",
  retryable: false,
});

/** Repository snapshots and content-free acquisition outcomes are durable, per admission generation. */
export class PgResourceGate {
  private readonly db: PostgreSQLClient;
  private readonly source: ResourceSource;
  constructor(db: PostgreSQLClient, source: ResourceSource) {
    this.db = db;
    this.source = source;
  }
  private guard(query: ResourceQuery, orb: OrbRow, signal?: AbortSignal) {
    return query(
      "SELECT agent_admission_version,state,stop_reason FROM orbs WHERE id=$1 FOR UPDATE",
      [orb.id],
    ).andThen((result) => {
      const row = result.rows[0];
      return signal?.aborted ||
        !row ||
        Number(row.agent_admission_version) !== orb.agentAdmissionVersion ||
        ["archiving", "archived", "deleting"].includes(String(row.state)) ||
        row.stop_reason === "manual" ||
        row.stop_reason === "sleep"
        ? err(revoked())
        : ok(undefined);
    });
  }
  private status(
    task: SimulationTask,
    orb: OrbRow,
    context: OperationContext,
    status: ResourceStatus,
  ) {
    const warnings =
      status.phase === "ready"
        ? (status.warnings ?? []).map(({ path, code }) => ({ path, code }))
        : [];
    return this.db
      .transaction(async (query) => {
        const admitted = await this.guard(query, orb, context.signal);
        if (admitted.isErr()) return err(admitted.error);
        if (status.phase === "ready") {
          const updated = await query("UPDATE orbs SET resource_warnings=$2 WHERE id=$1", [
            orb.id,
            jsonParam(warnings),
          ]);
          if (updated.isErr()) return err(updated.error);
        }
        const recorded = await query(
          "INSERT INTO orb_resource_events(orb_id,admission_version,phase,error_code,commit_sha,file_count,byte_count,warnings,error_message) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING id",
          [
            orb.id,
            orb.agentAdmissionVersion,
            status.phase,
            status.phase === "failed" ? status.code : null,
            status.phase === "ready" ? status.commitSha : null,
            status.phase === "ready" ? status.fileCount : null,
            status.phase === "ready" ? status.byteCount : null,
            jsonParam(warnings),
            status.phase === "failed" && status.message !== undefined
              ? safeStoredMessage(status.message)
              : null,
          ],
        );
        if (recorded.isErr()) return err(recorded.error);
        const stillAdmitted = await this.guard(query, orb, context.signal);
        if (stillAdmitted.isErr()) return err(stillAdmitted.error);
        return ok(recorded.value.rowCount > 0);
      })
      .mapErr(() => resourceError("storage", "Resource status unavailable"))
      .map((recorded) => {
        if (recorded) {
          logOrbEvent(task, orb.id, `resources.${status.phase}`, {
            admission_version: orb.agentAdmissionVersion,
            ...(status.phase === "failed"
              ? { code: status.code, ...(status.reason ? { reason: status.reason } : {}) }
              : status.phase === "ready"
                ? {
                    commit_sha: status.commitSha,
                    files: status.fileCount,
                    bytes: status.byteCount,
                    warning_count: warnings.length,
                  }
                : {}),
          });
          for (const warning of warnings)
            logOrbEvent(task, orb.id, "resources.warning", {
              code: warning.code,
              path: warning.path,
              warning_count: warnings.length,
            });
        }
        return undefined;
      });
  }
  initialPin(_task: SimulationTask, orb: OrbRow): ResultAsync<string | null, ResourceError> {
    return new PgResourceSnapshots(this.db).get(orb.id).andThen((snapshot) => {
      if (snapshot) return okAsync(snapshot.commitSha);
      return this.db
        .query(
          "SELECT phase,error_code,error_message FROM orb_resource_events WHERE orb_id=$1 AND admission_version=$2 ORDER BY id DESC LIMIT 1",
          [orb.id, orb.agentAdmissionVersion],
        )
        .mapErr(() => resourceError("storage", "Resource status unavailable"))
        .andThen((result) =>
          result.rows[0]?.phase === "failed" && result.rows[0]?.error_code !== "storage"
            ? errAsync(
                resourceError(
                  resourceErrorCodes.find((code) => code === result.rows[0]?.error_code) ?? "fetch",
                  safeStoredMessage(result.rows[0]?.error_message),
                ),
              )
            : okAsync(null),
        );
    });
  }
  acquire(task: SimulationTask, orb: OrbRow, context: OperationContext) {
    const store = new PgResourceSnapshots(this.db, (query) =>
      this.guard(query, orb, context.signal),
    );
    return store.get(orb.id).andThen((existing) => {
      if (context.signal.aborted)
        return errAsync(resourceError("cancelled", "Resource acquisition cancelled"));
      if (existing)
        return this.status(task, orb, context, {
          phase: "ready",
          commitSha: existing.commitSha,
          fileCount: existing.files.length,
          byteCount: existing.files.reduce((sum, file) => sum + file.bytes.byteLength, 0),
          warnings: existing.warnings ?? [],
        }).map(() => existing);
      return this.initialPin(task, orb)
        .andThen(() =>
          this.db
            .query(
              "SELECT p.repository_url FROM projects p JOIN orbs o ON o.project_id=p.id WHERE o.id=$1",
              [orb.id],
            )
            .mapErr(() => resourceError("storage", "Resource project unavailable")),
        )
        .andThen((result) => {
          const url = result.rows[0]?.repository_url;
          if (typeof url !== "string")
            return errAsync(resourceError("not_found", "Resource project unavailable"));
          return new ResourceAcquisition(store, this.source, {
            record: (_id, status) => this.status(task, orb, context, status),
          }).acquire({ orbId: orb.id, url, signal: context.signal });
        });
    });
  }
}
