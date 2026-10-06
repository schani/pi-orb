import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Cursor, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { okAsync, ResultAsync } from "neverthrow";
import type { StoreError } from "../../domain/errors.ts";
import type { Query } from "./executor.ts";
import { readTransactionStorage } from "./transaction-reader.ts";

/** Caller holds the orb lock shared with native admission. Identity alone is not admission. */
export function hasNativeInboxAdmission(query: Query, orbId: string, messageId: string) {
  return query("SELECT orb_id FROM durable_pg_durable_metadata WHERE orb_id=$1", [orbId]).andThen(
    (result) =>
      result.rows.length === 0
        ? okAsync(false)
        : ResultAsync.fromPromise(
            (async () => {
              const storage = await readTransactionStorage(query, orbId);
              try {
                const document = await storage.findDocument(
                  {
                    kind: "orb.identity",
                    scope: { kind: "conversation", conversationId: ROOT_CONVERSATION_ID },
                  },
                  "current",
                  BACKGROUND_CONTEXT,
                );
                const identity = document
                  ? await storage.document(document.id, "current", BACKGROUND_CONTEXT)
                  : undefined;
                const receipts = identity?.value.receipts;
                let cursor: Cursor | undefined;
                do {
                  const page = await storage.scanSubmissions(
                    { conversationId: ROOT_CONVERSATION_ID },
                    256,
                    cursor,
                    BACKGROUND_CONTEXT,
                  );
                  for (const submission of page.items) {
                    if (submission.type !== "input" || !submission.requestId?.startsWith("inbox:"))
                      continue;
                    const batch = submission.requestId.slice(6);
                    if (batch === messageId) return true;
                    const receipt =
                      receipts && typeof receipts === "object" && !Array.isArray(receipts)
                        ? receipts[batch]
                        : undefined;
                    if (
                      receipt &&
                      typeof receipt === "object" &&
                      !Array.isArray(receipt) &&
                      Array.isArray(receipt.messageIds) &&
                      receipt.messageIds.includes(messageId)
                    )
                      return true;
                  }
                  cursor = page.next;
                } while (cursor);
                return false;
              } finally {
                await storage.close(BACKGROUND_CONTEXT);
              }
            })(),
            (): StoreError => ({
              type: "store_error",
              code: "unavailable",
              retryable: true,
              message: "Native input admission read failed",
            }),
          ),
  );
}
