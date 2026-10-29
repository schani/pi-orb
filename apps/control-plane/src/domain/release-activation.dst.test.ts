import { err, ok } from "neverthrow";
import { describe, expect, it } from "vitest";
import { LogCapture, runDst, waitUntil } from "../testkit/sim.ts";
import {
  type ReleaseAuthority,
  waitForReleaseActivation,
  watchReleaseRetirement,
} from "./release-activation.ts";

describe("release startup authority (DST)", () => {
  it("keeps the new generation inert through missing authority and read failure until old workers retire", async () => {
    await runDst({ name: "release-startup-authority", iterations: 50 }, async (sim) => {
      let active: ReleaseAuthority | null = null;
      let reads = 0;
      let oldRunning = true;
      let started = false;
      const stop = new AbortController();
      const result = await sim.runTasks([
        {
          name: "new browser",
          f: async (task) => {
            started = await waitForReleaseActivation(
              task,
              {
                read: async (readerTask) => {
                  await readerTask.checkpoint("activation read");
                  reads += 1;
                  if (reads === 1) return err({ type: "release_activation_unavailable" as const });
                  return ok(active);
                },
              },
              42,
              stop.signal,
              () => {},
            );
            expect(oldRunning).toBe(false);
          },
        },
        {
          name: "release",
          f: async (task) => {
            await waitUntil(task, "observed unavailable and absent authority", () => reads >= 2);
            expect(started).toBe(false);
            active = { generation: 41, retireThroughGeneration: 0 };
            await task.checkpoint("old controller draining");
            expect(started).toBe(false);
            oldRunning = false;
            await task.checkpoint("confirmed old controllers retired");
            active = { generation: 42, retireThroughGeneration: 41 };
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(started).toBe(true);
    });
  });

  it("never reopens a superseded generation, even after an authority regression", async () => {
    await runDst({ name: "release-superseded", iterations: 20 }, async (sim) => {
      const stop = new AbortController();
      let reads = 0;
      const result = await sim.runTasks([
        {
          name: "stale browser",
          f: async (task) => {
            const started = await waitForReleaseActivation(
              task,
              {
                read: async (readerTask) => {
                  await readerTask.checkpoint("activation read");
                  reads += 1;
                  if (reads === 3) stop.abort();
                  return ok({ generation: reads === 1 ? 43 : 42, retireThroughGeneration: 0 });
                },
              },
              42,
              stop.signal,
              () => {},
            );
            expect(started).toBe(false);
            expect(reads).toBe(3);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });

  it("retires an activated predecessor through read failures while the successor stays gated until drain completes", async () => {
    const logs = new LogCapture();
    await runDst(
      { name: "release-cooperative-retirement", iterations: 50, logCapture: logs },
      async (sim) => {
        let authority: ReleaseAuthority = { generation: 41, retireThroughGeneration: 0 };
        let unavailable = false;
        let oldStarted = false;
        let oldRetired = false;
        let drained = false;
        let newWaiting = false;
        let newStarted = false;
        const oldStop = new AbortController();
        const newStop = new AbortController();
        const reader = {
          read: async (task: import("determined").SimulationTask) => {
            await task.checkpoint("read control object");
            return unavailable
              ? err({ type: "release_activation_unavailable" as const })
              : ok(authority);
          },
        };
        const result = await sim.runTasks([
          {
            name: "old process",
            f: async (task) => {
              oldStarted = await waitForReleaseActivation(
                task,
                reader,
                41,
                oldStop.signal,
                () => {},
              );
              expect(oldStarted).toBe(true);
              oldRetired = await watchReleaseRetirement(task, reader, 41, oldStop.signal);
              expect(oldRetired).toBe(true);
              // Drain and release ownership only after autonomous work has joined.
              await task.checkpoint("draining outstanding effects");
              expect(newStarted).toBe(false);
              drained = true;
            },
          },
          {
            name: "new process",
            f: async (task) => {
              newStarted = await waitForReleaseActivation(task, reader, 45, newStop.signal, () => {
                newWaiting = true;
              });
              expect(drained).toBe(true);
              expect(newStarted).toBe(true);
            },
          },
          {
            name: "release writer",
            f: async (task) => {
              await waitUntil(task, "both generations present", () => oldStarted && newWaiting);
              unavailable = true;
              await waitUntil(
                task,
                "old watcher observed outage",
                () => logs.matching("release-retirement-unavailable").length === 1,
              );
              expect(oldRetired).toBe(false);
              unavailable = false;
              // Non-consecutive generations: all predecessors, not just generation 44.
              authority = { generation: 41, retireThroughGeneration: 44 };
              await waitUntil(task, "old process drained", () => drained);
              expect(newStarted).toBe(false);
              authority = { generation: 45, retireThroughGeneration: 44 };
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        expect(logs.matching("release-retirement-observed")).toHaveLength(1);
        expect(logs.matching("release-retirement-recovered")).toHaveLength(1);
      },
    );
  });

  it.each([40, 41])("does not reactivate retired generation %i on restart", async (generation) => {
    await runDst({ name: `release-retired-restart-${generation}`, iterations: 20 }, async (sim) => {
      const result = await sim.runTasks([
        {
          name: "restarted process",
          f: async (task) => {
            const started = await waitForReleaseActivation(
              task,
              {
                read: async (readerTask) => {
                  await readerTask.checkpoint("read retirement on startup");
                  return ok({ generation: 41, retireThroughGeneration: 41 });
                },
              },
              generation,
              new AbortController().signal,
              () => {},
            );
            expect(started).toBe(false);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });
});
