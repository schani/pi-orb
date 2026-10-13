import type { HarnessSessionMetadata, HistoryRecord } from "@pi-orb/protocol";
import { err, ok, Result } from "neverthrow";
import type { StoreError } from "../../domain/errors.ts";
import type { PgRow } from "./client.ts";

const invalid = (column: string, id: unknown): StoreError => ({
  type: "store_error",
  code: "invariant",
  message: `invalid ${column} for ${String(id)}`,
  retryable: false,
});
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** SQL checks object syntax; authority readers check the duplicated identities. */
export function validateSession(
  value: unknown,
  sessionId: unknown,
  orbId: unknown,
): Result<HarnessSessionMetadata | null, StoreError> {
  if (value == null && sessionId == null) return ok(null);
  return object(value) && typeof sessionId === "string" && value["id"] === sessionId
    ? ok(value as unknown as HarnessSessionMetadata)
    : err(invalid("harness_session_header", orbId));
}

export function validateRecord(row: PgRow): Result<HistoryRecord, StoreError> {
  const value = row["record"];
  return object(value) &&
    typeof row["record_id"] === "string" &&
    value["id"] === row["record_id"] &&
    value["parentId"] === row["parent_id"]
    ? ok(value as unknown as HistoryRecord)
    : err(invalid("history_records.record", row["record_id"]));
}

const serialize = (value: unknown, column: string, id: unknown) =>
  Result.fromThrowable(
    () => {
      const text = JSON.stringify(value);
      return { text, value: JSON.parse(text) as unknown };
    },
    () => invalid(column, id),
  )();

export function encodeRecord(record: HistoryRecord) {
  return serialize(record, "history_records.record", record.id).andThen((encoded) =>
    validateRecord({ record: encoded.value, record_id: record.id, parent_id: record.parentId }).map(
      (value) => ({ text: encoded.text, value }),
    ),
  );
}

export function encodeSession(
  session: HarnessSessionMetadata | null,
  sessionId: string | null,
  orbId: string,
) {
  if (session === null && sessionId === null) return ok(null);
  return serialize(session, "harness_session_header", orbId).andThen((encoded) =>
    validateSession(encoded.value, sessionId, orbId).map((value) => ({
      text: encoded.text,
      value,
    })),
  );
}
