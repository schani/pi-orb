import { err, ok } from "neverthrow";
import { describe, expect, it } from "vitest";
import { LogCapture, runDst, waitUntil } from "../testkit/sim.ts";
import { type Rollout, RolloutSocketRetirement, watchRolloutSockets } from "./rollout-sockets.ts";

const rollout: Rollout = {
  releaseId: "release-42",
  phase: "retire",
  generation: 42,
  resources: ["old-revision"],
  servingRevision: "new-revision",
};

describe("rollout-only socket retirement", () => {
  it.each([
    { ...rollout, phase: "repair" },
    { ...rollout, phase: "activate" },
    { ...rollout, generation: 41 },
    { ...rollout, resources: ["another-old-revision"] },
    { ...rollout, servingRevision: "old-revision" },
    null,
  ])("ignores non-targets: %j", async (candidate) => {
    await runDst({ name: "rollout-nontarget", iterations: 5 }, async (sim) => {
      const sockets = new RolloutSocketRetirement();
      let closed = 0;
      sockets.register(() => {
        closed++;
      });
      const stop = new AbortController();
      let reads = 0;
      const result = await sim.runTasks([
        {
          name: "watcher",
          f: async (task) => {
            await watchRolloutSockets(
              task,
              {
                read: async (t) => {
                  await t.checkpoint("rollout read");
                  if (++reads === 2) stop.abort();
                  return ok(candidate);
                },
              },
              "old-revision",
              41,
              sockets,
              stop.signal,
            );
          },
        },
      ]);
      expect(result.isOk()).toBe(true);
      expect(closed).toBe(0);
      expect(sockets.retirement).toBeNull();
    });
  });

  it("survives read failures, closes once, and permanently rejects new registrations", async () => {
    const logs = new LogCapture();
    await runDst({ name: "rollout-retirement", iterations: 30, logCapture: logs }, async (sim) => {
      const sockets = new RolloutSocketRetirement();
      let closed = 0;
      sockets.register(() => {
        closed++;
      });
      const remove = sockets.register(() => {
        closed += 100;
      });
      remove?.();
      let reads = 0;
      const stop = new AbortController();
      const result = await sim.runTasks([
        {
          name: "watcher",
          f: async (task) => {
            await watchRolloutSockets(
              task,
              {
                read: async (t) => {
                  await t.checkpoint("read release");
                  reads++;
                  if (reads === 1) return err({ type: "rollout_read_unavailable" as const });
                  return ok(reads === 2 ? null : rollout);
                },
              },
              "old-revision",
              41,
              sockets,
              stop.signal,
            );
          },
        },
      ]);
      expect(result.isOk()).toBe(true);
      expect(reads).toBe(3);
      expect(logs.matching("rollout-socket-read-unavailable")).toHaveLength(1);
      expect(logs.matching("rollout-socket-read-recovered")).toHaveLength(1);
      expect(logs.matching("rollout-sockets-retired")[0]).toContain(
        "releaseId=release-42 revision=old-revision generation=42 socketCount=1 cause=old_revision_rollout",
      );
      expect(closed).toBe(1);
      expect(
        sockets.register(() => {
          closed++;
        }),
      ).toBeNull();
      expect(sockets.retire({ releaseId: "later", revision: "old-revision" })).toBe(0);
      expect(closed).toBe(1);
      expect(sockets.retirement?.releaseId).toBe("release-42");
    });
  });
  it("serializes concurrent connection admission/disconnect against retirement", async () => {
    await runDst({ name: "rollout-concurrent-connections", iterations: 100 }, async (sim) => {
      const sockets = new RolloutSocketRetirement();
      let retired = false;
      let sawRead = false;
      let admitted = 0;
      let closed = 0;
      let disconnected = false;
      const result = await sim.runTasks([
        {
          name: "watcher",
          f: async (task) => {
            await watchRolloutSockets(
              task,
              {
                read: async (t) => {
                  sawRead = true;
                  await t.checkpoint("release retirement becomes visible");
                  return ok(rollout);
                },
              },
              "old-revision",
              41,
              sockets,
              new AbortController().signal,
            );
            retired = true;
          },
        },
        {
          name: "connections",
          f: async (task) => {
            await waitUntil(task, "watcher reading", () => sawRead);
            await task.checkpoint("connection arrives during rollout");
            const remove = sockets.register(() => {
              expect(disconnected).toBe(false);
              closed++;
              expect(closed).toBe(1);
            });
            if (remove !== null) admitted++;
            await task.checkpoint("peer disconnect races retirement");
            if (remove !== null) {
              disconnected = true;
              remove();
            }
            await waitUntil(task, "retirement latched", () => retired);
            expect(
              sockets.register(() => {
                closed += 100;
              }),
            ).toBeNull();
          },
        },
      ]);
      expect(result.isOk()).toBe(true);
      expect(closed).toBeLessThanOrEqual(admitted);
      expect(sockets.retirement?.releaseId).toBe("release-42");
    });
  });

  it("does not retire from a read completed after shutdown", async () => {
    const logs = new LogCapture();
    await runDst(
      { name: "rollout-aborted-read", iterations: 30, logCapture: logs },
      async (sim) => {
        const stop = new AbortController();
        const sockets = new RolloutSocketRetirement();
        let reading = false;
        let closed = 0;
        sockets.register(() => {
          closed++;
        });
        const result = await sim.runTasks([
          {
            name: "watcher",
            f: async (task) => {
              await watchRolloutSockets(
                task,
                {
                  read: async (t) => {
                    reading = true;
                    await waitUntil(t, "read abort", () => stop.signal.aborted);
                    return ok(rollout);
                  },
                },
                "old-revision",
                41,
                sockets,
                stop.signal,
              );
            },
          },
          {
            name: "shutdown",
            f: async (task) => {
              await waitUntil(task, "read in flight", () => reading);
              stop.abort();
            },
          },
        ]);
        expect(result.isOk()).toBe(true);
        expect(sockets.retirement).toBeNull();
        expect(closed).toBe(0);
        expect(logs.lines()).toEqual([]);
      },
    );
  });
});
