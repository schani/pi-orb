import type { HistoryRecord } from "@pi-orb/protocol";
import { describe, expect, it } from "vitest";
import { decodeRecord, decodeSession, encodeRecord, encodeSession } from "./history-json.ts";

const record: HistoryRecord = {
  id: "record",
  parentId: null,
  timestamp: "2026-10-13T00:00:00.000Z",
  type: "message",
  role: "tool",
  content: [{ type: "text", text: "private payload" }],
  overflow: {},
};
const row = (value: unknown) => ({ record: value, record_id: record.id, parent_id: null });
const expected = { type: "store_error", code: "invariant", retryable: false };

describe("history JSON boundary", () => {
  it.each([
    "{private payload",
    "null",
    "[]",
    JSON.stringify({ ...record, role: "invalid" }),
    JSON.stringify({ ...record, id: "wrong" }),
    JSON.stringify({ ...record, parentId: "wrong" }),
    JSON.stringify({ ...record, overflow: null }),
  ])("rejects invalid persisted records without parser excerpts %j", (text) => {
    const decoded = decodeRecord(row(text));
    expect(decoded.isErr() && decoded.error).toEqual({
      ...expected,
      message: "invalid history_records.record for record",
    });
  });

  it.each([
    "{private payload",
    "null",
    "[]",
    JSON.stringify({ id: "wrong", overflow: {} }),
    JSON.stringify({ id: "session", overflow: null }),
  ])("rejects invalid headers without parser excerpts %j", (text) => {
    const decoded = decodeSession(text, "session", "orb");
    expect(decoded.isErr() && decoded.error).toEqual({
      ...expected,
      message: "invalid harness_session_header for orb",
    });
  });

  it("rejects mismatched null session pairs and accepts an empty replica", () => {
    expect(decodeSession(null, "session", "orb").isErr()).toBe(true);
    expect(decodeSession('{"id":"session","overflow":{}}', null, "orb").isErr()).toBe(true);
    expect(decodeSession(null, null, "orb")._unsafeUnwrap()).toBeNull();
    expect(encodeSession(null, null, "orb")._unsafeUnwrap()).toBeNull();
  });

  it("catches serialization failures at the adapter boundary", () => {
    const native: HistoryRecord["overflow"] = {};
    native["cycle"] = native;
    const encoded = encodeRecord({ ...record, overflow: native } as HistoryRecord);
    expect(encoded.isErr() && encoded.error).toEqual({
      ...expected,
      message: "invalid history_records.record for record",
    });
    const session = encodeSession({ id: "session", overflow: native }, "session", "orb");
    expect(session.isErr() && session.error).toEqual({
      ...expected,
      message: "invalid harness_session_header for orb",
    });
  });
});
