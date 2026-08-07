import type { SimulationTask } from "determined";
import { ok, type Result, ResultAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { makeHarness, makeOrbRow, makeProjectRow } from "../testkit/fixtures.ts";
import { runDst } from "../testkit/sim.ts";
import { generateOrbName, type OrbNameGenerator, setOrbName } from "./orb-naming.ts";
import type { OperationContext, OrbNameGeneratorError } from "./ports.ts";

class PausingGenerator implements OrbNameGenerator {
  calls = 0;

  generate(
    task: SimulationTask,
    _input: { projectName: string; repositoryUrl: string; message: string; readme: string | null },
    _context: OperationContext,
  ): ResultAsync<string, OrbNameGeneratorError> {
    this.calls += 1;
    const run = async (): Promise<Result<string, OrbNameGeneratorError>> => {
      await task.sleep(20, "luna response");
      return ok("Fix WebSocket Reconnects");
    };
    return new ResultAsync(run());
  }
}

describe("orb auto-naming DST", () => {
  it("coalesces concurrent triggers and assigns one generated name", async () => {
    await runDst({ name: "auto-name-coalescing", iterations: 20 }, async (sim) => {
      const harness = makeHarness();
      harness.store.seedProject(makeProjectRow("project"));
      harness.store.seedOrb(makeOrbRow("orb", "project", "running"));
      const generator = new PausingGenerator();
      const deps = { store: harness.store, generator, leaseMs: 30_000 };
      const result = await sim.runTasks([
        {
          name: "trigger-a",
          f: async (task) =>
            await generateOrbName(task, deps, "orb", {
              message: "Fix reconnect races",
              readme: "# Example",
            }),
        },
        {
          name: "trigger-b",
          f: async (task) =>
            await generateOrbName(task, deps, "orb", {
              message: "Fix reconnect races",
              readme: "# Example",
            }),
        },
      ]);
      expect(result.isOk()).toBe(true);
      expect(generator.calls).toBe(1);
      expect(harness.store.orbSnapshot("orb")?.name).toBe("Fix WebSocket Reconnects");
    });
  });

  it("never overwrites a user name set while Luna is running", async () => {
    await runDst({ name: "manual-name-wins", iterations: 20 }, async (sim) => {
      const harness = makeHarness();
      harness.store.seedProject(makeProjectRow("project"));
      harness.store.seedOrb(makeOrbRow("orb", "project", "running"));
      const generator = new PausingGenerator();
      const result = await sim.runTasks([
        {
          name: "generation",
          f: async (task) =>
            await generateOrbName(
              task,
              { store: harness.store, generator, leaseMs: 30_000 },
              "orb",
              { message: "Repair auth", readme: null },
            ),
        },
        {
          name: "user rename",
          f: async (task) => {
            await task.sleep(10, "rename during Luna");
            return setOrbName(task, harness.store, "orb", "My Manual Name", task.wallNow());
          },
        },
      ]);
      expect(result.isOk()).toBe(true);
      expect(harness.store.orbSnapshot("orb")?.name).toBe("My Manual Name");
    });
  });
});
