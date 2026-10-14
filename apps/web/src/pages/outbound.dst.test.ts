import type { ContentBlock, RuntimeEvent, ServerFrame } from "@pi-orb/protocol";
import { expect, it } from "vitest";
import { OutboundWriter } from "../../../orb-runtime/src/domain/outbound.ts";
import { runDst } from "../../../orb-runtime/src/testkit/sim.ts";
import { displayRecord as historyDisplayRecord } from "../testkit/display-fixtures.ts";
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

const boundaryKey = (frame: ServerFrame): string | null => {
  if (frame.type === "history.record") return frame.record.id;
  if (
    frame.type === "runtime.event" &&
    (frame.event.type === "operation_started" || frame.event.type === "operation_finished")
  )
    return `${frame.event.type}:${frame.event.operationId}`;
  return null;
};

// Map insertion order and transport bookkeeping are not user-visible semantics.
const semantics = (state: ReturnType<typeof initialState>) => ({
  records: [...state.records.values()],
  afterRecordId: state.afterRecordId,
  headId: state.headId,
  activity: state.activity,
  operationId: state.operationId,
  compacting: state.compacting,
  compaction: state.compaction,
  liveBlocks: [...state.liveBlocks.values()].sort((a, b) => a.blockId.localeCompare(b.blockId)),
  tools: [...state.tools.values()].sort((a, b) => a.callId.localeCompare(b.callId)),
  detailAliases: [...state.detailAliases].sort(),
  subagents: state.subagents,
  serverError: state.serverError,
});

it.each(["held", "racing"])("DST: grammar critical prefixes (%s)", async (drain) => {
  const counts = {
    schedules: 0,
    operations: 0,
    boundaries: 0,
    appends: 0,
    replaces: 0,
    retirements: 0,
    tools: 0,
  };
  const options = {
    name: `outbound-seeded-grammar-${drain}`,
    iterations: drain === "held" ? 1 : 40,
  };
  await runDst(options, async (sim) => {
    let browser = reducer(initialState("outbound-grammar"), {
      type: "connection_status",
      status: "open",
    });
    let reference = browser;
    let bufferedAmount = 1;
    let done = false;
    let release!: () => void;
    const drainReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    const expected = new Map<string, ReturnType<typeof semantics>>();
    const delivered = new Set<string>();
    const scenario: ServerFrame[] = [];
    const writer = new OutboundWriter(
      {
        get bufferedAmount() {
          return bufferedAmount;
        },
        send(json) {
          const frame = JSON.parse(json) as ServerFrame;
          browser = reducer(browser, { type: "frame", frame });
          bufferedAmount = 1;
          const key = boundaryKey(frame);
          if (key !== null) {
            expect(delivered.has(key)).toBe(false);
            expect(semantics(browser), JSON.stringify({ key, scenario })).toEqual(
              expected.get(key),
            );
            delivered.add(key);
          }
        },
        close() {
          expect.fail("grammar unexpectedly closed the socket");
        },
      },
      { highWaterMark: 1, maxCriticalBufferedBytes: 100_000 },
    );
    const result = await sim.runTasks([
      {
        name: "grammar-producer",
        f: async (task) => {
          // Generate the whole bounded grammar before producing any events.
          const operationCount = 2 + Math.floor(task.random("operation count") * 3);
          let parentId: string | null = null;
          for (let op = 0; op < operationCount; op++) {
            const operationId = `op-${op}`;
            const reuse = op > 0 && task.random("reuse block and call IDs") < 0.5;
            const ids = [0, 1].map((b) => `${reuse ? "op-0" : operationId}:block-${b}`);
            const callId = `${reuse ? "op-0" : operationId}:call`;
            const text =
              ["plain", "α\n", 'quote " \\', "🙂"][Math.floor(task.random("payload") * 4)] ??
              "plain";
            const finalTexts: string[] = [];
            const chains: ServerFrame[][] = ids.map((blockId, b) => {
              const base = `${text}:${op}:${b}`;
              const patch = (revision: number, type: "append" | "replace", text: string) =>
                eventFrame({
                  type: "output_patch",
                  operationId,
                  blockId,
                  blockType: "text",
                  revision,
                  patch: { type, text },
                });
              const events = [patch(1, "replace", base), patch(2, "append", ":tail")];
              const replace = task.random("optional replacement") < 0.5;
              const final = replace ? `${base}:edited` : `${base}:tail`;
              finalTexts[b] = final;
              if (replace) events.push(patch(3, "replace", final));
              return events;
            });
            chains.push(
              ["running", "completed"].map((state, revision) =>
                eventFrame({
                  type: "tool_state",
                  operationId,
                  callId,
                  name: "bash",
                  revision: revision + 1,
                  state: state as "running" | "completed",
                  code: `echo '${text}'`,
                  message: `${text}:${state}`,
                }),
              ),
            );
            scenario.push(
              eventFrame({ type: "operation_started", operationId }),
              eventFrame({ type: "status", activity: "busy", operationId }),
            );
            // Each round advances both blocks and the tool, in seeded order.
            let firstRoundEnd = 0;
            while (chains.some((chain) => chain.length > 0)) {
              const round = chains.filter((chain) => chain.length > 0);
              while (round.length > 0) {
                const index = Math.floor(task.random("transient ordering") * round.length);
                const frame = round.splice(index, 1)[0]?.shift();
                if (frame !== undefined) scenario.push(frame);
              }
              firstRoundEnd ||= scenario.length;
            }
            let recordIndex = 0;
            const commit = (
              content: ContentBlock[],
              retiredBlockIds: string[] = [],
              insertionIndex = scenario.length,
            ) => {
              const id = `${operationId}:record-${recordIndex++}`;
              const record = historyDisplayRecord({
                id,
                parentId,
                timestamp: "2026-10-14T14:00:00Z",
                overflow: { native: {} },
                type: "message",
                role: content[0]?.type === "tool_result" ? "tool" : "assistant",
                content,
              });
              scenario.splice(insertionIndex, 0, {
                v: 1,
                at: record.timestamp,
                type: "history.record",
                record,
                headId: id,
                retiredBlockIds,
              });
              parentId = id;
            };
            // Fence both same-key block and tool revisions without retiring either.
            commit([{ type: "text", text: `${text}:unrelated` }], [], firstRoundEnd);
            // Tool-result commit observes both live blocks before either retirement.
            commit([
              {
                type: "tool_result",
                callId,
                content: [{ type: "text", text: `${text}:completed` }],
              },
            ]);
            const order = task.random("retirement order") < 0.5 ? [0, 1] : [1, 0];
            for (const b of order) {
              commit([{ type: "text", text: finalTexts[b] ?? "" }], [ids[b] ?? ""]);
            }
            scenario.push(
              eventFrame({ type: "operation_finished", operationId, outcome: "completed" }),
              eventFrame({ type: "status", activity: "idle" }),
            );
          }
          for (const frame of scenario) {
            reference = reducer(reference, { type: "frame", frame });
            const key = boundaryKey(frame);
            if (key !== null) expected.set(key, semantics(reference));
            if (frame.type === "runtime.event" && frame.event.type === "tool_state") counts.tools++;
            if (frame.type === "history.record" && frame.retiredBlockIds.length > 0)
              counts.retirements++;
            if (frame.type === "runtime.event" && frame.event.type === "output_patch") {
              if (frame.event.patch.type === "append") counts.appends++;
              else counts.replaces++;
            }
          }
          const drainAfter =
            drain === "held"
              ? scenario.length
              : Math.floor(task.random("drain release prefix") * (scenario.length + 1));
          if (drainAfter === 0) release();
          for (const [index, frame] of scenario.entries()) {
            await task.checkpoint("enqueue grammar frame", index, frame);
            writer.enqueue(frame);
            if (index + 1 === drainAfter) {
              if (drain === "held") expect(delivered.size).toBe(0);
              release();
            }
          }
          done = true;
          counts.operations += operationCount;
        },
      },
      {
        name: "grammar-drainer",
        f: async (task) => {
          await drainReady;
          while (!done || bufferedAmount > 0) {
            await task.checkpoint("drain one grammar frame");
            bufferedAmount = 0;
            writer.onDrain();
          }
        },
      },
    ]);
    expect(result.isErr() ? result.error : null, JSON.stringify(scenario)).toBeNull();
    expect(delivered.size).toBe(expected.size);
    expect(semantics(browser)).toEqual(semantics(reference));
    expect(browser.records.size).toBeGreaterThanOrEqual(8);
    expect(browser.liveBlocks.size).toBe(0);
    expect(browser.tools.size).toBe(0);
    expect(writer.isClosed).toBe(false);
    counts.boundaries += delivered.size;
    counts.schedules++;
  });
  expect(counts.tools).toBe(counts.operations * 2);
  expect(counts.appends).toBe(counts.operations * 2);
  expect(counts.replaces).toBeGreaterThanOrEqual(counts.operations * 2);
  expect(counts.retirements).toBe(counts.operations * 2);
  expect(counts.boundaries).toBe(counts.operations * 6);
  expect(counts.schedules).toBe(process.env["DST_REPLAY"] || drain === "held" ? 1 : 40);
  console.info("outbound grammar coverage", { drain, ...counts });
});
