import type { UploadBatch, UploadProgress, UploadSpec, WorkspaceUpload } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, ok, type ResultAsync } from "neverthrow";
import type { StateConflict, StoreError } from "./errors.ts";
import type { ControlPlaneStore } from "./ports.ts";

export type UploadRow = WorkspaceUpload & {
  orbId: string;
  incarnation: number;
  activeUntil: number;
};
export type UploadStoreError = StoreError | StateConflict;
export interface WorkspaceUploadStore {
  createBatch(
    task: SimulationTask,
    orbId: string,
    batch: UploadBatch,
    now: number,
  ): ResultAsync<UploadRow[], UploadStoreError>;
  list(task: SimulationTask, orbId: string): ResultAsync<UploadRow[], StoreError>;
  admit(
    task: SimulationTask,
    orbId: string,
    spec: UploadSpec,
    now: number,
  ): ResultAsync<UploadRow, UploadStoreError>;
  record(
    task: SimulationTask,
    row: UploadRow,
    patch: Partial<Pick<WorkspaceUpload, "offset" | "path" | "sha256" | "status" | "error">>,
    now: number,
  ): ResultAsync<UploadRow, UploadStoreError>;
}

/** Immutable batch membership and terminal file outcomes precede inbox acceptance. */
export async function notifyUpload(task: SimulationTask, store: ControlPlaneStore, row: UploadRow) {
  if (!["stored", "cancelled"].includes(row.status)) return ok(row);
  const listed = await store.uploads.list(task, row.orbId);
  if (listed.isErr()) return listed;
  const members = listed.value.filter((member) => member.batchId === row.batchId);
  if (members.some((member) => !["stored", "notified", "cancelled"].includes(member.status)))
    return ok(row);
  const successful = members
    .filter((member) => member.path !== null && member.status !== "cancelled")
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (!successful.length) return ok(row);
  const lines = successful.map((member) => `${JSON.stringify(member.path)} (${member.size} bytes)`);
  const text =
    lines.length === 1
      ? `The user uploaded a file to ${lines[0]}.`
      : `The user uploaded files:\n${lines.map((line) => `- ${line}`).join("\n")}`;
  const result = await store.enqueueOrbMessage(task, {
    orbId: row.orbId,
    messageId: row.batchId,
    now: task.wallNow(),
    wake: false,
    content: [
      {
        type: "text",
        text,
      },
    ],
  });
  if (result.isErr()) {
    await store.uploads.record(
      task,
      row,
      { error: `notification pending: ${result.error.type}` },
      task.wallNow(),
    );
    return err(result.error);
  }
  let current = row;
  for (const member of successful) {
    const recorded = await store.uploads.record(
      task,
      member,
      { status: "notified", error: null },
      task.wallNow(),
    );
    if (recorded.isErr()) return recorded;
    if (member.id === row.id) current = recorded.value;
  }
  return ok(current);
}

export interface UploadRuntime {
  status(
    row: UploadRow,
  ): ResultAsync<UploadProgress, { type: "upload_transport"; message: string }>;
  finish?(
    row: UploadRow,
  ): ResultAsync<UploadProgress, { type: "upload_transport"; message: string }>;
}
/** Recovery runs on ordinary running reconciliation, including after browser loss. */
export async function recoverUploads(
  task: SimulationTask,
  store: ControlPlaneStore,
  runtime: UploadRuntime,
  orbId: string,
) {
  const rows = await store.uploads.list(task, orbId);
  if (rows.isErr()) return rows;
  for (const row of rows.value) {
    if (row.status === "stored") {
      const sent = await notifyUpload(task, store, row);
      if (sent.isErr()) return sent;
    } else if (row.status === "finalizing") {
      const orb = await store.getOrb(task, orbId);
      if (orb.isErr()) return orb;
      if (orb.value?.state !== "running") continue;
      // Rebind retained workspace metadata after replacement, but do not renew
      // failed transfers every reconcile tick and thereby keep compute alive forever.
      const admitted =
        row.incarnation !== orb.value.hostIncarnation
          ? await store.uploads.admit(
              task,
              orbId,
              { id: row.id, name: row.name, size: row.size },
              task.wallNow(),
            )
          : ok(row);
      if (admitted.isErr()) return admitted;
      let status = await runtime.status(admitted.value);
      if (
        status.isOk() &&
        status.value.path === null &&
        row.error === null &&
        row.activeUntil > task.wallNow() &&
        runtime.finish
      ) {
        status = await runtime.finish(admitted.value);
      }
      if (status.isErr()) {
        await store.uploads.record(
          task,
          admitted.value,
          { error: status.error.message },
          task.wallNow(),
        );
        continue;
      }
      if (status.value.path !== null) {
        const stored = await store.uploads.record(
          task,
          admitted.value,
          { ...status.value, status: "stored", error: null },
          task.wallNow(),
        );
        if (stored.isErr()) return stored;
        const sent = await notifyUpload(task, store, stored.value);
        if (sent.isErr()) return sent;
      }
    }
  }
  return ok(undefined);
}
