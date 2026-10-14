import {
  type ClientFrame,
  type HistoryRecord,
  projectDisplayRecord,
  type ServerFrame,
} from "@pi-orb/protocol";
import type { Deadline } from "determined";
import { expect, it, vi } from "vitest";
import { OutboundWriter } from "../../../orb-runtime/src/domain/outbound.ts";
import { computeSyncFrames } from "../../../orb-runtime/src/domain/sync.ts";
import type { HarnessSnapshot, LiveOperationView } from "../../../orb-runtime/src/domain/types.ts";
import { runDst } from "../../../orb-runtime/src/testkit/sim.ts";
import { openLiveConnection } from "../lib/live.ts";
import { TranscriptCache } from "../lib/transcript-cache.ts";
import { history } from "../testkit/transcript.ts";
import { initialState, reducer } from "./OrbPage.tsx";

it("DST: writer overflow recovers canonical history and fences retired socket callbacks", async () => {
  await runDst({ name: "outbound-recovery", iterations: 36 }, async (sim) => {
    const records: HistoryRecord[] = ["one", "two", "assistant-a", "assistant-b"].map(
      (id, index, ids) => ({
        id,
        parentId: ids[index - 1] ?? null,
        timestamp: "now",
        type: "message",
        role: index === 1 ? "user" : "assistant",
        content: [{ type: "text", text: id === "assistant-b" ? "final ".repeat(100) : id }],
        overflow: {},
      }),
    );
    let canonical: HarnessSnapshot = {
      orbId: "a",
      runtimeInstanceId: "runtime",
      session: { id: "session", overflow: {} },
      activity: "busy",
      records: records.slice(0, 2),
      headId: "two",
    };
    let liveView: LiveOperationView | null = {
      operationId: "op",
      blocks: [
        { blockId: "retired", blockType: "text", contentIndex: 0, revision: 1, text: "draft" },
      ],
      tools: [{ callId: "old-tool", name: "bash", revision: 1, state: "running" }],
      subagents: [],
    };
    const recordFrame = (index: number): ServerFrame => ({
      v: 1,
      at: "now",
      type: "history.record",
      record: projectDisplayRecord(records[index] ?? expect.fail("missing record")),
      headId: records[index]?.id ?? null,
      retiredBlockIds: ["retired"],
    });
    const delayedFrames = [
      recordFrame(1),
      ...computeSyncFrames(canonical, liveView, "two", "now").filter(
        (frame) => frame.type === "runtime.event",
      ),
    ];
    const queuedFrame = recordFrame(2);
    const budget = new TextEncoder().encode(JSON.stringify(queuedFrame)).length;
    const signal = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    };
    const queued = signal();
    const retryFired = signal();
    const replacement = signal();
    let held = 100;
    const closes: number[] = [];
    const hellos: Extract<ClientFrame, { type: "client.hello" }>[] = [];
    class Socket {
      static OPEN = 1;
      static instances: Socket[] = [];
      readyState = Socket.OPEN;
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      writer: OutboundWriter;
      constructor() {
        Socket.instances.push(this);
        this.writer = new OutboundWriter(
          {
            get bufferedAmount() {
              return held;
            },
            send: (data) => this.onmessage?.({ data }),
            close: (code) => {
              closes.push(code);
              this.readyState = 3;
            },
          },
          { highWaterMark: 1, maxCriticalBufferedBytes: budget },
        );
        if (Socket.instances.length === 2) replacement.resolve();
      }
      send(json: string) {
        const frame = JSON.parse(json) as ClientFrame;
        if (frame.type !== "client.hello") return;
        hellos.push(frame);
        this.frame({
          v: 1,
          at: "now",
          type: "server.welcome",
          orbId: "a",
          sessionId: "session",
          connectionId: String(Socket.instances.length),
          runtimeInstanceId: "runtime",
          capabilities: [],
          limits: { maxIncomingFrameBytes: 10000, maxPromptBytes: 1000 },
        });
        this.writer.enqueueSyncBatch(
          computeSyncFrames(canonical, liveView, frame.afterRecordId, "now"),
        );
      }
      close() {
        this.readyState = 3;
      }
      frame(frame: ServerFrame) {
        this.onmessage?.({ data: JSON.stringify(frame) });
      }
    }
    const cache = new TranscriptCache();
    const owner = cache.acquire("a", "p");
    let state = reducer(initialState("a"), { type: "history_loaded", view: history() });
    const publish = () => {
      if (state.cacheReady) expect(owner.publish(state)).toBe("stored");
      else owner.clear();
    };
    publish();
    const statuses: string[] = [];
    const accepted: string[] = [];
    let cursorAtClose: string | null = null;
    let timerSerial = 0;
    const timers = new Map<number, Deadline>();
    const timerErrors: unknown[] = [];
    let connection: ReturnType<typeof openLiveConnection> | undefined;
    try {
      vi.stubGlobal("WebSocket", Socket);
      const result = await sim.runTasks([
        {
          name: "browser-runtime",
          f: async (task) => {
            vi.stubGlobal(
              "window",
              Object.assign(new EventTarget(), {
                location: { protocol: "http:", host: "localhost" },
                setTimeout: (callback: () => void, delay: number) => {
                  const id = ++timerSerial;
                  const deadline = task.createDeadline(delay, "client retry");
                  timers.set(id, deadline);
                  deadline.signal.addEventListener(
                    "abort",
                    () => {
                      timers.delete(id);
                      try {
                        callback();
                      } catch (error) {
                        timerErrors.push(error);
                      }
                      retryFired.resolve();
                    },
                    { once: true },
                  );
                  return id;
                },
                clearTimeout: (id: number) => {
                  timers.get(id)?.cancel();
                  timers.delete(id);
                },
              }),
            );
            connection = openLiveConnection({
              orbId: "a",
              sessionId: state.sessionId,
              getAfterRecordId: () => state.afterRecordId,
              getVisible: () => true,
              onRequestLost: () => expect.fail("no requests"),
              onFrame: (frame) => {
                if (frame.type === "history.record") accepted.push(frame.record.id);
                state = reducer(state, { type: "frame", frame });
                publish();
              },
              onStatus: (status) => {
                statuses.push(status);
                state = reducer(state, { type: "connection_status", status });
                publish();
              },
            });
            const first = Socket.instances[0] ?? expect.fail("no initial socket");
            first.onopen?.();
            expect(state.afterRecordId).toBe("two");
            expect(state.liveBlocks.has("retired")).toBe(true);
            expect(state.tools.has("old-tool")).toBe(true);
            canonical = { ...canonical, records, headId: "assistant-b", activity: "idle" };
            liveView = null;
            first.writer.enqueue(queuedFrame);
            expect(first.writer.isClosed).toBe(false);
            queued.resolve();
            await task.checkpoint("critical queued record versus platform drain");
            // Hold the buffer again: the larger second record always exceeds the budget.
            held = 100;
            first.writer.enqueue(recordFrame(3));
            expect(first.writer.isClosed).toBe(true);
            expect(canonical.records).toEqual(records);
            cursorAtClose = state.afterRecordId;
            await task.checkpoint("platform delivers 1013 close");
            first.onclose?.();
            expect(statuses.at(-1)).toBe("retrying");
            await retryFired.promise;
            if (timerErrors.length) throw timerErrors[0];
            const next = Socket.instances[1] ?? expect.fail("retry did not connect");
            await task.checkpoint("replacement open versus delayed old callbacks");
            next.onopen?.();
            expect(state.synced).toBe(true);
          },
        },
        {
          name: "platform-drain",
          f: async (task) => {
            await queued.promise;
            await task.checkpoint("held buffer drains before or after overflow");
            held = 0;
            Socket.instances[0]?.writer.onDrain();
            held = 100;
          },
        },
        {
          name: "delayed-old-socket",
          f: async (task) => {
            await replacement.promise;
            const old = Socket.instances[0] ?? expect.fail("missing retired socket");
            for (const frame of delayedFrames) {
              await task.checkpoint("queued retired callback", frame.type);
              const before = state;
              const cached = cache.get("a");
              const statusCount = statuses.length;
              const acceptedCount = accepted.length;
              old.frame(frame);
              old.onclose?.();
              old.onopen?.();
              expect(state).toBe(before);
              expect(cache.get("a")).toBe(cached);
              expect(statuses).toHaveLength(statusCount);
              expect(accepted).toHaveLength(acceptedCount);
            }
          },
        },
      ]);
      if (result.isErr()) throw result.error;
      expect(timerErrors).toEqual([]);
      expect(closes).toEqual([1013]);
      expect(timerSerial).toBe(1);
      expect(timers.size).toBe(0);
      expect(Socket.instances).toHaveLength(2);
      expect(hellos.map((hello) => hello.afterRecordId)).toEqual(["one", cursorAtClose]);
      expect(["two", "assistant-a"]).toContain(cursorAtClose);
      expect(accepted).toEqual(["two", "assistant-a", "assistant-b"]);
      expect([...state.records.values()]).toEqual(records.map(projectDisplayRecord));
      expect(cache.get("a")?.records).toBe(state.records);
      expect(cache.get("a")?.afterRecordId).toBe("assistant-b");
      expect(cache.get("a")?.headId).toBe("assistant-b");
      expect(cache.get("a")?.sessionId).toBe("session");
      expect(owner.publish(state)).toBe("stored");
      expect(state.liveBlocks.size).toBe(0);
      expect(state.tools.size).toBe(0);
      expect(state.operationId).toBeNull();
      expect(state.activity).toBe("idle");
    } finally {
      try {
        connection?.dispose();
      } finally {
        try {
          for (const timer of timers.values()) timer.cancel();
        } finally {
          try {
            owner.release();
          } finally {
            vi.unstubAllGlobals();
          }
        }
      }
    }
  });
});
