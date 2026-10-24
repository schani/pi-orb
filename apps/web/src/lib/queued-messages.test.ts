import type { HistoryRecord, OrbMessageStatus, OrbMessageView } from "@pi-orb/protocol";
import { describe, expect, it } from "vitest";
import { displayRecord } from "../testkit/display-fixtures.ts";
import {
  createMutationEpoch,
  hasDeliveredMessageAwaitingHistory,
  messagesAwaitingHistory,
  reuseQueuedMessages,
  withQueuedMessage,
} from "./queued-messages.ts";

const message = (id: string, status: OrbMessageStatus): OrbMessageView => ({
  id,
  orbId: "orb-1",
  content: [{ type: "text", text: id }],
  status,
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z",
});

describe("queued message mutation epoch", () => {
  it("reports a read stale only once a mutation commits", () => {
    const epoch = createMutationEpoch();
    const token = epoch.begin();
    expect(epoch.isStale(token)).toBe(false);
    epoch.commit();
    expect(epoch.isStale(token)).toBe(true);
    expect(epoch.isStale(epoch.begin())).toBe(false);
  });

  it("keeps older in-flight reads stale after further mutations", () => {
    const epoch = createMutationEpoch();
    const first = epoch.begin();
    epoch.commit();
    const second = epoch.begin();
    epoch.commit();
    expect(epoch.isStale(first)).toBe(true);
    expect(epoch.isStale(second)).toBe(true);
  });
});

describe("queued message list updates", () => {
  it("keeps a delivered message provisional until its history record is locally visible", () => {
    expect(
      messagesAwaitingHistory(
        [
          message("a", "delivered"),
          message("b", "queued"),
          message("c", "delivering"),
          message("d", "failed"),
        ],
        [],
      ).map((entry) => entry.id),
    ).toEqual(["a", "b", "c", "d"]);
  });

  it("retires a delivered provisional only when history names its inbox identity", () => {
    const delivered = message("a", "delivered");
    const represented: HistoryRecord = {
      id: "record-a",
      parentId: null,
      timestamp: "2026-08-10T00:00:01.000Z",
      type: "message",
      role: "user",
      content: delivered.content,
      inboxMessageIds: [delivered.id],
      overflow: {},
    };

    const receipt = displayRecord({
      id: "receipt",
      parentId: null,
      timestamp: delivered.updatedAt,
      overflow: {},
      type: "event",
      eventType: "claude.input_receipt",
      inboxMessageIds: [delivered.id],
    });
    expect(messagesAwaitingHistory([delivered], [receipt])).toEqual([delivered]);
    expect(hasDeliveredMessageAwaitingHistory([delivered], [receipt])).toBe(false);
    expect(hasDeliveredMessageAwaitingHistory([message("other", "delivered")], [receipt])).toBe(
      true,
    );
    expect(messagesAwaitingHistory([delivered], [receipt, displayRecord(represented)])).toEqual([]);
    expect(messagesAwaitingHistory([delivered], [])).toEqual([delivered]);
    expect(hasDeliveredMessageAwaitingHistory([delivered], [])).toBe(true);
    expect(messagesAwaitingHistory([delivered], [displayRecord(represented)])).toEqual([]);
    expect(hasDeliveredMessageAwaitingHistory([delivered], [displayRecord(represented)])).toBe(
      false,
    );
  });

  it("retires a delivered system notice when an event names its inbox identity", () => {
    const delivered: OrbMessageView = {
      ...message("sleep-1", "delivered"),
      system: { kind: "sleep_wake", sleepUntil: "2026-09-17T01:00:00.000Z" },
    };
    const represented: HistoryRecord = {
      id: "event-sleep-1",
      parentId: null,
      timestamp: "2026-09-17T01:00:01.000Z",
      type: "event",
      eventType: "custom",
      content: delivered.content,
      inboxMessageIds: [delivered.id],
      custom: { customType: "pi-orb.sleep-wake", display: true },
      overflow: {},
    };

    expect(messagesAwaitingHistory([delivered], [])).toEqual([delivered]);
    expect(hasDeliveredMessageAwaitingHistory([delivered], [])).toBe(true);
    expect(messagesAwaitingHistory([delivered], [displayRecord(represented)])).toEqual([]);
    expect(hasDeliveredMessageAwaitingHistory([delivered], [displayRecord(represented)])).toBe(
      false,
    );
    const peer: HistoryRecord = {
      ...represented,
      eventType: "orb.message",
      sender: { orbId: "629e53de-a2c9-4f1b-87a6-437fd415e8de" },
    };
    expect(messagesAwaitingHistory([delivered], [displayRecord(peer)])).toEqual([]);
    expect(
      messagesAwaitingHistory(
        [delivered],
        [displayRecord({ ...peer, inboxMessageIds: ["unrelated"] })],
      ),
    ).toEqual([delivered]);
  });

  it("does not read inbox identity from native overflow", () => {
    const delivered = message("a", "delivered");
    const legacy: HistoryRecord = {
      id: "record-a",
      parentId: null,
      timestamp: "2026-08-10T00:00:01.000Z",
      type: "message",
      role: "user",
      content: delivered.content,
      overflow: {
        native: {
          type: "custom_message",
          customType: "pi-orb.user-message",
          details: { messageIds: [delivered.id] },
        },
      },
    };

    expect(messagesAwaitingHistory([delivered], [displayRecord(legacy)])).toEqual([delivered]);
  });

  it("reuses an unchanged polled list and updates changed message metadata", () => {
    const current = [message("a", "delivered")];
    const unchanged = reuseQueuedMessages(current, [message("a", "delivered")]);
    expect(unchanged).toBe(current);
    expect(unchanged[0]).toBe(current[0]);

    const rich: OrbMessageView = {
      ...message("system", "delivered"),
      content: [{ type: "image", mediaType: "image/png", data: "aW1hZ2U=" }],
      system: { kind: "sleep_wake", sleepUntil: "2026-08-10T01:00:00.000Z" },
    };
    expect(
      reuseQueuedMessages(
        [rich],
        [
          {
            ...rich,
            content: [{ type: "image", mediaType: "image/png", data: "aW1hZ2U=" }],
            system: { kind: "sleep_wake", sleepUntil: "2026-08-10T01:00:00.000Z" },
          },
        ],
      )[0],
    ).toBe(rich);

    const changed = reuseQueuedMessages(current, [message("a", "failed")]);
    expect(changed).not.toBe(current);
    expect(changed[0]?.status).toBe("failed");
  });

  it("appends an unobserved enqueue acknowledgement", () => {
    const queued = withQueuedMessage([message("a", "queued")], message("b", "queued"));
    expect(queued.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("preserves an already-observed row's position on enqueue acknowledgement", () => {
    const observed = [message("a", "queued"), message("b", "queued")];
    const updated = withQueuedMessage(observed, message("a", "queued"));
    expect(updated.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(updated[0]).toBe(observed[0]);
  });

  it("does not replace authoritative delivery metadata with a late enqueue acknowledgement", () => {
    const delivered: OrbMessageView = {
      ...message("a", "delivered"),
      delivery: "steer",
      operationId: "operation-a",
      updatedAt: "2026-08-10T00:00:01.000Z",
    };
    const updated = withQueuedMessage([delivered], message("a", "queued"));
    expect(updated[0]).toBe(delivered);
  });
});
