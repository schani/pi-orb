import { errAsync, okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { makeHarness, restartControlPlane, seedRunningOrb } from "../testkit/fixtures.ts";
import { runDst, waitUntil } from "../testkit/sim.ts";
import { reconcileOrbOnce, requestOrbStop } from "./lifecycle.ts";
import type { OrbRow } from "./orb.ts";
import { pollOrbUntilCaughtUp } from "./replication.ts";
import { handleFailedRuntime } from "./runtime-recovery.ts";

const episode = "a".repeat(64);
it("preserves typed invariant failure from the atomic claim", async () => {
  await runDst({ name: "claude-recovery-claim-invariant", iterations: 1 }, async (sim) => {
    const h = makeHarness();
    const result = await sim.runTasks([
      {
        name: "driver",
        f: async (task) => {
          seedRunningOrb(task, h, "orb");
          const row = { ...h.store.orbSnapshot("orb")!, harness: "claude" as const };
          const deps = {
            ...h.deps,
            store: new Proxy(h.deps.store, {
              get(target, key) {
                if (key === "failOrbAndRequestComputeDiscard")
                  return () =>
                    errAsync({
                      type: "store_error",
                      code: "invariant",
                      message: "claim invariant",
                    });
                const value = Reflect.get(target, key);
                return typeof value === "function" ? value.bind(target) : value;
              },
            }),
          };
          expect(await handleFailedRuntime(task, deps, row, failedHealth)).toMatchObject({
            error: { code: "invariant" },
          });
          expect(h.store.orbSnapshot("orb")?.state).toBe("running");
        },
      },
    ]);
    expect(result.isOk(), result.isErr() ? result.error.message : undefined).toBe(true);
  });
});

const failedHealth = {
  v: 1 as const,
  orbId: "orb",
  runtimeInstanceId: "old",
  status: "failed" as const,
  error: { code: "claude_child_recovery_required", message: "uncertain", retryable: false },
  recovery: { episode },
};

it.each([false, true])(
  "atomic claim competes with another controller and Stop=%s",
  async (stop) => {
    await runDst({ name: `claude-recovery-claim-race-${stop}`, iterations: 40 }, async (sim) => {
      const h = makeHarness();
      let original: OrbRow | null = null;
      const result = await sim.runTasks([
        {
          name: "seed",
          f: async (task) => {
            seedRunningOrb(task, h, "orb");
            original = { ...h.store.orbSnapshot("orb")!, harness: "claude" };
            h.store.seedOrb(original);
          },
        },
        ...["first", "second"].map((name) => ({
          name,
          f: async (task: import("determined").SimulationTask) => {
            await waitUntil(task, "seed", () => original !== null);
            await handleFailedRuntime(task, h.deps, original!, failedHealth);
          },
        })),
        {
          name: "stop",
          f: async (task) => {
            await waitUntil(task, "seed", () => original !== null);
            if (stop) await requestOrbStop(task, h.deps, "orb");
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : undefined).toBe(true);
      const row = h.store.orbSnapshot("orb")!;
      if (stop) expect(row.state).toBe("stopping");
      else {
        expect(row.state).toBe("starting");
        expect(row.stateVersion).toBe(1);
      }
      if (!stop || row.claudeRecovery !== undefined) expect(row.runtimeTokenHash).toBeNull();
    });
  },
);

it("verified disposal survives finalization failure and controller restart; repeated episode exhausts", async () => {
  await runDst({ name: "claude-recovery-finalize-crash", iterations: 40 }, async (sim) => {
    const h = makeHarness();
    const result = await sim.runTasks([
      {
        name: "driver",
        f: async (task) => {
          seedRunningOrb(task, h, "orb");
          h.store.seedOrb({ ...h.store.orbSnapshot("orb")!, harness: "claude" });
          const before = h.store.orbSnapshot("orb")!;
          for (let i = 0; i < 100 && h.store.orbSnapshot("orb")?.state === "running"; i++)
            await handleFailedRuntime(task, h.deps, before, failedHealth);
          h.store.failNextHostDiscardFinalizations(1);
          for (let i = 0; i < 100 && h.world.hostCount("orb") > 0; i++)
            await reconcileOrbOnce(task, h.deps, "orb");
          expect(h.store.orbSnapshot("orb")?.claudeRecovery?.verified).toBe(false);
          const restarted = restartControlPlane(h);
          for (
            let i = 0;
            i < 100 && h.store.orbSnapshot("orb")?.hostDiscardThroughIncarnation !== null;
            i++
          )
            await reconcileOrbOnce(task, restarted.deps, "orb");
          expect(h.store.orbSnapshot("orb")?.claudeRecovery?.verified).toBe(true);
          const replacement = h.store.orbSnapshot("orb")!;
          for (let i = 0; i < 100 && h.store.orbSnapshot("orb")?.state !== "failed"; i++)
            await handleFailedRuntime(task, restarted.deps, replacement, failedHealth);
          expect(h.store.orbSnapshot("orb")?.lastError).toContain("exhausted");
          expect(h.store.orbSnapshot("orb")?.claudeRecovery?.episode).toBe(episode);
        },
      },
    ]);
    expect(result.isOk(), result.isErr() ? result.error.message : undefined).toBe(true);
  });
});

it.each(["generic", "io", "missing-episode", "sleep", "process-scope", "stale-deploy"])(
  "does not authorize replacement for %s",
  async (kind) => {
    await runDst({ name: `claude-recovery-ineligible-${kind}`, iterations: 10 }, async (sim) => {
      const h = makeHarness();
      const result = await sim.runTasks([
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, h, "orb");
            const row = {
              ...h.store.orbSnapshot("orb")!,
              harness: "claude" as const,
              ...(kind === "sleep" ? { sleepId: "sleep", sleepUntil: task.wallNow() + 1000 } : {}),
            };
            h.store.seedOrb(row);
            const health =
              kind === "missing-episode"
                ? { ...failedHealth, recovery: undefined }
                : {
                    ...failedHealth,
                    error: {
                      ...failedHealth.error,
                      code:
                        kind === "generic"
                          ? "other"
                          : kind === "io"
                            ? "claude_handoff_recovery_failed"
                            : failedHealth.error.code,
                    },
                  };
            const deps = {
              ...h.deps,
              hostProvider: new Proxy(h.deps.hostProvider, {
                get(target, key) {
                  if (kind === "process-scope" && key === "verifiesWholeComputeDisposal")
                    return undefined;
                  if (kind === "stale-deploy" && key === "specGeneration") return -1;
                  const value = Reflect.get(target, key);
                  return typeof value === "function" ? value.bind(target) : value;
                },
              }),
            };
            await handleFailedRuntime(task, deps, row, health as typeof failedHealth);
            expect(h.store.orbSnapshot("orb")?.claudeRecovery).toBeUndefined();
            expect(h.store.orbSnapshot("orb")?.state).not.toBe("starting");
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : undefined).toBe(true);
    });
  },
);
it("reachable failed Claude guard claims one fenced replacement after failed pull", async () => {
  await runDst({ name: "claude-recovery-reachable", iterations: 10 }, async (sim) => {
    const h = makeHarness();
    const result = await sim.runTasks([
      {
        name: "driver",
        f: async (task) => {
          seedRunningOrb(task, h, "orb");
          const original = h.store.orbSnapshot("orb")!;
          h.store.seedOrb({ ...original, harness: "claude" });
          const deps = {
            ...h.deps,
            runtimeClient: new Proxy(h.deps.runtimeClient, {
              get(target, key) {
                if (key === "pullHistory")
                  return () =>
                    errAsync({
                      type: "runtime_client" as const,
                      code: "not_ready",
                      message: "failed",
                      retryable: true,
                      answered: true,
                    });
                if (key === "health")
                  return () =>
                    okAsync({
                      v: 1 as const,
                      orbId: "orb",
                      runtimeInstanceId: "old",
                      status: "failed" as const,
                      error: {
                        code: "claude_child_recovery_required",
                        message: "uncertain",
                        retryable: false,
                      },
                      recovery: { episode },
                    });
                const value = Reflect.get(target, key);
                return typeof value === "function" ? value.bind(target) : value;
              },
            }),
          };
          for (let i = 0; i < 100 && h.store.orbSnapshot("orb")?.state === "running"; i++)
            await pollOrbUntilCaughtUp(task, deps, "orb", 1);
          const claimed = h.store.orbSnapshot("orb")!;
          expect(claimed.state).toBe("starting");
          expect(claimed.runtimeTokenHash).toBeNull();
          expect(claimed.hostDiscardThroughIncarnation).toBe(original.hostIncarnation);
          expect(claimed.claudeRecovery?.episode).toBe(episode);
          expect(claimed.claudeRecovery?.verified).toBe(false);
          for (
            let i = 0;
            i < 100 && h.store.orbSnapshot("orb")?.hostDiscardThroughIncarnation !== null;
            i++
          )
            await reconcileOrbOnce(task, deps, "orb");
          const verified = h.store.orbSnapshot("orb")!;
          expect(verified.claudeRecovery?.verified).toBe(true);
          expect(verified.hostIncarnation).toBe(original.hostIncarnation + 1);
          await requestOrbStop(task, deps, "orb");
          await reconcileOrbOnce(task, deps, "orb");
          expect(h.store.orbSnapshot("orb")?.state).not.toBe("running");
        },
      },
    ]);
    expect(result.isOk(), result.isErr() ? result.error.message : undefined).toBe(true);
  });
});
