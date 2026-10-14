import {
  type ClientFrame,
  createDisplayRecordProjector,
  type DisplayRecord,
  type HistoryRecord,
  type RuntimeEvent,
  type ServerFrame,
} from "@pi-orb/protocol";
import { expect, it, vi } from "vitest";
import { OutboundWriter } from "../../../orb-runtime/src/domain/outbound.ts";
import { computeSyncFrames } from "../../../orb-runtime/src/domain/sync.ts";
import type { HarnessSnapshot, LiveOperationView } from "../../../orb-runtime/src/domain/types.ts";
import { runDst } from "../../../orb-runtime/src/testkit/sim.ts";
import { openLiveConnection } from "../lib/live.ts";
import { TranscriptCache } from "../lib/transcript-cache.ts";
import { initialState, isLiveCompacting, reducer } from "./OrbPage.tsx";

const eventFrame = (event: RuntimeEvent): ServerFrame => ({
  v: 1,
  type: "runtime.event",
  at: "2026-10-14T14:00:00Z",
  event,
});

const frames = [
  eventFrame({ type: "operation_started", operationId: "A" }),
  eventFrame({ type: "status", activity: "busy", operationId: "A" }),
  eventFrame({ type: "operation_finished", operationId: "A", outcome: "completed" }),
  eventFrame({ type: "status", activity: "idle" }),
  eventFrame({ type: "operation_started", operationId: "B" }),
  eventFrame({
    type: "status",
    activity: "busy",
    operationId: "B",
    work: "compaction",
    compactionAfterId: "after-A",
  }),
];

// Hold the entire sequence first, then explore drain races at every prefix.
it.each([6, 0, 1, 2, 3, 4, 5])(
  "DST: preserves B compaction when socket drain starts after %i enqueues",
  async (drainAfter) => {
    await runDst(
      { name: `outbound-compaction-boundary-${drainAfter}`, iterations: 80 },
      async (sim) => {
        let browser = reducer(initialState("outbound"), {
          type: "connection_status",
          status: "open",
        });
        let bufferedAmount = 1;
        let done = false;
        let release!: () => void;
        const drainReady = new Promise<void>((resolve) => {
          release = resolve;
        });
        const sent: ServerFrame[] = [];
        const writer = new OutboundWriter(
          {
            get bufferedAmount() {
              return bufferedAmount;
            },
            send(json) {
              const frame = JSON.parse(json) as ServerFrame;
              sent.push(frame);
              browser = reducer(browser, { type: "frame", frame });
              // One frame fills the socket again; each next drain is scheduled.
              bufferedAmount = 1;
            },
            close() {
              expect.fail("unexpected backpressure close");
            },
          },
          { highWaterMark: 1, maxCriticalBufferedBytes: 100_000 },
        );
        const result = await sim.runTasks([
          {
            name: "runtime-events",
            f: async (task) => {
              if (drainAfter === 0) release();
              for (const [index, frame] of frames.entries()) {
                await task.checkpoint("enqueue ordered runtime event", index);
                writer.enqueue(frame);
                if (index + 1 === drainAfter) release();
              }
              done = true;
            },
          },
          {
            name: "socket-drain",
            f: async (task) => {
              await drainReady;
              while (!done || bufferedAmount > 0) {
                await task.checkpoint("socket drains; writer delivers next queued frame");
                bufferedAmount = 0;
                writer.onDrain();
              }
            },
          },
        ]);
        expect(result.isErr() ? result.error : null).toBeNull();
        // Complete the schedule before asserting, so the red trace replays on the fix.
        expect(browser, JSON.stringify({ sent })).toMatchObject({
          operationId: "B",
          activity: "busy",
          compacting: true,
          compaction: { operationId: "B", afterId: "after-A" },
        });
        expect(isLiveCompacting("running", browser)).toBe(true);
        expect(sent).toEqual(frames);
        expect(writer.isClosed).toBe(false);
      },
    );
  },
);

interface IntendedBlock {
  blockId: string;
  blockType: "text";
  text: string;
  revision: number;
}
interface IntendedTool {
  callId: string;
  name: string;
  state: "running" | "completed";
}
interface IntendedFacts {
  records: DisplayRecord[];
  operation: string | null;
  activity: "busy" | "idle";
  blocks: IntendedBlock[];
  tools: IntendedTool[];
}

it.each([
  { shape: "short", operations: 1, blocks: 2, chunks: 2, tools: false },
  { shape: "wide", operations: 2, blocks: 4, chunks: 3, tools: true },
  { shape: "deep", operations: 3, blocks: 3, chunks: 4, tools: true },
])("DST: independent semantic recovery ($shape)", async (shape) => {
  await runDst({ name: `outbound-independent-${shape.shape}`, iterations: 16 }, async (sim) => {
    let state = initialState("a");
    const cache = new TranscriptCache();
    const retiredOwner = cache.acquire("a", "p");
    const owner = cache.acquire("a", "p");
    const intended: IntendedFacts = {
      records: [],
      operation: null,
      activity: "idle",
      blocks: [],
      tools: [],
    };
    // Semantic facts are authored at phase boundaries, never by interpreting frames.
    const facts = (): IntendedFacts => structuredClone(intended);
    const boundaries = new Map<string, IntendedFacts>();
    const native: HistoryRecord[] = [];
    const project = createDisplayRecordProjector(); // Actual publication path only.
    let canonical: HarnessSnapshot = {
      orbId: "a",
      runtimeInstanceId: "runtime",
      session: { id: "session", overflow: {} },
      records: native,
      headId: null,
      activity: "idle",
    };
    let live: LiveOperationView | null = null;
    let budget = 100_000;
    const cursors: (string | null)[] = [];
    const closes: number[] = [];
    let delivering: Socket | undefined;
    let connection: ReturnType<typeof openLiveConnection> | undefined;
    const publicRecords = (records: ReadonlyMap<string, DisplayRecord>) =>
      new Map(
        [...records].map(([key, record]) => [
          key,
          record.type === "message"
            ? {
                id: record.id,
                parentId: record.parentId,
                timestamp: record.timestamp,
                type: record.type,
                role: record.role,
                content: record.content,
                ...(record.inboxMessageIds === undefined
                  ? {}
                  : { inboxMessageIds: record.inboxMessageIds }),
              }
            : record,
        ]),
      );
    const assertHistory = (records: DisplayRecord[]) => {
      const last = records.at(-1)?.id ?? null;
      expect([...publicRecords(state.records)]).toEqual(
        records.map((record) => [record.id, record]),
      );
      expect([state.headId, state.afterRecordId]).toEqual([last, last]);
      if (state.cacheReady) {
        const cached = cache.get("a") ?? expect.fail("missing admitted transcript");
        expect([...publicRecords(cached.records)]).toEqual(
          records.map((record) => [record.id, record]),
        );
        expect([cached.sessionId, cached.headId, cached.afterRecordId]).toEqual([
          "session",
          last,
          last,
        ]);
      } else expect(cache.get("a")).toBeUndefined();
    };
    const assertFacts = (expected: IntendedFacts) => {
      assertHistory(expected.records);
      expect([state.operationId, state.activity]).toEqual([expected.operation, expected.activity]);
      expect(
        new Map(
          [...state.liveBlocks].map(([key, { blockId, blockType, text, revision }]) => [
            key,
            { blockId, blockType, text, revision },
          ]),
        ),
      ).toEqual(new Map(expected.blocks.map((block) => [block.blockId, block])));
      expect(
        new Map(
          [...state.tools].map(([key, { callId, name, state }]) => [key, { callId, name, state }]),
        ),
      ).toEqual(new Map(expected.tools.map((tool) => [tool.callId, tool])));
    };
    class Socket {
      static OPEN = 1;
      static instances: Socket[] = [];
      readyState = 1;
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      held = 1;
      wire: string[] = [];
      syncing = false;
      captured = facts();
      writer: OutboundWriter;
      constructor() {
        const socket = this;
        this.writer = new OutboundWriter(
          {
            get bufferedAmount() {
              return socket.held;
            },
            send: (json) => {
              this.wire.push(json);
              this.held = 1;
            },
            close: (code) => {
              closes.push(code);
              this.readyState = 3;
              this.wire = []; // Termination loses undelivered network bytes.
            },
          },
          { highWaterMark: 1, maxCriticalBufferedBytes: budget },
        );
        Socket.instances.push(this);
      }
      send(json: string) {
        const hello = JSON.parse(json) as ClientFrame;
        if (hello.type !== "client.hello") return;
        cursors.push(hello.afterRecordId);
        this.captured = facts();
        this.writer.enqueueSyncBatch([
          {
            v: 1,
            at: "now",
            type: "server.welcome",
            orbId: "a",
            sessionId: "session",
            connectionId: `connection-${Socket.instances.length}`,
            runtimeInstanceId: "runtime",
            capabilities: [],
            limits: { maxIncomingFrameBytes: 10000, maxPromptBytes: 1000 },
          },
          ...computeSyncFrames(canonical, live, hello.afterRecordId, "now"),
        ]);
      }
      deliver() {
        const json = this.wire.shift() ?? expect.fail("network has no frame");
        const frame = JSON.parse(json) as ServerFrame;
        if (frame.type === "sync.started") this.syncing = true;
        delivering = this;
        this.onmessage?.({ data: json });
        delivering = undefined;
        if (frame.type === "sync.completed") this.syncing = false;
        return frame;
      }
      close() {
        this.readyState = 3;
      }
    }
    let socket: Socket;
    const emit = (event: RuntimeEvent) => socket.writer.enqueue(eventFrame(event));
    const patch = (blockId: string, revision: number, type: "append" | "replace", text: string) =>
      emit({
        type: "output_patch",
        operationId: intended.operation ?? expect.fail("no operation"),
        blockId,
        blockType: "text",
        revision,
        patch: { type, text },
      });
    const commit = (id: string, texts: string[], retire: string[] = [], human = false) => {
      const parentId = intended.records.at(-1)?.id ?? null;
      intended.records.push({
        id,
        parentId,
        timestamp: "now",
        type: "message",
        role: human ? "user" : "assistant",
        ...(human ? { inboxMessageIds: [id] } : {}),
        content: texts.map((text) => ({ type: "text", text })),
      });
      const record: HistoryRecord = {
        id,
        parentId,
        timestamp: "now",
        type: "message",
        role: human ? "user" : "assistant",
        ...(human ? { inboxMessageIds: [id] } : {}),
        content: texts.map((text) => ({ type: "text", text })),
        overflow: {},
      };
      native.push(record);
      canonical = { ...canonical, records: [...native], headId: id };
      boundaries.set(id, facts());
      socket.writer.enqueue({
        v: 1,
        at: "now",
        type: "history.record",
        record: project(record),
        headId: id,
        retiredBlockIds: retire,
      });
    };
    const setLive = () => {
      live =
        intended.operation === null
          ? null
          : {
              operationId: intended.operation,
              blocks: intended.blocks.map((block, contentIndex) => ({ ...block, contentIndex })),
              tools: intended.tools.map((tool) => ({ ...tool, revision: 2 })),
              subagents: [],
            };
      canonical = { ...canonical, activity: intended.activity };
    };
    const stale = () => {
      const before = state;
      const cached = cache.get("a");
      for (const old of Socket.instances.slice(0, -1)) {
        old.onmessage?.({
          data: JSON.stringify(eventFrame({ type: "operation_started", operationId: "poison" })),
        });
        old.onopen?.();
        old.onclose?.();
      }
      expect(state).toBe(before);
      expect(
        retiredOwner.publish({
          sessionId: "wrong",
          records: new Map(),
          headId: null,
          afterRecordId: null,
        }),
      ).toBe("stale");
      retiredOwner.clear();
      retiredOwner.release();
      expect(cache.get("a")).toBe(cached);
    };
    try {
      vi.useFakeTimers();
      vi.stubGlobal("WebSocket", Socket);
      vi.stubGlobal(
        "window",
        Object.assign(new EventTarget(), {
          location: { protocol: "http:", host: "localhost" },
          setTimeout,
          clearTimeout,
        }),
      );
      connection = openLiveConnection({
        orbId: "a",
        sessionId: null,
        getAfterRecordId: () => state.afterRecordId,
        getVisible: () => true,
        onRequestLost: () => expect.fail("no requests"),
        onStatus: (status) => {
          state = reducer(state, { type: "connection_status", status });
        },
        onFrame: (frame) => {
          state = reducer(state, { type: "frame", frame });
          if (state.cacheReady) expect(owner.publish(state)).toBe("stored");
          else owner.clear();
          if (frame.type === "history.record") {
            const appliedCount =
              intended.records.findIndex((record) => record.id === frame.record.id) + 1;
            expect(appliedCount).toBeGreaterThan(0);
            if (delivering?.syncing) assertHistory(intended.records.slice(0, appliedCount));
            else assertFacts(boundaries.get(frame.record.id) ?? expect.fail("unplanned commit"));
          }
          if (frame.type === "sync.completed") {
            assertFacts(delivering?.captured ?? expect.fail("missing hello boundary"));
          }
          if (frame.type === "runtime.event" && frame.event.type === "operation_finished")
            assertFacts(boundaries.get(frame.event.operationId) ?? expect.fail("unplanned finish"));
        },
      });
      socket = Socket.instances[0] ?? expect.fail("missing initial transport");
      let beginContinuation!: () => void, continuationDone!: () => void;
      const continuing = new Promise<void>((resolve) => {
        beginContinuation = resolve;
      });
      const committed = new Promise<void>((resolve) => {
        continuationDone = resolve;
      });
      let finalSync = false;
      const result = await sim.runTasks([
        {
          name: "runtime-and-network",
          f: async (task) => {
            const drain = async () => {
              for (let i = 0; i < 200; i++) {
                await task.checkpoint("one serialized frame crosses network", i);
                if (socket.wire.length) {
                  if (finalSync && JSON.parse(socket.wire[0] ?? "null")?.type === "sync.completed")
                    await committed;
                  socket.deliver();
                } else {
                  socket.held = 0;
                  socket.writer.onDrain();
                  if (!socket.wire.length) return;
                }
              }
              expect.fail("bounded drain did not converge");
            };
            const retry = async () => {
              socket.onclose?.();
              expect(state.connection).toBe("retrying");
              const count = Socket.instances.length;
              for (let i = 0; i < 100 && Socket.instances.length === count; i++) {
                await task.checkpoint("real client retry timer advances", i);
                vi.advanceTimersByTime(100);
              }
              expect(Socket.instances).toHaveLength(count + 1);
              socket = Socket.instances[count] ?? expect.fail("timer created no socket");
              socket.onopen?.();
            };
            const through = async (type: ServerFrame["type"]) => {
              for (let i = 0; i < 100; i++) {
                await task.checkpoint("partial synchronization delivery", i);
                if (socket.deliver().type === type) return;
              }
              expect.fail("missing synchronization witness");
            };
            socket.onopen?.();
            await drain();
            let survivors: IntendedBlock[] = [];
            for (let op = 0; op < shape.operations; op++) {
              const operationId = `operation-${op}`;
              const count = shape.blocks + Math.floor(task.random("extra block") * 2);
              const blocks = Array.from({ length: count }, (_, b) => {
                const chunks = Array.from(
                  {
                    length: shape.chunks + Math.floor(task.random("extra chunk") * 2),
                  },
                  (_, c) => `α:${op}/${b}/${c};`,
                );
                return { blockId: `${operationId}:block-${b}`, chunks, edited: `EDIT:${op}/${b};` };
              });
              socket.held = 1;
              intended.operation = operationId;
              intended.activity = "busy";
              emit({ type: "operation_started", operationId });
              intended.blocks = blocks.map((b) => ({
                blockId: b.blockId,
                blockType: "text",
                text: b.chunks.join(""),
                revision: b.chunks.length,
              }));
              for (const b of blocks)
                for (const [c, text] of b.chunks.entries()) patch(b.blockId, c + 1, "append", text);
              intended.tools =
                shape.tools && op % 2 === 0
                  ? [
                      {
                        callId: `${operationId}:call`,
                        name: op === 0 ? "bash" : "read",
                        state: "running",
                      },
                    ]
                  : [];
              for (const tool of intended.tools)
                emit({ type: "tool_state", operationId, ...tool, revision: 1 });
              commit(`${operationId}:unrelated`, [`human:${op}`], [], true);
              intended.blocks = blocks.map((b) => ({
                blockId: b.blockId,
                blockType: "text",
                text: `${b.edited}${b.chunks.join("")}`,
                revision: b.chunks.length * 2 + 1,
              }));
              for (const b of blocks) {
                patch(b.blockId, b.chunks.length + 1, "replace", b.edited);
                for (const [c, text] of b.chunks.entries())
                  patch(b.blockId, b.chunks.length + c + 2, "append", text);
              }
              intended.tools = intended.tools.map((tool) => ({ ...tool, state: "completed" }));
              for (const tool of intended.tools)
                emit({ type: "tool_state", operationId, ...tool, revision: 2 });
              const retired = intended.blocks.slice(0, Math.floor(count / 2));
              survivors = intended.blocks.slice(retired.length);
              intended.blocks = survivors;
              commit(
                `${operationId}:partial`,
                retired.map((b) => b.text),
                retired.map((b) => b.blockId),
              );
              setLive();
              await drain();
              expect(state.liveBlocks.size).toBeGreaterThan(0); // Pinned partial-retirement witness.
              if (op + 1 < shape.operations) {
                intended.blocks = [];
                commit(
                  `${operationId}:rest`,
                  survivors.map((b) => b.text),
                  survivors.map((b) => b.blockId),
                );
                intended.tools = [];
                intended.operation = null;
                intended.activity = "idle";
                boundaries.set(operationId, facts());
                emit({ type: "operation_finished", operationId, outcome: "completed" });
                setLive();
                await drain();
              }
            }
            const operationId = intended.operation ?? expect.fail("no active last operation");
            const prefix = intended.records.at(-1)?.id;
            // Fixed small budget, oversized semantic records: no byte-count-derived oracle.
            budget = 4096;
            // The initial writer was constructed with the large budget; queue enough to exceed it.
            socket.held = 1;
            commit("lost-before-retry", ["first overflow;".repeat(8000)]);
            expect(socket.writer.isClosed).toBe(true);
            commit("backlog", ["committed while disconnected"]);
            await retry();
            expect(cursors).toEqual([null, prefix]);
            await through("history.record");
            expect([state.afterRecordId, state.synced]).toEqual(["lost-before-retry", false]);
            // The first retry has delivered only part of its captured history, not its live reconstruction.
            intended.blocks = survivors.map((b) => ({
              ...b,
              text: `CONTINUE:${b.blockId};`,
              revision: b.revision + 2,
            }));
            for (const b of survivors) {
              patch(b.blockId, b.revision + 1, "replace", `CONTINUE:${b.blockId}`);
              patch(b.blockId, b.revision + 2, "append", ";");
            }
            setLive();
            commit("lost-during-sync", ["second overflow;".repeat(400)]);
            expect(socket.writer.isClosed).toBe(true);
            await retry();
            expect(cursors).toEqual([null, prefix, "lost-before-retry"]);
            await through("sync.started");
            expect(state.synced).toBe(false);
            finalSync = true;
            beginContinuation();
            await drain();
            assertFacts(facts());
            expect(state.synced).toBe(true);
            stale();
            const remaining = [...intended.blocks];
            intended.blocks = [];
            commit(
              "final-retirement",
              remaining.map((b) => b.text),
              remaining.map((b) => b.blockId),
            );
            intended.tools = [];
            intended.operation = null;
            intended.activity = "idle";
            boundaries.set(operationId, facts());
            emit({ type: "operation_finished", operationId, outcome: "completed" });
            setLive();
            await drain();
            expect(closes).toEqual([1013, 1013]);
            expect(Socket.instances).toHaveLength(3);
            expect(cache.stats.owners).toBe(1);
          },
        },
        {
          name: "continuing-runtime",
          f: async (task) => {
            await continuing;
            stale();
            intended.blocks = intended.blocks.map((b) => ({
              ...b,
              text: `${b.text}FINAL:${b.blockId}`,
              revision: b.revision + 1,
            }));
            for (const b of intended.blocks) {
              await task.checkpoint("runtime output while synchronization drains", b.blockId);
              patch(b.blockId, b.revision, "append", `FINAL:${b.blockId}`);
            }
            setLive();
            commit("commit-during-final-sync", ["live history after hello boundary"]);
            await task.checkpoint("runtime history commit precedes sync completion");
            expect(state.synced).toBe(false);
            continuationDone();
          },
        },
      ]);
      expect(result.isErr() ? result.error : null).toBeNull();
    } finally {
      connection?.dispose();
      owner.release();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
