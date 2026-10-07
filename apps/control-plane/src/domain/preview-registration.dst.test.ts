import { expect, it } from "vitest";
import { makeHarness, seedRunningOrb } from "../testkit/fixtures.ts";
import { runDst } from "../testkit/sim.ts";

it("preview admission and idle CAS serialize on current authority", async () => {
  await runDst({ name: "preview-store-admission-idle-race", iterations: 30 }, async (sim) => {
    const h = makeHarness();
    let protectedLease = false;
    let idleStopped = false;
    const seed = await sim.runTasks([
      {
        name: "seed",
        f: async (task) => {
          seedRunningOrb(task, h, "orb-a");
          const orb = h.store.orbSnapshot("orb-a");
          if (!orb || !orb.runtimeTokenHash) return;
          await h.store.registerPreview(task, {
            orbId: orb.id,
            port: 5173,
            registrationId: "r1",
            caller: {
              runtimeTokenHash: orb.runtimeTokenHash,
              hostIncarnation: orb.hostIncarnation,
            },
            now: task.wallNow(),
          });
        },
      },
    ]);
    expect(seed.isOk()).toBe(true);
    const original = h.store.orbSnapshot("orb-a");
    expect(original).not.toBeNull();
    if (!original || !original.runtimeTokenHash) return;
    const hash = original.runtimeTokenHash;
    const result = await sim.runTasks([
      {
        name: "preview",
        f: async (task) => {
          const outcome = await h.store.protectPreviewActivity(task, {
            orbId: original.id,
            port: 5173,
            registrationId: "r1",
            runtimeTokenHash: hash,
            hostIncarnation: original.hostIncarnation,
            now: task.wallNow(),
            activeUntil: task.wallNow() + 15_000,
          });
          protectedLease = outcome._unsafeUnwrap().type === "protected";
        },
      },
      {
        name: "idle",
        f: async (task) => {
          const outcome = await h.store.casTransition(task, {
            orbId: original.id,
            expectedStateVersion: original.stateVersion,
            toState: "stopping",
            stopReason: "idle",
            now: task.wallNow(),
          });
          idleStopped = outcome.isOk();
        },
      },
    ]);
    expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    expect(protectedLease || idleStopped).toBe(true);
    expect(protectedLease && idleStopped).toBe(false);
    expect(h.store.orbSnapshot(original.id)?.state).toBe(idleStopped ? "stopping" : "running");
  });
});
