import type { HistoryRecord, OrbMessageView } from "@pi-orb/protocol";
import { describe, expect, it, vi } from "vitest";
import { history } from "../testkit/transcript.ts";
import { DevConsoleDebug, installDevConsoleDebug } from "./dev-console-debug.ts";

function message(id: string): OrbMessageView {
  return {
    id,
    orbId: "orb",
    content: [{ type: "text", text: "must not leak" }],
    status: "delivered",
    createdAt: "now",
    updatedAt: "now",
  };
}

describe("DevConsoleDebug", () => {
  it("installs an idempotent read-only public API", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const target = {} as Window;
      installDevConsoleDebug(target);
      const api = target.piOrbDebug;
      installDevConsoleDebug(target);
      expect(log).toHaveBeenCalledTimes(1);
      expect(target.piOrbDebug).toBe(api);
      expect(Object.isFrozen(api)).toBe(true);
      expect(Object.getOwnPropertyDescriptor(target, "piOrbDebug")).toMatchObject({
        configurable: false,
        writable: false,
      });
      const dump = api.dump();
      expect(JSON.parse(JSON.stringify(dump))).toEqual(dump);
    } finally {
      log.mockRestore();
    }
  });

  it("bounds and strictly projects trace metadata", () => {
    const debug = new DevConsoleDebug();
    for (let i = 0; i < 205; i += 1) {
      debug.record({
        event: "frame_rejected",
        outcome: "schema_invalid",
        recordId: `record-${i}`,
        ...({
          content: "secret body",
          token: "secret token",
          url: "https://x/?auth=secret",
        } as object),
      });
    }
    const dump = debug.dump();
    expect(dump.trace).toHaveLength(200);
    expect(dump.traceDropped).toBe(5);
    expect(dump.trace[0]?.recordId).toBe("record-5");
    expect(JSON.stringify(dump)).not.toContain("secret");
  });

  it("returns detached dumps and scans current order and inbox evidence on demand", () => {
    const debug = new DevConsoleDebug();
    const records = history("orb", ["first", "second"]).records;
    const second = records[1] ?? expect.fail("second record missing");
    if (second.type !== "message") expect.fail("message record expected");
    const broken: HistoryRecord = {
      ...second,
      parentId: "missing",
      inboxMessageIds: ["matched"],
    };
    const current = {
      orbId: "orb",
      sessionId: "session",
      records: new Map(records.map((record, index) => [record.id, index === 1 ? broken : record])),
      afterRecordId: "second",
      headId: "absent-head",
      synced: true,
      connection: "open",
      queuedMessages: [message("matched"), message("unmatched")],
    };
    debug.ownCurrent(() => current);

    const first = debug.dump();
    expect(first.current?.anomalies.missingOrOutOfOrderParents).toEqual([
      { recordId: "second", parentId: "missing", index: 1 },
    ]);
    expect(first.current?.anomalies.headPresent).toBe(false);
    expect(first.current?.unmatchedInbox).toEqual([{ id: "unmatched", status: "delivered" }]);
    const detachedInbox = first.current?.unmatchedInbox as { id: string }[] | undefined;
    const detachedEntry = detachedInbox?.[0] ?? expect.fail("unmatched entry missing");
    detachedEntry.id = "changed";
    expect(debug.dump().current?.unmatchedInbox[0]?.id).toBe("unmatched");
    expect(JSON.stringify(first)).not.toContain("must not leak");
  });

  it("lets only the current owner clear the snapshot provider", () => {
    const debug = new DevConsoleDebug();
    const base = history("old");
    const oldCleanup = debug.ownCurrent(() => ({
      orbId: "old",
      sessionId: "session",
      records: new Map(base.records.map((record) => [record.id, record])),
      afterRecordId: base.cursor,
      headId: base.headId,
      synced: true,
      connection: "open",
      queuedMessages: [],
    }));
    const next = history("new");
    const newCleanup = debug.ownCurrent(() => ({
      orbId: "new",
      sessionId: "session",
      records: new Map(next.records.map((record) => [record.id, record])),
      afterRecordId: next.cursor,
      headId: next.headId,
      synced: false,
      connection: "connecting",
      queuedMessages: [],
    }));
    oldCleanup();
    expect(debug.dump().current?.orbId).toBe("new");
    newCleanup();
    expect(debug.dump().current).toBeNull();
  });
});
