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
import type { PostgreSQLClient } from "./client.ts";
import { PgResourceSnapshots, type ResourceQuery } from "./resource-snapshots.ts";

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
    return this.db
      .transaction(async (query) => {
        const admitted = await this.guard(query, orb, context.signal);
        if (admitted.isErr()) return err(admitted.error);
        const recorded = await query(
          "INSERT INTO orb_resource_events(orb_id,admission_version,phase,error_code,commit_sha,file_count,byte_count) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id",
          [
            orb.id,
            orb.agentAdmissionVersion,
            status.phase,
            status.phase === "failed" ? status.code : null,
            status.phase === "ready" ? status.commitSha : null,
            status.phase === "ready" ? status.fileCount : null,
            status.phase === "ready" ? status.byteCount : null,
          ],
        );
        return recorded.map((result) => result.rowCount > 0);
      })
      .mapErr(() => resourceError("storage", "Resource status unavailable"))
      .map((recorded) => {
        if (recorded)
          logOrbEvent(task, orb.id, `resources.${status.phase}`, {
            admission_version: orb.agentAdmissionVersion,
            ...(status.phase === "failed"
              ? { code: status.code }
              : status.phase === "ready"
                ? { commit_sha: status.commitSha, files: status.fileCount, bytes: status.byteCount }
                : {}),
          });
        return undefined;
      });
  }
  initialPin(_task: SimulationTask, orb: OrbRow): ResultAsync<string | null, ResourceError> {
    return new PgResourceSnapshots(this.db).get(orb.id).andThen((snapshot) => {
      if (snapshot) return okAsync(snapshot.commitSha);
      return this.db
        .query(
          "SELECT phase,error_code FROM orb_resource_events WHERE orb_id=$1 AND admission_version=$2 ORDER BY id DESC LIMIT 1",
          [orb.id, orb.agentAdmissionVersion],
        )
        .mapErr(() => resourceError("storage", "Resource status unavailable"))
        .andThen((result) =>
          result.rows[0]?.phase === "failed" && result.rows[0]?.error_code !== "storage"
            ? errAsync(resourceError("fetch", "Resource acquisition failed"))
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
      if (existing) return okAsync(existing);
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
