import { ok } from "neverthrow";
import { describe, expect, it } from "vitest";
import { makeHarness, seedRunningOrb } from "../testkit/fixtures.ts";
import { runDst } from "../testkit/sim.ts";
import { requestOrbStop } from "./lifecycle.ts";
import {
  drainMaintenance,
  inventoryMaintenance,
  resumeMaintenance,
  validateFinalMaintenance,
} from "./maintenance.ts";

const ORB = "maintenance-orb";
const fence = {
  phase: "preapply-resume" as const,
  legacyIntentWritersRetired: true as const,
  candidateExposed: false as const,
};
describe("maintenance lifecycle", () => {
  for (const sleeping of [false, true]) {
    it(`admits only preapply intent without starting hosts (sleep=${sleeping})`, async () => {
      await runDst({ name: `maintenance-preapply-${sleeping}`, iterations: 20 }, async (sim) => {
        const h = makeHarness();
        const result = await sim.runTasks([
          {
            name: "driver",
            f: async (task) => {
              seedRunningOrb(task, h, ORB);
              if (sleeping) {
                const orb = (await h.deps.store.getOrb(task, ORB))._unsafeUnwrap()!;
                h.store.seedOrb({ ...orb, sleepId: "future", sleepUntil: task.wallNow() + 60_000 });
              }
              const drained = (
                await drainMaintenance(
                  task,
                  h.deps,
                  {
                    seal: async (key, snapshot) => {
                      if (key === "pre") expect(snapshot.orbs[0]?.state).toBe("running");
                      return ok({
                        receiptUri: "gs://private/pre",
                        generation: "1",
                        sha256: "hash",
                      });
                    },
                  },
                  "release",
                  30_000,
                )
              )._unsafeUnwrap();
              const final = (
                await inventoryMaintenance(task, h.deps, "release", "final", drained)
              )._unsafeUnwrap();
              const starts = h.world.hostStartCountOf(ORB);
              expect(
                (
                  await resumeMaintenance(task, h.deps, final, { ...fence, candidateExposed: true })
                ).isErr(),
              ).toBe(true);
              expect(
                (
                  await resumeMaintenance(task, h.deps, final, {
                    ...fence,
                    legacyIntentWritersRetired: false,
                  })
                ).isErr(),
              ).toBe(true);
              expect((await resumeMaintenance(task, h.deps, drained, fence)).isErr()).toBe(true);
              const resumed = await resumeMaintenance(task, h.deps, final, fence);
              if (resumed.isErr()) {
                // DST can fire observation deadlines before provider completion.
                expect(resumed.error.code).toBe("unsafe");
                expect((await h.deps.store.getOrb(task, ORB))._unsafeUnwrap()!.state).toBe(
                  "stopped",
                );
                expect(h.world.hostStartCountOf(ORB)).toBe(starts);
                return;
              }
              expect(resumed.value).toEqual({
                resumed: sleeping ? 0 : 1,
                deferred: sleeping ? 1 : 0,
              });
              expect(h.world.hostStartCountOf(ORB)).toBe(starts);
              const admitted = (await h.deps.store.getOrb(task, ORB))._unsafeUnwrap()!;
              expect(admitted.state).toBe(sleeping ? "stopped" : "starting");
              expect(admitted.sleepId).toBe(sleeping ? "future" : null);
              if (!sleeping) {
                await requestOrbStop(task, h.deps, ORB);
                expect((await resumeMaintenance(task, h.deps, final, fence)).isErr()).toBe(true);
                expect((await h.deps.store.getOrb(task, ORB))._unsafeUnwrap()!.state).toBe(
                  "stopping",
                );
              }
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      });
    });
  }
  it("final fence never repairs and unproven stopped rows never resume", async () => {
    await runDst({ name: "maintenance-final-fence", iterations: 20 }, async (sim) => {
      const h = makeHarness();
      const result = await sim.runTasks([
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, h, ORB);
            const starts = h.world.hostStartCountOf(ORB);
            const snapshot = (
              await inventoryMaintenance(task, h.deps, "release", "final")
            )._unsafeUnwrap();
            expect((await validateFinalMaintenance(task, h.deps, snapshot)).isErr()).toBe(true);
            expect((await resumeMaintenance(task, h.deps, snapshot, fence)).isErr()).toBe(true);
            expect(h.world.hostStartCountOf(ORB)).toBe(starts);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });
});
