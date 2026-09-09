import { err, ok } from "neverthrow";
import { describe, expect, it } from "vitest";
import { runDst, waitUntil } from "../testkit/sim.ts";
import { waitForReleaseActivation } from "./release-activation.ts";

describe("release startup authority (DST)", () => {
  it("keeps the new generation inert through missing authority and read failure until old workers retire", async () => {
    await runDst({ name: "release-startup-authority", iterations: 50 }, async (sim) => {
      let active: number | null = null;
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
            active = 41;
            await task.checkpoint("old controller draining");
            expect(started).toBe(false);
            oldRunning = false;
            await task.checkpoint("confirmed old controllers retired");
            active = 42;
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
                  return ok(reads === 1 ? 43 : 42);
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
});
