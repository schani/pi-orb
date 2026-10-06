import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type StorageWrite } from "@earendil-works/pi-durable";
import type { MessageInputBlock, OrbMessageSystem } from "@pi-orb/protocol";
import { err, ok, Result, ResultAsync } from "neverthrow";
import { jsonEqual } from "../../domain/json-equal.ts";
import { squashMessageBatch } from "../../domain/message-batch.ts";
import type { Query } from "../durable-pg/executor.ts";
import type { AuthorityError } from "../durable-pg/index.ts";
import { readTransactionStorage } from "../durable-pg/transaction-reader.ts";
import { arrayParam } from "../pg/client.ts";
import { nativeInputContent } from "./native-input.ts";

const rejected = (): AuthorityError => ({
  type: "authority_error",
  code: "projection",
  message: "Input admission changed",
});

/** Native/public publication holds the same orb lock as pending cancellation. */
export async function projectNativeInboxCommit(
  query: Query,
  orbId: string,
  writes: readonly StorageWrite[],
) {
  const submissions = writes.flatMap((write) =>
    write.type === "submission" &&
    write.value.type === "input" &&
    write.value.conversationId === ROOT_CONVERSATION_ID &&
    (write.value.status === "queued" ||
      write.value.status === "placed" ||
      (write.value.status === "unanswered" && write.value.entry === undefined)) &&
    /^inbox:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      write.value.requestId ?? "",
    )
      ? [write.value]
      : [],
  );
  if (submissions.length === 0) return ok(undefined);
  return ResultAsync.fromPromise(
    (async () => {
      const storage = await readTransactionStorage(query, orbId);
      try {
        const identityDocument = await storage.findDocument(
          {
            kind: "orb.identity",
            scope: { kind: "conversation", conversationId: ROOT_CONVERSATION_ID },
          },
          "current",
          BACKGROUND_CONTEXT,
        );
        const identity = identityDocument
          ? await storage.document(identityDocument.id, "current", BACKGROUND_CONTEXT)
          : undefined;
        const receipts = identity?.value.receipts;
        for (const submission of submissions) {
          const batchId = submission.requestId?.slice(6);
          if (batchId === undefined) return err(rejected());
          const receipt =
            receipts && typeof receipts === "object" && !Array.isArray(receipts)
              ? receipts[batchId]
              : undefined;
          const captured =
            receipt && typeof receipt === "object" && !Array.isArray(receipt) ? receipt : undefined;
          const ids = Array.isArray(captured?.messageIds)
            ? captured.messageIds.filter((id): id is string => typeof id === "string")
            : [batchId];
          if (ids.length === 0) continue;
          if (submission.status === "unanswered") {
            const outcome = await query(
              `UPDATE orb_messages SET status='failed',last_error=$4,auto_start=false,updated_at=now()
              WHERE orb_id=$1 AND message_id=ANY($2::uuid[]) AND delivery_batch_id=$3 AND status IN ('queued','delivering')`,
              [
                orbId,
                arrayParam(ids),
                batchId,
                submission.reason === "aborted"
                  ? "Cancelled after agent admission"
                  : "Agent input ended without an answer",
              ],
            );
            if (outcome.isErr()) return err(outcome.error);
            continue;
          }
          // Receipt finalization follows native admission; later placement must not re-admit it.
          if (captured?.submissionId === submission.id) continue;
          const rows = await query(
            "SELECT message_id,content,system,status,delivery_batch_id,operation_id FROM orb_messages WHERE orb_id=$1 AND message_id=ANY($2::uuid[]) ORDER BY ordinal FOR UPDATE",
            [orbId, arrayParam(ids)],
          );
          if (rows.isErr()) return err(rows.error);
          if (rows.value.rows.length === 0 && !captured) continue;
          if (
            rows.value.rows.length !== ids.length ||
            rows.value.rows.some(
              (row, index) =>
                row.message_id !== ids[index] ||
                !["queued", "delivering"].includes(String(row.status)) ||
                row.delivery_batch_id !== batchId ||
                row.operation_id !== null,
            )
          )
            return err(rejected());
          if (!captured || typeof captured.fingerprint !== "string") return err(rejected());
          const content = squashMessageBatch(
            rows.value.rows.map((row) => ({ content: row.content as MessageInputBlock[] })),
          );
          const system = rows.value.rows[0]?.system as OrbMessageSystem | null;
          if (rows.value.rows.some((row) => !jsonEqual(row.system, system))) return err(rejected());
          const fingerprint = Result.fromThrowable(
            () => JSON.parse(captured.fingerprint as string),
            rejected,
          )();
          if (
            fingerprint.isErr() ||
            !jsonEqual(fingerprint.value, { content, messageIds: ids, system })
          )
            return err(rejected());
          const native = nativeInputContent(content, system ?? undefined);
          if (submission.entry !== undefined) {
            const entry = await storage.entry(submission.entry, BACKGROUND_CONTEXT);
            if (!jsonEqual(entry?.entry.model?.[0]?.content, native)) return err(rejected());
          } else {
            const inboxDocument = await storage.findDocument(
              {
                kind: "pi.inbox",
                scope: { kind: "conversation", conversationId: ROOT_CONVERSATION_ID },
              },
              "current",
              BACKGROUND_CONTEXT,
            );
            const inbox = inboxDocument
              ? await storage.document(inboxDocument.id, "current", BACKGROUND_CONTEXT)
              : undefined;
            const item = Array.isArray(inbox?.value.items)
              ? inbox.value.items.find(
                  (item) =>
                    item &&
                    typeof item === "object" &&
                    !Array.isArray(item) &&
                    item.id === submission.id,
                )
              : undefined;
            if (
              !item ||
              typeof item !== "object" ||
              Array.isArray(item) ||
              !jsonEqual(item.content, native)
            )
              return err(rejected());
          }
        }
        return ok(undefined);
      } finally {
        await storage.close(BACKGROUND_CONTEXT);
      }
    })(),
    rejected,
  ).andThen((result) => result);
}
