import {
  type HarnessSessionMetadata,
  HarnessSessionMetadataSchema,
  type HistoryRecord,
  HistoryRecordSchema,
} from "@pi-orb/protocol";
import { err, ok, Result } from "neverthrow";
import { Check } from "typebox/value";
import type { StoreError } from "../../domain/errors.ts";
import type { PgRow } from "./client.ts";

const invalid = (column: string, id: unknown): StoreError => ({
  type: "store_error",
  code: "invariant",
  message: `invalid ${column} for ${String(id)}`,
  retryable: false,
});

function decode(text: unknown, column: string, id: unknown): Result<unknown, StoreError> {
  if (typeof text !== "string") return err(invalid(column, id));
  return Result.fromThrowable(
    () => JSON.parse(text) as unknown,
    () => invalid(column, id),
  )();
}

/** SQL checks object syntax; authority readers additionally check schema and identity. */
export function decodeStoredSession(
  text: unknown,
  orbId: unknown,
): Result<HarnessSessionMetadata | null, StoreError> {
  if (text == null) return ok(null);
  return decode(text, "harness_session_header", orbId).map(
    (value) => value as HarnessSessionMetadata,
  );
}

export function decodeSession(
  text: unknown,
  sessionId: unknown,
  orbId: unknown,
): Result<HarnessSessionMetadata | null, StoreError> {
  if (text == null && sessionId == null) return ok(null);
  return decode(text, "harness_session_header", orbId).andThen((value) =>
    Check(HarnessSessionMetadataSchema, value) && value.id === sessionId
      ? ok(value)
      : err(invalid("harness_session_header", orbId)),
  );
}

export function decodeRecord(row: PgRow): Result<HistoryRecord, StoreError> {
  return decode(row["record"], "history_records.record", row["record_id"]).andThen((value) =>
    Check(HistoryRecordSchema, value) &&
    value.id === row["record_id"] &&
    value.parentId === row["parent_id"]
      ? ok(value)
      : err(invalid("history_records.record", row["record_id"])),
  );
}

export function encodeRecord(record: HistoryRecord): Result<string, StoreError> {
  return serialize(record, "history_records.record", record.id).andThen((text) =>
    decodeRecord({ record: text, record_id: record.id, parent_id: record.parentId }).map(
      () => text,
    ),
  );
}

export function encodeSession(
  session: HarnessSessionMetadata | null,
  sessionId: string | null,
  orbId: string,
): Result<string | null, StoreError> {
  if (session === null && sessionId === null) return ok(null);
  return serialize(session, "harness_session_header", orbId).andThen((text) =>
    decodeSession(text, sessionId, orbId).map(() => text),
  );
}

const serialize = (value: unknown, column: string, id: unknown): Result<string, StoreError> =>
  Result.fromThrowable(
    () => JSON.stringify(value),
    () => invalid(column, id),
  )().andThen((text) => (typeof text === "string" ? ok(text) : err(invalid(column, id))));
