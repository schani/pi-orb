import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type Cursor,
  type EntryRecord,
  ROOT_CONVERSATION_ID,
  StorageRejected,
} from "@earendil-works/pi-durable";
import { err, ok, ResultAsync } from "neverthrow";
import type { RuntimeClientError } from "../../domain/errors.ts";
import type { Query } from "../durable-pg/executor.ts";
import type { AuthorityError } from "../durable-pg/index.ts";
import { storageAuthorityError } from "../durable-pg/storage-boundary.ts";
import { readTransactionStorage } from "../durable-pg/transaction-reader.ts";
import { projectHistory } from "./projection.ts";

export const legacyBackendMessage =
  "This orb uses the old Pi backend. Create a new orb to continue.";
const integrity = (): AuthorityError => ({
  type: "authority_error",
  code: "history_integrity",
  message: "This orb's Pi history is inconsistent. Agent startup was rejected.",
});
export function startupRuntimeError(error: AuthorityError): RuntimeClientError {
  return {
    type: "runtime_client_error",
    code:
      error.code === "legacy_backend" || error.code === "history_integrity"
        ? error.code
        : "history_unavailable",
    answered: true,
    retryable: error.code !== "legacy_backend" && error.code !== "history_integrity",
    message: error.message,
  };
}

/** Caller holds the orb/owner fence. Mutation checks never scan transcript entries. */
export async function checkNativeStartup(query: Query, orbId: string, validateCursor = false) {
  const publicState = await query(
    "SELECT state,harness_session_id,harness_session_header,replication_cursor,replicated_head_id, EXISTS(SELECT 1 FROM history_records WHERE orb_id=$1) AS has_history FROM orbs WHERE id=$1",
    [orbId],
  );
  if (publicState.isErr()) return err(publicState.error);
  const row = publicState.value.rows[0];
  if (!row)
    return err<never, AuthorityError>({
      type: "authority_error",
      code: "missing",
      message: "Orb does not exist",
    });
  if (row.state === "archived" || row.state === "archiving" || row.state === "deleting")
    return err<never, AuthorityError>({
      type: "authority_error",
      code: "closed",
      message: "Agent authority is closed",
    });
  const session = row.harness_session_id;
  const header = row.harness_session_header;
  if (
    (session == null) !== (header == null) ||
    (header != null &&
      (typeof header !== "object" ||
        Array.isArray(header) ||
        !("id" in header) ||
        header.id !== session))
  )
    return err(integrity());
  const documents = await query(
    "SELECT id FROM durable_pg_documents WHERE orb_id=$1 AND kind=$2 AND scope_kind='conversation' AND owner_id=$3 AND family=0 AND key_value=$4 AND retired_at IS NULL LIMIT 2",
    [orbId, JSON.stringify("orb.identity"), ROOT_CONVERSATION_ID, JSON.stringify("")],
  );
  if (documents.isErr()) return err(documents.error);
  if (documents.value.rows.length > 1) return err(integrity());
  const identityId = documents.value.rows[0]?.id;
  if (identityId === undefined) {
    if (session != null && session !== `conversation:${orbId}`)
      return err<never, AuthorityError>({
        type: "authority_error",
        code: "legacy_backend",
        message: legacyBackendMessage,
      });
    return row.replication_cursor != null || row.replicated_head_id != null || row.has_history
      ? err(integrity())
      : ok(undefined);
  }
  const native = await ResultAsync.fromPromise(
    (async () => {
      const storage = await readTransactionStorage(query, orbId);
      try {
        const document = await storage.document(
          Number(identityId) as Parameters<typeof storage.document>[0],
          "current",
          BACKGROUND_CONTEXT,
        );
        if (
          !document ||
          document.version !== 1 ||
          typeof document.value.sessionId !== "string" ||
          document.value.sessionId.length === 0 ||
          typeof document.value.timestamp !== "number" ||
          !Number.isFinite(document.value.timestamp)
        )
          return err(integrity());
        if (
          document.record.kind !== "orb.identity" ||
          document.record.key !== undefined ||
          document.record.scope.kind !== "conversation" ||
          document.record.scope.conversationId !== ROOT_CONVERSATION_ID
        )
          return err(integrity());
        const nativeSession = document.value.sessionId;
        if (session != null && session !== nativeSession) return err(integrity());
        if (
          session == null &&
          (row.replication_cursor != null || row.replicated_head_id != null || row.has_history)
        )
          return err(integrity());
        if (row.replication_cursor == null && (row.replicated_head_id != null || row.has_history))
          return err(integrity());
        if (validateCursor && row.replication_cursor != null) {
          const entries: EntryRecord[] = [];
          let cursor: Cursor | undefined;
          do {
            const page = await storage.scanEntries(
              { conversationId: ROOT_CONVERSATION_ID },
              500,
              cursor,
              BACKGROUND_CONTEXT,
            );
            entries.push(...page.items);
            cursor = page.next;
          } while (cursor);
          entries.sort((a, b) => a.id - b.id);
          const projected = projectHistory(entries, nativeSession);
          if (
            projected.isErr() ||
            !projected.value.some((record) => record.id === row.replication_cursor) ||
            (row.replicated_head_id != null &&
              !projected.value.some((record) => record.id === row.replicated_head_id))
          )
            return err(integrity());
        }
        return ok(undefined);
      } finally {
        await storage.close(BACKGROUND_CONTEXT);
      }
    })(),
    (error): AuthorityError => {
      const typed = storageAuthorityError(error);
      if (typed) return typed;
      if (
        error instanceof SyntaxError ||
        (error instanceof StorageRejected && error.cause === undefined)
      )
        return integrity();
      return {
        type: "authority_error",
        code: "unavailable",
        message: "Native startup evidence unavailable",
      };
    },
  );
  return native.isErr() ? err(native.error) : native.value;
}
