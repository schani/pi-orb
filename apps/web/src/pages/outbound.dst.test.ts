import {
  type ClientFrame,
  type ContentBlock,
  createDisplayRecordProjector,
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

const boundaryKey = (frame: ServerFrame) => {
  if (frame.type === "history.record") return frame.record.id;
  if (
    frame.type === "runtime.event" &&
    (frame.event.type === "operation_started" || frame.event.type === "operation_finished")
  )
    return `${frame.event.type}:${frame.event.operationId}`;
  return null;
};

// Real-reducer reference: writer semantics, not independent detection of reducer bugs.
const semantics = (state: ReturnType<typeof initialState>) => ({
  records: [...state.records.values()],
  cursor: state.afterRecordId,
  head: state.headId,
  activity: state.activity,
  operation: state.operationId,
  blocks: [...state.liveBlocks.values()].sort((a, b) => a.blockId.localeCompare(b.blockId)),
  tools: [...state.tools.values()].sort((a, b) => a.callId.localeCompare(b.callId)),
});

it.each(["history", "tool", "retire", "finish"] as const)(
  "DST: generated prefixes recover at %s overflow through the real client",
  async (cut) => {
    await runDst({ name: `outbound-composed-${cut}`, iterations: 12 }, async (sim) => {
      let state = initialState("a");
      const cache = new TranscriptCache();
      const owner = cache.acquire("a", "p");
      const scenario: ServerFrame[] = [];
      const records: HistoryRecord[] = [];
      let prefixes: (typeof state)[] = [];
      const accepted: string[] = [];
      let checked = 0;
      const cursors: (string | null)[] = [];
      const closes: number[] = [];
      let held = 1,
        budget = 0;
      let comparing = false,
        active = true;
      let canonical: HarnessSnapshot = {
        orbId: "a",
        runtimeInstanceId: "runtime",
        session: { id: "session", overflow: {} },
        records: [],
        headId: null,
        activity: "idle",
      };
      let live: LiveOperationView | null = null;
      let replaced!: () => void;
      const replacement = new Promise<void>((resolve) => {
        replaced = resolve;
      });
      let connection: ReturnType<typeof openLiveConnection> | undefined;
      class Socket {
        static OPEN = 1;
        static instances: Socket[] = [];
        readyState = 1;
        onopen: (() => void) | null = null;
        onclose: (() => void) | null = null;
        onmessage: ((event: { data: string }) => void) | null = null;
        writer = new OutboundWriter(
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
        constructor() {
          Socket.instances.push(this);
          if (Socket.instances.length === 2) replaced();
        }
        send(json: string) {
          const hello = JSON.parse(json) as ClientFrame;
          if (hello.type !== "client.hello") return;
          cursors.push(hello.afterRecordId);
          this.writer.enqueueSyncBatch([
            {
              v: 1,
              at: "now",
              type: "server.welcome",
              orbId: "a",
              sessionId: "session",
              connectionId: "connection",
              runtimeInstanceId: "runtime",
              capabilities: [],
              limits: { maxIncomingFrameBytes: 10000, maxPromptBytes: 1000 },
            },
          ]);
          this.writer.enqueueSyncBatch(
            computeSyncFrames(canonical, live, hello.afterRecordId, "now"),
          );
        }
        close() {
          this.readyState = 3;
        }
      }
      const stale = (frame: ServerFrame) => {
        const before = state;
        const cached = cache.get("a");
        const old = Socket.instances[0] ?? expect.fail("no old socket");
        old.onmessage?.({ data: JSON.stringify(frame) });
        old.onopen?.();
        old.onclose?.();
        expect(state).toBe(before);
        expect(cache.get("a")).toBe(cached);
      };
      try {
        // Only socket/platform clock are fake; clock advancement is scheduler-owned.
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
        const result = await sim.runTasks([
          {
            name: "generated-runtime",
            f: async (task) => {
              let firstEnd = 0,
                overflowAt = -1;
              const texts: string[] = [];
              const generated: { base: string; tail: string }[] = [];
              const assertLiveText = (op: number, edited: boolean) => {
                const { base, tail } = generated[op] ?? expect.fail("missing generated text");
                expect([...state.liveBlocks.values()].map((b) => b.text)).toEqual(
                  Array(2).fill(`${base}${edited ? ":edited" : ""}${tail}`),
                );
              };
              const project = createDisplayRecordProjector();
              const emit = (event: RuntimeEvent) => scenario.push(eventFrame(event));
              for (let op = 0; op < 2; op++) {
                const operationId = `op-${op}`,
                  callId = `${operationId}:call`;
                const ids = [0, 1].map((b) => `${operationId}:block-${b}`);
                // Large second history guarantees budget safety for the complete held first span.
                const text = `${operationId}:α`.repeat(op === 1 ? 600 : 1);
                const tail = ":tail".repeat(1 + Math.floor(task.random("append chunks") * 3));
                generated.push({ base: text, tail });
                texts.push(`${text}:edited${tail}`);
                const commit = (kind: string, content: ContentBlock[], retire: string[] = []) => {
                  const id = `${operationId}:${kind}`;
                  const record: HistoryRecord = {
                    id,
                    parentId: records.at(-1)?.id ?? null,
                    timestamp: "now",
                    type: "message",
                    role: kind === "tool" ? "tool" : "assistant",
                    content,
                    overflow: {},
                  };
                  records.push(record);
                  scenario.push({
                    v: 1,
                    at: "now",
                    type: "history.record",
                    record: project(record),
                    headId: id,
                    retiredBlockIds: retire,
                  });
                  if (op === 1 && kind === cut) overflowAt = scenario.length - 1;
                };
                emit({ type: "operation_started", operationId });
                for (const phase of [0, 1]) {
                  const order = task.random("block order") < 0.5 ? [0, 1] : [1, 0];
                  for (const b of order) {
                    for (const part of [0, 1])
                      emit({
                        type: "output_patch",
                        operationId,
                        blockId: ids[b] ?? expect.fail("block missing"),
                        blockType: "text",
                        revision: phase * 2 + part + 1,
                        patch: {
                          type: part === 1 || (phase === 0 && b === 0) ? "append" : "replace",
                          text: part === 1 ? tail : phase === 0 ? text : `${text}:edited`,
                        },
                      });
                  }
                  emit({
                    type: "tool_state",
                    operationId,
                    callId,
                    name: "bash",
                    revision: phase + 1,
                    state: phase === 0 ? "running" : "completed",
                  });
                  if (phase === 0)
                    commit("history", [
                      { type: "text", text: `${text}:unrelated` },
                      {
                        type: "tool_call",
                        callId,
                        name: "bash",
                        arguments: { command: "echo ok" },
                      },
                    ]);
                  else
                    commit("tool", [
                      { type: "tool_result", callId, content: [{ type: "text", text: "ok" }] },
                    ]);
                }
                commit(
                  "retire",
                  ids.map(() => ({ type: "text", text: texts[op] ?? "" })),
                  ids,
                );
                emit({ type: "operation_finished", operationId, outcome: "completed" });
                if (op === 1 && cut === "finish") overflowAt = scenario.length - 1;
                if (op === 0) firstEnd = scenario.length;
              }
              const bytes = (frames: ServerFrame[]) =>
                frames
                  .filter((f) => boundaryKey(f) !== null)
                  .reduce((sum, f) => sum + new TextEncoder().encode(JSON.stringify(f)).length, 0);
              budget = bytes(scenario.slice(firstEnd, overflowAt + 1)) - 1;
              expect(overflowAt).toBeGreaterThan(firstEnd);
              expect(budget).toBeGreaterThan(bytes(scenario.slice(0, firstEnd)));
              connection = openLiveConnection({
                orbId: "a",
                sessionId: null,
                getAfterRecordId: () => state.afterRecordId,
                getVisible: () => true,
                onRequestLost: () => expect.fail("no requests"),
                onFrame: (frame) => {
                  state = reducer(state, { type: "frame", frame });
                  if (frame.type === "history.record") accepted.push(frame.record.id);
                  const key = boundaryKey(frame);
                  if (comparing && key !== null) {
                    const index = scenario.findIndex((f) => boundaryKey(f) === key);
                    const expected = prefixes[index] ?? expect.fail(key);
                    expect(semantics(state), key).toEqual(semantics(expected));
                    if (frame.type === "history.record" && /:(history|tool)$/.test(key))
                      assertLiveText(key.startsWith("op-0:") ? 0 : 1, key.endsWith(":tool"));
                    checked++;
                  }
                  if (state.cacheReady) expect(owner.publish(state)).toBe("stored");
                  else owner.clear();
                },
                onStatus: (status) => {
                  if (active) state = reducer(state, { type: "connection_status", status });
                },
              });
              const first = Socket.instances[0] ?? expect.fail("no first socket");
              first.onopen?.();
              let reference = state;
              prefixes = scenario.map(
                (frame) => (reference = reducer(reference, { type: "frame", frame })),
              );
              let writer = first.writer,
                recordCount = 0;
              for (const [index, frame] of scenario.entries()) {
                await task.checkpoint("canonical commit then transport enqueue", index);
                const prefix = prefixes[index] ?? expect.fail("missing prefix");
                if (frame.type === "history.record") recordCount++;
                canonical = {
                  ...canonical,
                  records: records.slice(0, recordCount),
                  headId: records.slice(0, recordCount).at(-1)?.id ?? null,
                  activity:
                    index === firstEnd - 1 || index === scenario.length - 1 ? "idle" : "busy",
                };
                writer.enqueue(frame);
                expect(first.writer.isClosed, `cut witness ${index}`).toBe(index >= overflowAt);
                if (index + 1 === firstEnd) {
                  expect(checked).toBe(0);
                  held = 0;
                  comparing = true;
                  writer.onDrain();
                  comparing = false;
                  held = 1;
                  expect(checked).toBe(scenario.slice(0, firstEnd).filter(boundaryKey).length);
                }
                if (index !== overflowAt) continue;
                expect(closes).toEqual([1013]);
                const cursor = state.afterRecordId;
                expect(cursor).toBe("op-0:retire");
                const { base, tail } = generated[1] ?? expect.fail("missing second operation");
                live =
                  cut === "finish"
                    ? null
                    : {
                        operationId: "op-1",
                        subagents: [],
                        blocks:
                          cut === "retire"
                            ? []
                            : [0, 1].map((contentIndex) => ({
                                blockId: `op-1:block-${contentIndex}`,
                                blockType: "text",
                                contentIndex,
                                revision: cut === "history" ? 2 : 4,
                                text: `${base}${cut === "history" ? "" : ":edited"}${tail}`,
                              })),
                        tools: [
                          {
                            callId: "op-1:call",
                            name: "bash",
                            revision: cut === "history" ? 1 : 2,
                            state: cut === "history" ? "running" : "completed",
                          },
                        ],
                      };
                await task.checkpoint("deliver 1013 close");
                first.onclose?.();
                expect(state.connection).toBe("retrying");
                await task.checkpoint("platform retry timer fires");
                vi.advanceTimersByTime(2000);
                const next = Socket.instances[1] ?? expect.fail("no actual retry");
                await task.checkpoint("replacement open versus old callbacks");
                if (cut === "history") for (const f of scenario.slice(0, 9)) stale(f);
                next.onopen?.();
                if (cut === "tool") for (const f of scenario.slice(0, 9)) stale(f);
                expect(cursors).toEqual([null, cursor]);
                expect(state.synced).toBe(true);
                expect(semantics(state)).toEqual(semantics(prefix));
                if (cut === "history" || cut === "tool") assertLiveText(1, cut === "tool");
                else expect(state.liveBlocks.size).toBe(0);
                expect(state.tools.get("op-1:call")?.state).toBe(
                  cut === "history" ? "running" : cut === "finish" ? undefined : "completed",
                );
                held = 0;
                comparing = true;
                writer = next.writer;
              }
              expect(semantics(state)).toEqual(semantics(reference));
              expect(accepted).toEqual(records.map((record) => record.id));
              expect(records.map((r) => r.parentId)).toEqual([
                null,
                ...records.slice(0, -1).map((r) => r.id),
              ]);
              for (const [op, text] of texts.entries())
                expect(state.records.get(`op-${op}:retire`)).toMatchObject({
                  content: Array.from({ length: 2 }, () => ({ type: "text", text })),
                });
              expect(state.liveBlocks.size + state.tools.size).toBe(0);
              expect(cache.get("a")).toMatchObject({
                records: state.records,
                sessionId: "session",
                afterRecordId: records.at(-1)?.id,
                headId: records.at(-1)?.id,
              });
              expect(Socket.instances).toHaveLength(2);
            },
          },
          {
            name: "mixed-old-callbacks",
            f: async (task) => {
              await replacement;
              if (cut === "history" || cut === "tool") return;
              await task.checkpoint("old callback versus new open/live stream");
              for (const f of scenario.slice(0, 9)) stale(f);
            },
          },
        ]);
        expect(result.isErr() ? result.error : null).toBeNull();
      } finally {
        active = false;
        connection?.dispose();
        owner.release();
        vi.unstubAllGlobals();
        vi.useRealTimers();
      }
    });
  },
);
