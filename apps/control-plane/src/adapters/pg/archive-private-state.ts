import { err, ok } from "neverthrow";
import type { StoreError } from "../../domain/errors.ts";
import type { ResourceQuery } from "./resource-snapshots.ts";

/** Called only inside the archive seal transaction, after locking the orb and draining work. */
export async function removePrivateAgentState(query: ResourceQuery, orbId: string, now: number) {
  for (const table of [
    "orb_agent_artifacts",
    "orb_resource_snapshots",
    "durable_pg_document_revisions",
    "durable_pg_documents",
    "durable_pg_submissions",
    "durable_pg_tasks",
    "durable_pg_entries",
    "durable_pg_conversations",
    "durable_pg_record_ids",
    "durable_pg_durable_metadata",
  ]) {
    const removed = await query(`DELETE FROM ${table} WHERE orb_id=$1`, [orbId]);
    if (removed.isErr()) return err(removed.error);
  }
  const revoked = await query(
    "UPDATE durable_pg_owners SET archived=true, fence=fence+1, lease_until=0 WHERE orb_id=$1 AND NOT archived RETURNING fence",
    [orbId],
  );
  if (revoked.isErr()) return err(revoked.error);
  const row = revoked.value.rows[0];
  if (row) {
    const event = await query(
      "INSERT INTO durable_pg_owner_events(orb_id,fence,outcome,recorded_at) VALUES($1,$2,'archived',$3)",
      [orbId, Number(row.fence), now],
    );
    if (event.isErr()) return err(event.error);
  }
  return ok<void, StoreError>(undefined);
}
