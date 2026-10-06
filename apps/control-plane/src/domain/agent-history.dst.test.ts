import { describe, expect, it } from "vitest";
import { makeHarness, seedRunningOrb } from "../testkit/fixtures.ts";
import { runDst } from "../testkit/sim.ts";
import { commitAgentHistory } from "./agent-history.ts";

describe("central history projection schedules", () => {
  it("concurrent projections cannot duplicate entries", async () => {
    await runDst({ name: "central-history-projection", iterations: 20 }, async (sim) => {
      const harness = makeHarness();
      const result = await sim.runTasks([
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, "central");
            for (let i = 0; i < 4; i++) harness.world.appendMessage("central");
            const entries = harness.world.entriesOf("central");
            const snapshot = {
              orbId: "central",
              runtimeInstanceId: "central-worker",
              activity: "idle" as const,
              session: { id: "central-session", overflow: {} },
              records: entries,
              headId: entries.at(-1)?.id ?? null,
            };
            const projections = await Promise.all([
              commitAgentHistory(task, harness.deps, snapshot),
              commitAgentHistory(task, harness.deps, snapshot),
            ]);
            expect(projections.every((projection) => projection.isOk())).toBe(true);
            expect(harness.store.replicaRecords("central").map((record) => record.id)).toEqual(
              entries.map((record) => record.id),
            );
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });
});
