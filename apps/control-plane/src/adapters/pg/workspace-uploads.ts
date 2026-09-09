import {
  UPLOAD_LEASE_MS,
  type UploadBatch,
  type UploadSpec,
  type WorkspaceUpload,
} from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, ok } from "neverthrow";
import type {
  UploadRow,
  UploadStoreError,
  WorkspaceUploadStore,
} from "../../domain/workspace-uploads.ts";
import { arrayParam, type PgRow, type PostgreSQLClient } from "./client.ts";

const map = (r: PgRow): UploadRow => ({
  id: String(r.id),
  batchId: String(r.batch_id),
  orbId: String(r.orb_id),
  name: String(r.name),
  size: Number(r.size),
  incarnation: Number(r.incarnation),
  status: String(r.status) as UploadRow["status"],
  offset: Number(r.offset_bytes),
  path: r.path == null ? null : String(r.path),
  sha256: r.sha256 == null ? null : String(r.sha256),
  error: r.error == null ? null : String(r.error),
  activeUntil:
    r.active_until instanceof Date
      ? r.active_until.getTime()
      : new Date(String(r.active_until)).getTime(),
});
const conflict = () => ({ type: "state_conflict" as const });
export class PgWorkspaceUploads implements WorkspaceUploadStore {
  private readonly db: PostgreSQLClient;
  constructor(db: PostgreSQLClient) {
    this.db = db;
  }
  list(_task: SimulationTask, orbId: string) {
    return this.db
      .query("SELECT * FROM workspace_uploads WHERE orb_id=$1 ORDER BY updated_at, id", [orbId])
      .map((r) => r.rows.map(map));
  }
  createBatch(_task: SimulationTask, orbId: string, batch: UploadBatch, now: number) {
    return this.db.transaction<UploadRow[], UploadStoreError>(async (query) => {
      const locked = await query("SELECT * FROM orbs WHERE id=$1 FOR UPDATE", [orbId]);
      if (locked.isErr()) return err(locked.error);
      const orb = locked.value.rows[0];
      if (
        orb?.state !== "running" ||
        orb.host_discard_through_incarnation != null ||
        !batch.files.length ||
        new Set(batch.files.map((file) => file.id)).size !== batch.files.length
      )
        return err(conflict());
      const found = await query(
        "SELECT * FROM workspace_uploads WHERE orb_id=$1 AND (batch_id=$2 OR id=ANY($3::uuid[]))",
        [orbId, batch.id, arrayParam(batch.files.map((file) => file.id))],
      );
      if (found.isErr()) return err(found.error);
      if (found.value.rows.length) {
        const rows = found.value.rows.map(map);
        return rows.length === batch.files.length &&
          rows.every(
            (row) =>
              row.batchId === batch.id &&
              batch.files.some(
                (file) => file.id === row.id && file.name === row.name && file.size === row.size,
              ),
          )
          ? ok(rows)
          : err(conflict());
      }
      const rows: UploadRow[] = [];
      for (const file of batch.files) {
        const inserted = await query(
          `INSERT INTO workspace_uploads (orb_id,id,batch_id,name,size,incarnation,status,active_until,created_at,updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,'transferring',$7,$8,$8) RETURNING *`,
          [
            orbId,
            file.id,
            batch.id,
            file.name,
            file.size,
            orb.host_incarnation,
            new Date(now + UPLOAD_LEASE_MS),
            new Date(now),
          ],
        );
        if (inserted.isErr()) return err(inserted.error);
        rows.push(...inserted.value.rows.map(map));
      }
      const touched = await query(
        `UPDATE orbs SET upload_active_until=GREATEST(COALESCE(upload_active_until,$2),$2),
        last_busy_at=GREATEST(COALESCE(last_busy_at,$3),$3), state_version=state_version+
        CASE WHEN upload_active_until IS NULL OR upload_active_until <= $3 THEN 1 ELSE 0 END WHERE id=$1`,
        [orbId, new Date(now + UPLOAD_LEASE_MS), new Date(now)],
      );
      return touched.isErr() ? err(touched.error) : ok(rows);
    });
  }
  admit(_task: SimulationTask, orbId: string, spec: UploadSpec, now: number) {
    return this.db.transaction<UploadRow, UploadStoreError>(async (query) => {
      const orb = await query("SELECT * FROM orbs WHERE id=$1 FOR UPDATE", [orbId]);
      if (orb.isErr()) return err(orb.error);
      const o = orb.value.rows[0];
      if (o?.state !== "running" || o.host_discard_through_incarnation != null)
        return err(conflict());
      const old = await query("SELECT * FROM workspace_uploads WHERE orb_id=$1 AND id=$2", [
        orbId,
        spec.id,
      ]);
      if (old.isErr()) return err(old.error);
      const previous = old.value.rows[0];
      if (
        previous &&
        (previous.name !== spec.name ||
          Number(previous.size) !== spec.size ||
          previous.status === "cancelled")
      )
        return err(conflict());
      if (previous && ["stored", "notified"].includes(String(previous.status)))
        return ok(map(previous));
      if (!previous) {
        const group = await query(
          "SELECT id FROM workspace_uploads WHERE orb_id=$1 AND batch_id=$2",
          [orbId, spec.id],
        );
        if (group.isErr()) return err(group.error);
        if (group.value.rows.length) return err(conflict());
      }
      const activeUntil = new Date(now + UPLOAD_LEASE_MS);
      const inserted = await query(
        `INSERT INTO workspace_uploads (orb_id,id,batch_id,name,size,incarnation,status,active_until,created_at,updated_at)
        VALUES ($1,$2,$2,$3,$4,$5,'transferring',$6,$7,$7)
        ON CONFLICT (orb_id,id) DO UPDATE SET incarnation=$5, active_until=$6, updated_at=$7, error=NULL RETURNING *`,
        [orbId, spec.id, spec.name, spec.size, o.host_incarnation, activeUntil, new Date(now)],
      );
      if (inserted.isErr()) return err(inserted.error);
      // The epoch bump fences an idle decision made before admission/renewal.
      const touch = await query(
        `UPDATE orbs SET upload_active_until=GREATEST(COALESCE(upload_active_until,$2),$2),
        last_busy_at=GREATEST(COALESCE(last_busy_at,$3),$3), state_version=state_version+
        CASE WHEN upload_active_until IS NULL OR upload_active_until <= $3 THEN 1 ELSE 0 END WHERE id=$1`,
        [orbId, activeUntil, new Date(now)],
      );
      return touch.isErr() ? err(touch.error) : ok(map(inserted.value.rows[0] ?? {}));
    });
  }
  record(
    _task: SimulationTask,
    row: UploadRow,
    patch: Partial<Pick<WorkspaceUpload, "offset" | "path" | "sha256" | "status" | "error">>,
    now: number,
  ) {
    return this.db.transaction<UploadRow, UploadStoreError>(async (query) => {
      const orb = await query("SELECT * FROM orbs WHERE id=$1 FOR UPDATE", [row.orbId]);
      if (orb.isErr()) return err(orb.error);
      const o = orb.value.rows[0];
      if (
        !o ||
        ["archiving", "archived", "deleting"].includes(String(o.state)) ||
        (Number(o.host_incarnation) !== row.incarnation && patch.status !== "notified")
      )
        return err(conflict());
      const found = await query("SELECT * FROM workspace_uploads WHERE orb_id=$1 AND id=$2", [
        row.orbId,
        row.id,
      ]);
      if (found.isErr()) return err(found.error);
      const raw = found.value.rows[0];
      if (!raw || Number(raw.incarnation) !== row.incarnation) return err(conflict());
      const old = map(raw);
      if (old.status === "notified" || old.status === "cancelled") return ok(old);
      const next = { ...old, ...patch, offset: Math.max(old.offset, patch.offset ?? 0) };
      if (old.status === "stored" && !["stored", "notified"].includes(next.status)) return ok(old);
      if (old.status === "finalizing" && next.status === "transferring") next.status = "finalizing";
      const terminal = ["stored", "notified", "cancelled"].includes(next.status);
      const updated = await query(
        `UPDATE workspace_uploads SET offset_bytes=$3,path=$4,sha256=$5,status=$6,error=$7,
        active_until=$8,updated_at=$9 WHERE orb_id=$1 AND id=$2 RETURNING *`,
        [
          row.orbId,
          row.id,
          next.offset,
          next.path,
          next.sha256,
          next.status,
          next.error,
          new Date(terminal ? now : old.activeUntil),
          new Date(now),
        ],
      );
      if (updated.isErr()) return err(updated.error);
      const touch = await query(
        `UPDATE orbs SET upload_active_until=(SELECT MAX(active_until) FROM workspace_uploads
        WHERE orb_id=$1 AND status IN ('transferring','finalizing')),last_busy_at=GREATEST(COALESCE(last_busy_at,$2),$2),
        state_version=state_version+$3 WHERE id=$1`,
        [row.orbId, new Date(now), terminal ? 1 : 0],
      );
      return touch.isErr() ? err(touch.error) : ok(map(updated.value.rows[0] ?? {}));
    });
  }
}
