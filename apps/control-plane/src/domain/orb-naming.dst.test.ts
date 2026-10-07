import type { SimulationTask } from "determined";
import { errAsync, ok, type Result, ResultAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { makeHarness, makeOrbRow, makeProjectRow } from "../testkit/fixtures.ts";
import { LogCapture, runDst } from "../testkit/sim.ts";
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
  it("uses Luna for Claude naming when Codex is connected", async () => {
    await runDst({ name: "claude-name-assigned", iterations: 5 }, async (sim) => {
      const harness = makeHarness();
      harness.store.seedProject(makeProjectRow("project"));
      harness.store.seedOrb(makeOrbRow("orb", "project", "running", { harness: "claude" }));
      const generator = new PausingGenerator();
      const result = await sim.runTasks([
        {
          name: "name",
          f: async (task) => {
            expect(
              (
                await generateOrbName(
                  task,
                  { store: harness.store, generator, leaseMs: 30_000 },
                  "orb",
                  { message: "Work", readme: null },
                )
              )._unsafeUnwrap(),
            ).toBe("assigned");
          },
        },
      ]);
      expect(result.isOk()).toBe(true);
      expect(generator.calls).toBe(1);
      expect(harness.store.orbSnapshot("orb")?.name).toBe("Fix WebSocket Reconnects");
    });
  });
  it.each([
    ["claude", "credential_absent", "skipped"],
    ["pi", "credential_absent", "error"],
    ["claude", "generation", "error"],
  ] as const)("%s handles %s as %s", async (harnessKind, code, outcome) => {
    await runDst({ name: `name-${harnessKind}-${code}`, iterations: 5 }, async (sim) => {
      const harness = makeHarness();
      harness.store.seedProject(makeProjectRow("project"));
      harness.store.seedOrb(makeOrbRow("orb", "project", "running", { harness: harnessKind }));
      const generator: OrbNameGenerator = {
        generate: () =>
          errAsync({
            type: "orb_name_generation_error",
            code,
            message: "unavailable",
            retryable: true,
          }),
      };
      const result = await sim.runTasks([
        {
          name: "name",
          f: async (task) => {
            const generated = await generateOrbName(
              task,
              { store: harness.store, generator, leaseMs: 30_000 },
              "orb",
              { message: "Work", readme: null },
            );
            if (outcome === "skipped") expect(generated._unsafeUnwrap()).toBe("skipped");
            else expect(generated.isErr()).toBe(true);
            expect(harness.store.orbSnapshot("orb")?.autoNameLeaseUntil).toBeNull();
            expect(harness.store.orbSnapshot("orb")?.autoNameNextAttemptAt).toBeGreaterThan(
              task.wallNow(),
            );
          },
        },
      ]);
      expect(result.isOk()).toBe(true);
    });
  });
  it("logs absent Codex once and recovers when connected", async () => {
    const logs = new LogCapture();
    await runDst(
      { name: "claude-name-connection-recovery", iterations: 5, logCapture: logs },
      async (sim) => {
        const harness = makeHarness();
        harness.store.seedProject(makeProjectRow("project"));
        harness.store.seedOrb(makeOrbRow("orb", "project", "running", { harness: "claude" }));
        let connected = false;
        const generator: OrbNameGenerator = {
          generate: () =>
            connected
              ? ResultAsync.fromSafePromise(Promise.resolve("Recovered name"))
              : errAsync({
                  type: "orb_name_generation_error",
                  code: "credential_absent",
                  message: "model authentication required",
                  retryable: true,
                }),
        };
        const deps = { store: harness.store, generator, leaseMs: 30_000 };
        const result = await sim.runTasks([
          {
            name: "naming",
            f: async (task) => {
              const trigger = () =>
                generateOrbName(task, deps, "orb", { message: "Work", readme: null });
              expect((await trigger())._unsafeUnwrap()).toBe("skipped");
              expect((await trigger())._unsafeUnwrap()).toBe("backoff");
              await task.sleep(5_000, "first backoff");
              expect((await trigger())._unsafeUnwrap()).toBe("skipped");
              connected = true;
              await task.sleep(10_000, "second backoff");
              expect((await trigger())._unsafeUnwrap()).toBe("assigned");
            },
          },
        ]);
        expect(result.isOk()).toBe(true);
        expect(logs.matching("auto-name-skipped")).toEqual([
          "naming: lifecycle: orb=orb auto-name-skipped reason=codex_not_connected",
        ]);
        expect(logs.matching("auto-name-failed")).toEqual([]);
        expect(harness.store.orbSnapshot("orb")?.name).toBe("Recovered name");
      },
    );
  });
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
