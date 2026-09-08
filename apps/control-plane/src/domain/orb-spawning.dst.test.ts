import { describe, expect, it } from "vitest";
import { FAILPOINTS } from "../testkit/failpoints.ts";
import {
  makeHarness,
  makeOrbRow,
  makeProjectRow,
  restartControlPlane,
} from "../testkit/fixtures.ts";
import { runDst, waitUntil } from "../testkit/sim.ts";
import { pollLoop, reconcileLoop } from "./loops.ts";

const projectId = "spawn-project";
const caller = makeOrbRow("caller", projectId, "running", {
  runtimeTokenHash: "token",
  hostIncarnation: 1,
});
const params = {
  callerOrbId: caller.id,
  caller: { runtimeTokenHash: "token", hostIncarnation: 1 },
  orb: makeOrbRow("spawned", projectId, "creating"),
  prompt: "Do the work",
  requestHash: "same-request",
};

function seed() {
  const harness = makeHarness();
  harness.store.seedProject(makeProjectRow(projectId));
  harness.store.seedOrb(caller);
  return harness;
}

describe("orb spawning (DST)", () => {
  it("commits one child and one prompt under concurrent retries and response loss", async () => {
    await runDst(
      {
        name: "spawn-retry-restart",
        iterations: 40,
        failpointProbabilities: { [FAILPOINTS.storeWrite]: 0.2 },
      },
      async (sim) => {
        let harness = seed();
        const result = await sim.runTasks(
          [0, 1].map((n) => ({
            name: `spawn-${n}`,
            f: async (task) => {
              for (let attempt = 0; attempt < 30; attempt++) {
                const accepted = await harness.store.spawnOrb(task, params);
                if (accepted.isErr()) {
                  expect(accepted.error.type).toBe("store_error");
                  continue;
                }
                // Deliberately lose the acceptance response, then restart the control plane.
                harness = restartControlPlane(harness);
                break;
              }
            },
          })),
        );
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        expect(harness.store.orbSnapshot(params.orb.id)?.state).toBe("creating");
        expect(harness.store.messageSnapshots(params.orb.id)).toMatchObject([
          { messageId: params.orb.id, content: [{ type: "text", text: params.prompt }] },
        ]);
        expect(harness.store.messageSnapshots(params.orb.id)).toHaveLength(1);
      },
    );
  });

  it("starts and delivers after acceptance loses its caller and reconcile nudge", async () => {
    await runDst({ name: "spawn-unattended-recovery", iterations: 20 }, async (sim) => {
      let harness = seed();
      harness.world.configureOrb(params.orb.id, { initDurationMs: 0 });
      let ready = false;
      const stop = new AbortController();
      const result = await sim.runTasks([
        {
          name: "driver",
          f: async (task) => {
            expect((await harness.store.spawnOrb(task, params)).isOk()).toBe(true);
            harness.store.seedOrb({ ...caller, state: "archived", runtimeTokenHash: null });
            harness = restartControlPlane(harness);
            ready = true;
            await waitUntil(
              task,
              "spawned prompt replicated",
              () => harness.store.messageSnapshots(params.orb.id)[0]?.status === "delivered",
              { timeoutMs: 300_000 },
            );
            stop.abort();
          },
        },
        {
          name: "reconciler",
          f: async (task) => {
            await waitUntil(task, "acceptance committed", () => ready);
            await reconcileLoop(task, harness.deps, stop.signal);
          },
        },
        {
          name: "poller",
          f: async (task) => {
            await waitUntil(task, "acceptance committed", () => ready);
            await pollLoop(task, harness.deps, stop.signal);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      const records = harness.store.replicaRecords(params.orb.id);
      expect(
        records.filter((record) => JSON.stringify(record).includes(params.prompt)),
      ).toHaveLength(1);
      expect(harness.world.hostCount(params.orb.id)).toBe(1);
    });
  });

  it("serializes conflicting prompts without replacing the winner", async () => {
    await runDst({ name: "spawn-conflicting-retries", iterations: 40 }, async (sim) => {
      const harness = seed();
      const accepted: string[] = [];
      const result = await sim.runTasks(
        ["alpha", "beta"].map((prompt) => ({
          name: prompt,
          f: async (task) => {
            const outcome = await harness.store.spawnOrb(task, {
              ...params,
              prompt,
              requestHash: prompt,
            });
            if (outcome.isOk()) accepted.push(prompt);
            else expect(outcome.error.type).toBe("spawn_conflict");
          },
        })),
      );
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(accepted).toHaveLength(1);
      expect(harness.store.messageSnapshots(params.orb.id)).toMatchObject([
        { content: [{ type: "text", text: accepted[0] }] },
      ]);
    });
  });

  for (const fence of [
    "project-delete",
    "caller-stop",
    "caller-replace",
    "caller-discard",
  ] as const) {
    it(`serializes acceptance against ${fence}`, async () => {
      await runDst({ name: `spawn-${fence}`, iterations: 40 }, async (sim) => {
        const harness = seed();
        const result = await sim.runTasks([
          {
            name: "spawn",
            f: async (task) => {
              const accepted = await harness.store.spawnOrb(task, params);
              if (accepted.isErr()) expect(accepted.error.type).toBe("spawn_conflict");
            },
          },
          {
            name: "fence",
            f: async (task) => {
              if (fence === "project-delete") {
                expect(
                  (
                    await harness.store.requestProjectDeletion(task, {
                      projectId,
                      now: task.wallNow(),
                      cleanupAfter: task.wallNow(),
                    })
                  ).isOk(),
                ).toBe(true);
              } else {
                await task.sleep(1, "retire caller");
                harness.store.seedOrb({
                  ...caller,
                  ...(fence === "caller-stop"
                    ? { state: "stopping" as const }
                    : fence === "caller-replace"
                      ? { runtimeTokenHash: "replacement", hostIncarnation: 2 }
                      : { hostDiscardThroughIncarnation: 1 }),
                });
              }
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        const child = harness.store.orbSnapshot(params.orb.id);
        expect(harness.store.messageSnapshots(params.orb.id)).toHaveLength(child === null ? 0 : 1);
        if (child !== null && fence === "project-delete") expect(child.state).toBe("deleting");
      });
    });
  }
});
