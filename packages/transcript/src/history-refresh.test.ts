import type { HistoryRecord, OrbHistoryView } from "@pi-orb/protocol";
import { describe, expect, it } from "vitest";
import { canRepairFromReplica, mergeReplicatedHistory } from "./history-refresh.ts";

function record(id: string, parentId: string | null): HistoryRecord {
  return {
    id,
    parentId,
    timestamp: `time-${id}`,
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: id }],
    overflow: {},
  };
}

function view(records: HistoryRecord[], cursor: string | null, headId = cursor): OrbHistoryView {
  return { orbId: "orb-1", session: null, records, cursor, headId };
}

describe("replicated history refresh", () => {
  it.each(["closed", "connecting", "open"] as const)(
    "running %s defers inbox gaps to initial live synchronization",
    (connection) => {
      expect(canRepairFromReplica("running", connection)).toBe(false);
    },
  );
  it("permits repair after transport failure and while non-running, but not through an open socket", () => {
    expect(canRepairFromReplica("running", "retrying")).toBe(true);
    expect(canRepairFromReplica("stopped", "closed")).toBe(true);
    expect(canRepairFromReplica("failed", "closed")).toBe(true);
    expect(canRepairFromReplica("stopped", "open")).toBe(false);
  });
  it("inserts the newly replicated prefix without discarding a newer live suffix", () => {
    const user = record("user", null);
    const assistant = record("assistant", "user");
    const merged = mergeReplicatedHistory(
      { records: [assistant], afterRecordId: "assistant", headId: "assistant" },
      view([user], "user"),
    );

    expect(merged.records.map((entry) => entry.id)).toEqual(["user", "assistant"]);
    expect(merged.afterRecordId).toBe("assistant");
    expect(merged.headId).toBe("assistant");
  });

  it("advances to the database cursor once replication covers the local tail", () => {
    const user = record("user", null);
    const merged = mergeReplicatedHistory(
      { records: [user], afterRecordId: "user", headId: "user" },
      view([user, record("assistant", "user")], "assistant"),
    );

    expect(merged.records.map((entry) => entry.id)).toEqual(["user", "assistant"]);
    expect(merged.afterRecordId).toBe("assistant");
    expect(merged.headId).toBe("assistant");
  });
});
