import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type Cursor,
  type EntryRecord,
  ROOT_CONVERSATION_ID,
  StorageRejected,
  type StorageWrite,
} from "@earendil-works/pi-durable";
import { err, ok, okAsync, ResultAsync } from "neverthrow";
import { executor, type Query } from "../durable-pg/executor.ts";
import type { AuthorityError } from "../durable-pg/index.ts";
import { PgStorage } from "../durable-pg/storage.ts";
import { arrayParam } from "../pg/client.ts";
import { commitHistoryTransaction } from "../pg/store.ts";
import { projectNativeInboxCommit } from "./inbox-admission.ts";
import { type PublicEntryReceipt, projectHistory } from "./projection.ts";

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

/** Reads through the caller's native commit transaction, never through live Harness state. */
export async function projectNativeCommit(
  query: Query,
  orbId: string,
  writes?: readonly StorageWrite[],
) {
  if (writes) {
    const admitted = await projectNativeInboxCommit(query, orbId, writes);
    if (admitted.isErr()) return err(admitted.error);
    const dirty = await hasPublicHistoryWrites(query, orbId, writes);
    if (dirty.isErr()) return err(dirty.error);
    if (!dirty.value) return ok(undefined);
  }
  const read = await ResultAsync.fromPromise(
    (async () => {
      const sql = executor(query, orbId);
      const storage = await PgStorage.open({
        ...sql,
        close: async () => undefined,
        mintId: async () => Promise.reject(new StorageRejected("Projection is read-only")),
        transaction: (callback) => callback(sql),
        project: async () => Promise.reject(new StorageRejected("Projection is read-only")),
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
        let cursor: Cursor | undefined;
        do {
          const page = await storage.scanSubmissions(
            { conversationId: root.id },
            500,
            cursor,
            BACKGROUND_CONTEXT,
          );
          for (const submission of page.items) {
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
              ...(system &&
              typeof system === "object" &&
              !Array.isArray(system) &&
              typeof system.kind === "string"
                ? { system: { kind: system.kind } }
                : {}),
            });
          }
          cursor = page.next;
        } while (cursor);
        const entries: EntryRecord[] = [];
        cursor = undefined;
        do {
          const page = await storage.scanEntries(
            { conversationId: root.id },
            500,
            cursor,
            BACKGROUND_CONTEXT,
          );
          entries.push(...page.items);
          cursor = page.next;
        } while (cursor);
        entries.sort((a, b) => a.id - b.id);
        return {
          session: {
            id: value.sessionId,
            timestamp: new Date(value.timestamp).toISOString(),
            overflow: { harness: "pi-durable" },
          },
          entries,
          receipts,
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
  const projected = projectHistory(read.value.entries, read.value.session.id, read.value.receipts);
  if (projected.isErr())
    return err<never, AuthorityError>({
      type: "authority_error",
      code: "projection",
      message: "Native history mapping failed",
    });
  const cursor = await query("SELECT replication_cursor FROM orbs WHERE id=$1 FOR UPDATE", [orbId]);
  if (cursor.isErr()) return err(cursor.error);
  const stored = cursor.value.rows[0]?.replication_cursor;
  const after = stored == null ? null : String(stored);
  const index = after === null ? -1 : projected.value.findIndex((record) => record.id === after);
  if (after !== null && index < 0)
    return err<never, AuthorityError>({
      type: "authority_error",
      code: "projection",
      message: "Public cursor absent from native history",
    });
  const records = projected.value.slice(index + 1);
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
