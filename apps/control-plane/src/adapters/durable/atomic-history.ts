import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type EntryId,
  ROOT_CONVERSATION_ID,
  type StorageWrite,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import { err, ok, okAsync, ResultAsync } from "neverthrow";
import { executor, type Query } from "../durable-pg/executor.ts";
import type { AuthorityError } from "../durable-pg/index.ts";
import { PgStorage } from "../durable-pg/storage.ts";
import { StorageFailure } from "../durable-pg/storage-boundary.ts";
import { arrayParam } from "../pg/client.ts";
import { commitHistoryTransaction } from "../pg/store.ts";
import { projectNativeInboxCommit } from "./inbox-admission.ts";
import { NOTIFICATION_REQUEST_PREFIX, projectNotificationAdmission } from "./notifications.ts";
import { type PublicEntryReceipt, projectEntry, projectHistory } from "./projection.ts";

/** Task/progress/store documents never trigger a root transcript scan. */
export function hasPublicHistoryWrites(
  query: Query,
  orbId: string,
  writes: readonly StorageWrite[],
) {
  if (
    writes.some(
      (write) =>
        (write.type === "entry" && write.value.conversationId === ROOT_CONVERSATION_ID) ||
        (write.type === "submission" &&
          write.value.conversationId === ROOT_CONVERSATION_ID &&
          write.value.entry !== undefined) ||
        ((write.type === "document.create" || write.type === "document.copy") &&
          write.record.kind === "orb.identity" &&
          write.record.scope.kind === "conversation" &&
          write.record.scope.conversationId === ROOT_CONVERSATION_ID),
    )
  )
    return okAsync(true);
  const ids = writes.flatMap((write) =>
    write.type === "document.change" || write.type === "document.retire" ? [write.id] : [],
  );
  if (ids.length === 0) return okAsync(false);
  return query(
    "SELECT id FROM durable_pg_documents WHERE orb_id=$1 AND id=ANY($2::bigint[]) AND kind=$3 AND scope_kind='conversation' AND owner_id=$4 LIMIT 1",
    [orbId, arrayParam(ids), JSON.stringify("orb.identity"), ROOT_CONVERSATION_ID],
  ).map((result) => result.rows.length > 0);
}

/** Complete accepted batches project through the same transaction, in native commit order. */
export async function projectNativeCommit(
  query: Query,
  orbId: string,
  writes: readonly StorageWrite[],
  admittedSubmissions: ReadonlySet<SubmissionId> = new Set(),
) {
  const notification = await projectNotificationAdmission(query, orbId, writes);
  if (notification.isErr()) return err(notification.error);
  const admitted = await projectNativeInboxCommit(query, orbId, writes, admittedSubmissions);
  if (admitted.isErr()) return err(admitted.error);
  const dirty = await hasPublicHistoryWrites(query, orbId, writes);
  if (dirty.isErr()) return err(dirty.error);
  if (!dirty.value) return ok(undefined);
  const cursor = await query("SELECT replication_cursor FROM orbs WHERE id=$1 FOR UPDATE", [orbId]);
  if (cursor.isErr()) return err(cursor.error);
  const stored = cursor.value.rows[0]?.replication_cursor;
  const after = stored == null ? null : String(stored);
  const read = await ResultAsync.fromPromise(
    (async () => {
      const sql = executor(query, orbId);
      const storage = await PgStorage.open({
        ...sql,
        close: async () => undefined,
        mintId: async () => Promise.reject(new StorageFailure("Projection is read-only")),
        transaction: (callback) => callback(sql),
        project: async () => Promise.reject(new StorageFailure("Projection is read-only")),
      });
      try {
        const roots = await storage.scanConversations({}, 1, undefined, BACKGROUND_CONTEXT);
        const root = roots.items[0];
        if (!root) return null;
        const document = await storage.findDocument(
          { kind: "orb.identity", scope: { kind: "conversation", conversationId: root.id } },
          "current",
          BACKGROUND_CONTEXT,
        );
        if (!document) return null;
        const identity = await storage.document(document.id, "current", BACKGROUND_CONTEXT);
        if (!identity) return null;
        const value = identity.value;
        if (typeof value.sessionId !== "string" || typeof value.timestamp !== "number") return null;
        const receipts = new Map<number, PublicEntryReceipt>();
        const notifications = new Set<number>();
        const entries = writes.flatMap((write) =>
          write.type === "entry" && write.value.conversationId === root.id ? [write.value] : [],
        );
        for (const write of writes) {
          if (write.type !== "submission" || write.value.conversationId !== root.id) continue;
          const submission = write.value;
          if (
            submission.entry !== undefined &&
            submission.requestId?.startsWith(NOTIFICATION_REQUEST_PREFIX)
          )
            notifications.add(submission.entry);
          if (submission.entry === undefined || !submission.requestId?.startsWith("inbox:"))
            continue;
          const raw = value.receipts;
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
          const receipt = raw[submission.requestId.slice(6)];
          if (
            !receipt ||
            typeof receipt !== "object" ||
            Array.isArray(receipt) ||
            !Array.isArray(receipt.messageIds)
          )
            continue;
          const system = receipt.system;
          receipts.set(submission.entry, {
            messageIds: receipt.messageIds.filter((id): id is string => typeof id === "string"),
            ...(system === undefined ? {} : { system }),
          });
        }
        let cursorValid = after === null;
        let afterId = -1;
        if (after?.startsWith(`${value.sessionId}:`)) {
          afterId = Number(after.slice(value.sessionId.length + 1));
          if (
            Number.isSafeInteger(afterId) &&
            afterId >= 0 &&
            after === `${value.sessionId}:${afterId}`
          ) {
            const source = await storage.entry(afterId as EntryId, BACKGROUND_CONTEXT);
            if (source?.entry.conversationId === root.id) {
              const mapped = projectEntry(source.entry, null, value.sessionId);
              cursorValid = mapped.isOk() && mapped.value?.id === after;
            }
          }
        }
        entries.sort((a, b) => a.id - b.id);
        return {
          session: {
            id: value.sessionId,
            timestamp: new Date(value.timestamp).toISOString(),
            overflow: { harness: "pi-durable" },
          },
          entries,
          cursorValid,
          afterId,
          receipts,
          notifications,
        };
      } finally {
        await storage.close(BACKGROUND_CONTEXT);
      }
    })(),
    (): AuthorityError => ({
      type: "authority_error",
      code: "projection",
      message: "Native projection read failed",
    }),
  );
  if (read.isErr()) return err(read.error);
  if (!read.value) return ok(undefined);
  if (!read.value.cursorValid)
    return err<never, AuthorityError>({
      type: "authority_error",
      code: "projection",
      message: "Public cursor absent from native history",
    });
  const projected = projectHistory(
    read.value.entries,
    read.value.session.id,
    read.value.receipts,
    read.value.notifications,
    after,
  );
  if (projected.isErr())
    return err<never, AuthorityError>({
      type: "authority_error",
      code: "projection",
      message: "Native history mapping failed",
    });
  const { session, afterId } = read.value;
  // Native entries are immutable; an older public append cannot extend this replica.
  if (projected.value.some((record) => Number(record.id.slice(session.id.length + 1)) <= afterId))
    return err<never, AuthorityError>({
      type: "authority_error",
      code: "projection",
      message: "Native history batch precedes public cursor",
    });
  const records = projected.value;
  const last = records.at(-1)?.id ?? after;
  const committed = await commitHistoryTransaction(query, {
    orbId,
    expectedCursor: after,
    session: read.value.session,
    records,
    nextCursor: last,
    nextHeadId: last,
  });
  return committed
    .map(() => undefined)
    .mapErr(
      (): AuthorityError => ({
        type: "authority_error",
        code: "projection",
        message: "Public history commit rejected",
      }),
    );
}
