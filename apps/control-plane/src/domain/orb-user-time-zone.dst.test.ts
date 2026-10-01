import { describe, expect, it } from "vitest";
import { makeHarness, makeProjectRow, restartControlPlane } from "../testkit/fixtures.ts";
import { runDst } from "../testkit/sim.ts";
import { createOrb } from "./lifecycle.ts";

const projectId = "zone-project";
const orbId = "zone-orb";

describe("orb time zone snapshot (DST)", () => {
  it("retains an unknown snapshot after restart and rejects a later known zone", async () => {
    await runDst({ name: "zone-create-unknown-retry", iterations: 20 }, async (sim) => {
      let harness = makeHarness();
      harness.store.seedProject(makeProjectRow(projectId));
      const result = await sim.runTasks([
        {
          name: "unknown-create",
          f: async (task) => {
            expect((await createOrb(task, harness.deps, { orbId, projectId })).isOk()).toBe(true);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      harness = restartControlPlane(harness);
      const retry = await sim.runTasks([
        {
          name: "changed-retry",
          f: async (task) =>
            createOrb(task, harness.deps, { orbId, projectId, userTimeZone: "Asia/Tokyo" }),
        },
      ]);
      expect(retry.isOk() && retry.value[0]?.isErr() && retry.value[0].error.code).toBe("conflict");
      expect(harness.store.orbSnapshot(orbId)?.userTimeZone).toBeNull();
    });
  });

  for (const zones of [
    ["America/New_York", "Asia/Tokyo"],
    ["America/New_York", undefined],
    [undefined, "America/New_York"],
  ] as const) {
    it(`preserves the winning creation across concurrent requests and restart: ${zones.join(" / ")}`, async () => {
      await runDst(
        {
          name: `zone-create-${zones.map((zone) => zone?.split("/").join("-") ?? "unknown").join("-")}`,
          iterations: 40,
        },
        async (sim) => {
          let harness = makeHarness();
          harness.store.seedProject(makeProjectRow(projectId));
          const result = await sim.runTasks(
            zones.map((zone, index) => ({
              name: `create-${index}`,
              f: async (task) => {
                const created = await createOrb(task, harness.deps, {
                  orbId,
                  projectId,
                  ...(zone === undefined ? {} : { userTimeZone: zone }),
                });
                if (created.isErr()) expect(created.error.code).toBe("conflict");
                return created;
              },
            })),
          );
          expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
          if (result.isErr()) return;
          const outcomes = result.value;
          const accepted = outcomes.filter((outcome) => outcome.isOk());
          expect(accepted.length).toBeGreaterThan(0);
          const snapshot = harness.store.orbSnapshot(orbId);
          expect(
            new Set(accepted.map((outcome) => (outcome.isOk() ? outcome.value.userTimeZone : null)))
              .size,
          ).toBe(1);
          expect(snapshot?.userTimeZone).toBe(
            accepted[0]?.isOk() ? accepted[0].value.userTimeZone : undefined,
          );
          harness = restartControlPlane(harness);
          expect(harness.store.orbSnapshot(orbId)?.userTimeZone).toBe(snapshot?.userTimeZone);
          const retry = await sim.runTasks([
            {
              name: "retry",
              f: async (task) => createOrb(task, harness.deps, { orbId, projectId }),
            },
          ]);
          expect(retry.isOk() && retry.value[0]?.isOk()).toBe(true);
          expect(harness.store.orbSnapshot(orbId)?.userTimeZone).toBe(snapshot?.userTimeZone);
        },
      );
    });
  }
});
