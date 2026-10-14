import type { RuntimeEvent, ServerFrame } from "@pi-orb/protocol";
import { expect, it } from "vitest";
import { OutboundWriter } from "../../../orb-runtime/src/domain/outbound.ts";
import { runDst } from "../../../orb-runtime/src/testkit/sim.ts";
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
