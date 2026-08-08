import type { SimulationTask } from "determined";
import { ResultAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { makeHarness, makeOrbRow, makeProjectRow } from "../testkit/fixtures.ts";
import { runDst, TEST_WALL_EPOCH } from "../testkit/sim.ts";
import { SerializedAuthGate } from "./auth-gates.ts";
import {
  ReconcileDispatcher,
  type ReconcileOne,
  type ReconcileTaskRunner,
  reconcileLoop,
} from "./loops.ts";
import type { ControlPlaneStore } from "./ports.ts";

const BLOCKED_ORBS = ["cleanup-a", "cleanup-b", "cleanup-c"] as const;
const NEW_ORB = "new-create";
const PROJECT = "project";
const ALL_ORBS = [...BLOCKED_ORBS, NEW_ORB] as const;

type ReconcileJob = {
  readonly run: (task: SimulationTask) => Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
};

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * `determined` models concurrency with distinct SimulationTasks. Production
 * creates one real-time task per dispatched orb; this mailbox gives each
 * statically declared DST worker its own task while exercising the same
 * dispatcher contract.
 */
class SimulationReconcileTaskRunner {
  private readonly queued = new Map<string, ReconcileJob>();
  private readonly waiting = new Map<string, (job: ReconcileJob | null) => void>();

  readonly run: ReconcileTaskRunner = (orbId, operation) =>
    new Promise<void>((resolve, reject) => {
      const job = { run: operation, resolve, reject };
      const waiter = this.waiting.get(orbId);
      if (waiter !== undefined) {
        this.waiting.delete(orbId);
        waiter(job);
        return;
      }
      if (this.queued.has(orbId)) throw new Error(`duplicate queued reconcile for ${orbId}`);
      this.queued.set(orbId, job);
    });

  async worker(task: SimulationTask, orbId: string, stop: AbortSignal): Promise<void> {
    while (!stop.aborted) {
      const job = await this.next(orbId, stop);
      if (job === null) return;
      try {
        await job.run(task);
        job.resolve();
      } catch (error) {
        job.reject(error);
      }
    }
  }

  private next(orbId: string, stop: AbortSignal): Promise<ReconcileJob | null> {
    const queued = this.queued.get(orbId);
    if (queued !== undefined) {
      this.queued.delete(orbId);
      return Promise.resolve(queued);
    }
    if (stop.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      const onAbort = (): void => {
        this.waiting.delete(orbId);
        resolve(null);
      };
      stop.addEventListener("abort", onAbort, { once: true });
      this.waiting.set(orbId, (job) => {
        stop.removeEventListener("abort", onAbort);
        resolve(job);
      });
    });
  }
}

describe("reconcile concurrency (DST)", () => {
  it("dispatches new orbs while others are blocked and allows at most one task per orb", async () => {
    await runDst({ name: "cross-orb-reconcile-concurrency", iterations: 30 }, async (sim) => {
      const harness = makeHarness();
      harness.store.seedProject(makeProjectRow(PROJECT));
      for (const orbId of BLOCKED_ORBS) {
        harness.store.seedOrb(makeOrbRow(orbId, PROJECT, "deleting"));
      }

      const releaseBlocked = deferred<void>();
      const allBlockedStarted = deferred<void>();
      const newOrbStarted = deferred<void>();
      const started = new Set<string>();
      const active = new Map<string, number>();
      const maximumActive = new Map<string, number>();

      const reconcile: ReconcileOne = async (_task, _deps, orbId) => {
        if (orbId === NEW_ORB) {
          newOrbStarted.resolve();
          return { type: "noop" };
        }
        const count = (active.get(orbId) ?? 0) + 1;
        active.set(orbId, count);
        maximumActive.set(orbId, Math.max(maximumActive.get(orbId) ?? 0, count));
        started.add(orbId);
        if (BLOCKED_ORBS.every((id) => started.has(id))) allBlockedStarted.resolve();
        try {
          await releaseBlocked.promise;
        } finally {
          active.set(orbId, (active.get(orbId) ?? 1) - 1);
        }
        return { type: "waiting", reason: "deletion_quarantine" };
      };

      const stop = new AbortController();
      const runner = new SimulationReconcileTaskRunner();
      const dispatcher = new ReconcileDispatcher(harness.deps, runner.run, reconcile);
      const result = await sim.runTasks([
        ...ALL_ORBS.map((orbId) => ({
          name: `reconcile-${orbId}`,
          f: (task: SimulationTask) => runner.worker(task, orbId, stop.signal),
        })),
        {
          name: "driver",
          f: async (task) => {
            await dispatcher.dispatchDue(task);
            await allBlockedStarted.promise;

            harness.store.seedOrb(
              makeOrbRow(NEW_ORB, PROJECT, "creating", { stateChangedAt: task.wallNow() }),
            );
            // This second scan is the next scheduler tick. The blocked rows
            // remain visible, but their local in-flight entries must exclude
            // duplicates while the newly created row dispatches immediately.
            await dispatcher.dispatchDue(task);
            await newOrbStarted.promise;

            for (const orbId of BLOCKED_ORBS) expect(maximumActive.get(orbId)).toBe(1);
            let drained = false;
            const drain = dispatcher.drain().then(() => {
              drained = true;
            });
            await task.checkpoint("blocked reconciles keep shutdown drain open");
            expect(drained).toBe(false);
            releaseBlocked.resolve();
            await drain;
            stop.abort();
          },
        },
      ]);

      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(started).toEqual(new Set(BLOCKED_ORBS));
    });
  });

  it("runs real creating lifecycles concurrently through one global auth flow", async () => {
    await runDst({ name: "concurrent-create-shared-auth", iterations: 20 }, async (sim) => {
      const harness = makeHarness({
        authMode: {
          kind: "requires_login",
          autoCompleteAfterMs: 20_000,
          challengeTtlMs: 600_000,
        },
        constants: { idleStopAfterMs: 600_000, unreachableGraceMs: 600_000 },
      });
      const orbIds = ["auth-orb-a", "auth-orb-b"] as const;
      harness.store.seedProject(makeProjectRow(PROJECT));
      for (const orbId of orbIds) {
        harness.world.configureOrb(orbId, { initDurationMs: 0 });
        harness.store.seedOrb(
          makeOrbRow(orbId, PROJECT, "creating", { stateChangedAt: TEST_WALL_EPOCH }),
        );
      }
      const deps = { ...harness.deps, authGate: new SerializedAuthGate(harness.authGate) };
      const stop = new AbortController();
      const runner = new SimulationReconcileTaskRunner();
      const dispatcher = new ReconcileDispatcher(deps, runner.run);
      const result = await sim.runTasks([
        ...orbIds.map((orbId) => ({
          name: `reconcile-${orbId}`,
          f: (task: SimulationTask) => runner.worker(task, orbId, stop.signal),
        })),
        {
          name: "scheduler",
          f: async (task) => {
            const deadline = task.monotonicNow() + 300_000;
            while (
              !orbIds.every((orbId) => harness.store.orbSnapshot(orbId)?.state === "running")
            ) {
              if (task.monotonicNow() > deadline) throw new Error("concurrent creates did not run");
              await dispatcher.dispatchDue(task);
              await task.sleep(500, "concurrent create scheduler tick");
            }
            await dispatcher.drain();
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.authGate.flowStartCount).toBe(1);
      for (const orbId of orbIds) expect(harness.store.orbSnapshot(orbId)?.state).toBe("running");
    });
  });

  it("honors per-orb retry timing after a concurrent task completes", async () => {
    await runDst({ name: "concurrent-reconcile-retry-timing", iterations: 30 }, async (sim) => {
      const harness = makeHarness();
      harness.store.seedProject(makeProjectRow(PROJECT));
      harness.store.seedOrb(makeOrbRow(NEW_ORB, PROJECT, "creating"));
      let calls = 0;
      const reconcile: ReconcileOne = async () => {
        calls += 1;
        return { type: "retryable", message: "scripted retry" };
      };
      const stop = new AbortController();
      const runner = new SimulationReconcileTaskRunner();
      const dispatcher = new ReconcileDispatcher(harness.deps, runner.run, reconcile);
      const result = await sim.runTasks([
        {
          name: `reconcile-${NEW_ORB}`,
          f: (task) => runner.worker(task, NEW_ORB, stop.signal),
        },
        {
          name: "driver",
          f: async (task) => {
            await dispatcher.dispatchDue(task);
            await dispatcher.drain();
            expect(calls).toBe(1);

            await dispatcher.dispatchDue(task);
            await task.checkpoint("retry remains deferred");
            expect(calls).toBe(1);

            await task.sleep(harness.deps.constants.retryBackoffBaseMs + 1, "retry becomes due");
            await dispatcher.dispatchDue(task);
            await dispatcher.drain();
            expect(calls).toBe(2);
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });

  it("does not dispatch a snapshot whose list completed after shutdown began", async () => {
    await runDst(
      { name: "concurrent-reconcile-shutdown-during-list", iterations: 30 },
      async (sim) => {
        const harness = makeHarness();
        harness.store.seedProject(makeProjectRow(PROJECT));
        harness.store.seedOrb(makeOrbRow(NEW_ORB, PROJECT, "creating"));
        const listStarted = deferred<void>();
        const releaseList = deferred<void>();
        const store = new Proxy(harness.store, {
          get(target, property, receiver) {
            if (property === "listOrbsInStates") {
              const list: ControlPlaneStore["listOrbsInStates"] = (task, states) =>
                new ResultAsync(
                  (async () => {
                    listStarted.resolve();
                    await releaseList.promise;
                    return await target.listOrbsInStates(task, states);
                  })(),
                );
              return list;
            }
            const value: unknown = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        let calls = 0;
        const reconcile: ReconcileOne = async () => {
          calls += 1;
          return { type: "noop" };
        };
        const stop = new AbortController();
        const runner = new SimulationReconcileTaskRunner();
        const dispatcher = new ReconcileDispatcher(
          { ...harness.deps, store },
          runner.run,
          reconcile,
        );
        const result = await sim.runTasks([
          {
            name: `reconcile-${NEW_ORB}`,
            f: (task: SimulationTask) => runner.worker(task, NEW_ORB, stop.signal),
          },
          {
            name: "scheduler",
            f: (task: SimulationTask) => dispatcher.dispatchDue(task, stop.signal),
          },
          {
            name: "shutdown",
            f: async () => {
              await listStarted.promise;
              stop.abort();
              releaseList.resolve();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        expect(calls).toBe(0);
      },
    );
  });

  it("drains sibling orb tasks before a fatal worker rejects the loop", async () => {
    await runDst({ name: "concurrent-reconcile-fatal-loop-drain", iterations: 30 }, async (sim) => {
      const harness = makeHarness({ constants: { reconcileTickMs: 1 } });
      const fatalOrb = "fatal-orb";
      const blockedOrb = "blocked-orb";
      harness.store.seedProject(makeProjectRow(PROJECT));
      harness.store.seedOrb(makeOrbRow(fatalOrb, PROJECT, "creating"));
      harness.store.seedOrb(makeOrbRow(blockedOrb, PROJECT, "creating"));
      const blockedStarted = deferred<void>();
      const fatalRaised = deferred<void>();
      const releaseBlocked = deferred<void>();
      const loopFinished = deferred<void>();
      let loopSettled = false;
      let loopError: unknown = null;
      const reconcile: ReconcileOne = async (_task, _deps, orbId) => {
        if (orbId === blockedOrb) {
          blockedStarted.resolve();
          await releaseBlocked.promise;
          return { type: "noop" };
        }
        await blockedStarted.promise;
        fatalRaised.resolve();
        throw new Error("scripted loop worker crash");
      };
      const stop = new AbortController();
      const runner = new SimulationReconcileTaskRunner();
      const deps = harness.deps;
      const result = await sim.runTasks([
        {
          name: `reconcile-${fatalOrb}`,
          f: (task: SimulationTask) => runner.worker(task, fatalOrb, stop.signal),
        },
        {
          name: `reconcile-${blockedOrb}`,
          f: (task: SimulationTask) => runner.worker(task, blockedOrb, stop.signal),
        },
        {
          name: "reconcile-loop",
          f: async (task) => {
            try {
              await reconcileLoop(task, deps, stop.signal, runner.run, reconcile);
            } catch (error) {
              loopError = error;
            } finally {
              loopSettled = true;
              loopFinished.resolve();
            }
          },
        },
        {
          name: "driver",
          f: async (task) => {
            await Promise.race([
              fatalRaised.promise,
              loopFinished.promise.then(() => {
                throw loopError;
              }),
            ]);
            for (let i = 0; i < 10; i++) {
              await task.sleep(10, "scheduler observes fatal worker");
            }
            expect(loopSettled).toBe(false);
            releaseBlocked.resolve();
            await loopFinished.promise;
            expect(loopError).toBeInstanceOf(Error);
            expect((loopError as Error).message).toBe("scripted loop worker crash");
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });

  it("surfaces an unexpected orb-task rejection instead of detaching it", async () => {
    await runDst({ name: "concurrent-reconcile-fatal-worker", iterations: 10 }, async (sim) => {
      const harness = makeHarness();
      harness.store.seedProject(makeProjectRow(PROJECT));
      harness.store.seedOrb(makeOrbRow(NEW_ORB, PROJECT, "creating"));
      const reconcile: ReconcileOne = async () => {
        throw new Error("scripted worker crash");
      };
      const stop = new AbortController();
      const runner = new SimulationReconcileTaskRunner();
      const dispatcher = new ReconcileDispatcher(harness.deps, runner.run, reconcile);
      const result = await sim.runTasks([
        {
          name: `reconcile-${NEW_ORB}`,
          f: (task) => runner.worker(task, NEW_ORB, stop.signal),
        },
        {
          name: "driver",
          f: async (task) => {
            await dispatcher.dispatchDue(task);
            await expect(dispatcher.drain()).rejects.toThrow("scripted worker crash");
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });
});
