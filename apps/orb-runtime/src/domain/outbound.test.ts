import type { ServerFrame } from "@pi-orb/protocol";
import { describe, expect, it } from "vitest";
import { type FrameSink, OutboundWriter } from "./outbound.ts";

class FakeSink implements FrameSink {
  sent: ServerFrame[] = [];
  closedWith: { code: number; reason: string } | null = null;
  bufferedAmount = 0;

  send(json: string): void {
    this.sent.push(JSON.parse(json) as ServerFrame);
  }

  close(code: number, reason: string): void {
    this.closedWith = { code, reason };
  }
}

const at = "2026-07-20T10:00:00.000Z";

const historyFrame = (id: string): ServerFrame => ({
  v: 1,
  type: "history.record",
  at,
  record: {
    id,
    parentId: null,
    timestamp: "t",
    overflow: { native: {} },
    type: "message",
    role: "user",
    content: [{ type: "text", text: "x".repeat(200) }],
  },
  headId: id,
});

const patchFrame = (
  blockId: string,
  revision: number,
  text: string,
  kind: "append" | "replace" = "append",
): ServerFrame => ({
  v: 1,
  type: "runtime.event",
  at,
  event: {
    type: "output_patch",
    operationId: "op-1",
    blockId,
    blockType: "text",
    revision,
    patch: { type: kind, text },
  },
});

const statusFrame = (activity: "idle" | "busy"): ServerFrame => ({
  v: 1,
  type: "runtime.event",
  at,
  event: { type: "status", activity },
});

describe("OutboundWriter", () => {
  it("sends the sync batch synchronously regardless of size (budget exemption)", () => {
    const sink = new FakeSink();
    sink.bufferedAmount = 10_000_000; // heavily backpressured socket
    const writer = new OutboundWriter(sink, {
      maxCriticalBufferedBytes: 1_000,
      highWaterMark: 100,
    });
    const batch: ServerFrame[] = [];
    for (let i = 0; i < 100; i++) batch.push(historyFrame(`rec-${i}`));
    writer.enqueueSyncBatch(batch);
    expect(sink.sent).toHaveLength(100);
    expect(sink.closedWith).toBeNull();
  });

  it("sends directly while the socket is writable", () => {
    const sink = new FakeSink();
    const writer = new OutboundWriter(sink, {
      maxCriticalBufferedBytes: 1_000,
      highWaterMark: 10_000,
    });
    writer.enqueueSyncBatch([]);
    writer.enqueue(historyFrame("rec-1"));
    writer.enqueue(statusFrame("busy"));
    expect(sink.sent).toHaveLength(2);
  });

  it("queues under backpressure and flushes in order on drain", () => {
    const sink = new FakeSink();
    const writer = new OutboundWriter(sink, {
      maxCriticalBufferedBytes: 10_000,
      highWaterMark: 100,
    });
    writer.enqueueSyncBatch([]);
    sink.bufferedAmount = 1_000; // busy socket
    writer.enqueue(historyFrame("rec-1"));
    writer.enqueue(historyFrame("rec-2"));
    expect(sink.sent).toHaveLength(0);
    sink.bufferedAmount = 0;
    writer.onDrain();
    expect(
      sink.sent.map((frame) => (frame.type === "history.record" ? frame.record.id : "?")),
    ).toEqual(["rec-1", "rec-2"]);
  });

  it("coalesces queued transient output patches to their newest state", () => {
    const sink = new FakeSink();
    const writer = new OutboundWriter(sink, {
      maxCriticalBufferedBytes: 10_000,
      highWaterMark: 100,
    });
    writer.enqueueSyncBatch([]);
    sink.bufferedAmount = 1_000;
    writer.enqueue(patchFrame("b1", 1, "hello "));
    writer.enqueue(patchFrame("b1", 2, "world"));
    writer.enqueue(patchFrame("b1", 3, "hello world and more", "replace"));
    writer.enqueue(statusFrame("busy"));
    writer.enqueue(statusFrame("idle"));
    sink.bufferedAmount = 0;
    writer.onDrain();
    // One coalesced patch (newest replace) and one status (newest).
    const events = sink.sent
      .filter((frame) => frame.type === "runtime.event")
      .map((frame) => (frame.type === "runtime.event" ? frame.event : null));
    expect(events).toEqual([
      {
        type: "output_patch",
        operationId: "op-1",
        blockId: "b1",
        blockType: "text",
        revision: 3,
        patch: { type: "replace", text: "hello world and more" },
      },
      { type: "status", activity: "idle" },
    ]);
  });

  it("merges consecutive append patches for the same block", () => {
    const sink = new FakeSink();
    const writer = new OutboundWriter(sink, {
      maxCriticalBufferedBytes: 10_000,
      highWaterMark: 100,
    });
    writer.enqueueSyncBatch([]);
    sink.bufferedAmount = 1_000;
    writer.enqueue(patchFrame("b1", 1, "hello "));
    writer.enqueue(patchFrame("b1", 2, "world"));
    sink.bufferedAmount = 0;
    writer.onDrain();
    const events = sink.sent
      .filter((frame) => frame.type === "runtime.event")
      .map((frame) => (frame.type === "runtime.event" ? frame.event : null));
    expect(events).toEqual([
      {
        type: "output_patch",
        operationId: "op-1",
        blockId: "b1",
        blockType: "text",
        revision: 2,
        patch: { type: "append", text: "hello world" },
      },
    ]);
  });

  it("closes the connection when queued critical frames exceed the budget", () => {
    const sink = new FakeSink();
    const writer = new OutboundWriter(sink, { maxCriticalBufferedBytes: 500, highWaterMark: 100 });
    writer.enqueueSyncBatch([]);
    sink.bufferedAmount = 1_000;
    writer.enqueue(historyFrame("rec-1")); // ~300 bytes serialized
    expect(sink.closedWith).toBeNull();
    writer.enqueue(historyFrame("rec-2"));
    expect(sink.closedWith).not.toBeNull();
  });

  it("never drops critical frames through coalescing", () => {
    const sink = new FakeSink();
    const writer = new OutboundWriter(sink, {
      maxCriticalBufferedBytes: 100_000,
      highWaterMark: 100,
    });
    writer.enqueueSyncBatch([]);
    sink.bufferedAmount = 1_000;
    writer.enqueue(historyFrame("rec-1"));
    writer.enqueue(historyFrame("rec-2"));
    writer.enqueue(patchFrame("b1", 1, "x"));
    writer.enqueue(historyFrame("rec-3"));
    sink.bufferedAmount = 0;
    writer.onDrain();
    const recordIds = sink.sent
      .filter((frame) => frame.type === "history.record")
      .map((frame) => (frame.type === "history.record" ? frame.record.id : "?"));
    expect(recordIds).toEqual(["rec-1", "rec-2", "rec-3"]);
  });

  it("ignores frames after close", () => {
    const sink = new FakeSink();
    const writer = new OutboundWriter(sink, { maxCriticalBufferedBytes: 100, highWaterMark: 100 });
    writer.enqueueSyncBatch([]);
    sink.bufferedAmount = 1_000;
    writer.enqueue(historyFrame("rec-1"));
    expect(sink.closedWith).not.toBeNull();
    const sentBefore = sink.sent.length;
    writer.enqueue(historyFrame("rec-2"));
    sink.bufferedAmount = 0;
    writer.onDrain();
    expect(sink.sent.length).toBe(sentBefore);
  });
});
