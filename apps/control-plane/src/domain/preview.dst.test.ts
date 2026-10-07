import { ConditionVariable, type SimulationTask } from "determined";
import { ResultAsync } from "neverthrow";
import { expect, it } from "vitest";
import { FAILPOINTS } from "../testkit/failpoints.ts";
import { makeHarness, seedRunningOrb, type TestHarness } from "../testkit/fixtures.ts";
import { runDst } from "../testkit/sim.ts";
import { reconcileOrbOnce, requestOrbStop } from "./lifecycle.ts";
import { admitPreview, revalidatePreview } from "./preview.ts";

function fixture() {
  const h = makeHarness();
  const client = h.deps.runtimeClient;
  let execution = "execution-1";
  const deps = {
    ...h.deps,
    runtimeClient: {
      ...client,
      health: (...args: Parameters<typeof client.health>) =>
        client
          .health(...args)
          .map((value) =>
            value.status === "ready" ? { ...value, incarnation: 0, executionId: execution } : value,
          ),
      prepareIdleStop: client.prepareIdleStop.bind(client),
      pullHistory: client.pullHistory.bind(client),
      deliverMessage: client.deliverMessage.bind(client),
      readDisplayDetail: client.readDisplayDetail.bind(client),
      readLiveDisplayDetail: client.readLiveDisplayDetail.bind(client),
      readDisplayImage: client.readDisplayImage.bind(client),
    },
  };
  return {
    h,
    deps,
    replaceExecution: () => {
      execution = "execution-2";
    },
  };
}

async function seed(task: SimulationTask, h: TestHarness) {
  seedRunningOrb(task, h, "orb-a");
  const orb = h.store.orbSnapshot("orb-a")!;
  h.deps.control.noteStateEpisode(orb.id, orb.stateChangedAt);
  h.deps.control.recordPullSuccess(orb.id, task.monotonicNow(), "idle", "runtime-1");
  const result = await h.store.registerPreview(task, {
    orbId: orb.id,
    port: 5173,
    registrationId: "r1",
    caller: { runtimeTokenHash: orb.runtimeTokenHash!, hostIncarnation: orb.hostIncarnation },
    now: task.wallNow(),
  });
  expect(result._unsafeUnwrap().type).toBe("registered");
}
const request = (task: SimulationTask) => ({
  orbId: "orb-a",
  port: 5173,
  origin: "https://preview.test",
  expiresAt: task.wallNow() + 3600000,
});

function gate(boundary: string) {
  const changed = new ConditionVariable(boundary);
  let reached = false;
  let released = false;
  return {
    task: (task: SimulationTask): SimulationTask =>
      new Proxy(task, {
        get(target, property) {
          if (property === "checkpoint")
            return async (...log: readonly unknown[]) => {
              await target.checkpoint(...log);
              if (log[0] !== boundary) return;
              reached = true;
              changed.notifyAll(target, "boundary reached");
              while (!released) await changed.wait(target, "held at boundary");
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    wait: async (task: SimulationTask) => {
      while (!reached) await changed.wait(task, "await boundary");
    },
    release: (task: SimulationTask) => {
      released = true;
      changed.notifyAll(task, "release boundary");
    },
  };
}

it("production admission races a stale idle CAS in separate tasks", async () => {
  await runDst(
    { name: "preview-concurrent-idle-cas", iterations: 30, lateTimerProbability: 0 },
    async (sim) => {
      const { h, deps } = fixture();
      const ready = new ConditionVariable("fixture ready");
      let seeded = false;
      let admitted = false;
      let stopped = false;
      const wait = async (task: SimulationTask) => {
        while (!seeded) await ready.wait(task, "seed");
      };
      const result = await sim.runTasks([
        {
          name: "seed",
          f: async (task) => {
            await seed(task, h);
            seeded = true;
            ready.notifyAll(task, "seeded");
          },
        },
        {
          name: "request",
          f: async (task) => {
            await wait(task);
            const admission = await admitPreview(task, deps, request(task));
            admitted = admission.isOk();
            if (admitted) expect(h.store.orbSnapshot("orb-a")?.state).toBe("running");
          },
        },
        {
          name: "idle-reaper",
          f: async (task) => {
            await wait(task);
            const stale = h.store.orbSnapshot("orb-a")!;
            await task.checkpoint("preview.test.stale-idle-cas");
            const cas = await h.store.casTransition(task, {
              orbId: stale.id,
              expectedStateVersion: stale.stateVersion,
              toState: "stopping",
              stopReason: "idle",
              now: task.wallNow(),
            });
            stopped = cas.isOk();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(admitted && stopped).toBe(false);
      expect(admitted || stopped).toBe(true);
    },
  );
});

for (const boundary of [
  "preview.authority-read",
  "preview.before-protection",
  "preview.transport-admission",
]) {
  it(`explicit Stop closes admission at ${boundary} without waking compute`, async () => {
    await runDst(
      { name: `preview-stop-${boundary}`, iterations: 10, lateTimerProbability: 0 },
      async (sim) => {
        const { h, deps } = fixture();
        const held = gate(boundary);
        const result = await sim.runTasks([
          {
            name: "request",
            f: async (task) => {
              await seed(task, h);
              const admitted = await admitPreview(held.task(task), deps, request(task));
              expect(admitted.isErr()).toBe(true);
              expect(h.store.orbSnapshot("orb-a")?.state).toBe("stopping");
            },
          },
          {
            name: "explicit-stop",
            f: async (task) => {
              await held.wait(task);
              await requestOrbStop(task, deps, "orb-a");
              held.release(task);
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      },
    );
  });
}

it("worker death expires its durable lease and the actual idle reaper stops compute", async () => {
  await runDst(
    { name: "preview-concurrent-owner-death", iterations: 10, lateTimerProbability: 0 },
    async (sim) => {
      const { h, deps } = fixture();
      const completed = new ConditionVariable("worker died");
      let died = false;
      const result = await sim.runTasks([
        {
          name: "preview-worker",
          f: async (task) => {
            await seed(task, h);
            expect((await admitPreview(task, deps, request(task))).isOk()).toBe(true);
            died = true;
            completed.notifyAll(task, "worker exits without cleanup");
          },
        },
        {
          name: "idle-reaper",
          f: async (task) => {
            while (!died) await completed.wait(task, "wait worker death");
            await task.sleep(15000 + deps.constants.idleStopAfterMs + 100, "lease plus idle grace");
            deps.control.recordPullSuccess("orb-a", task.monotonicNow(), "idle", "runtime-1");
            await reconcileOrbOnce(task, deps, "orb-a");
            expect(h.store.orbSnapshot("orb-a")?.state).toBe("stopping");
            expect(h.store.orbSnapshot("orb-a")?.stopReason).toBe("idle");
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    },
  );
});

for (const replacement of ["token", "incarnation", "execution", "wrong-compute"] as const) {
  it(`old route rejects concurrent ${replacement} replacement`, async () => {
    await runDst(
      { name: `preview-replacement-${replacement}`, iterations: 10, lateTimerProbability: 0 },
      async (sim) => {
        const { h, deps, replaceExecution } = fixture();
        const held = gate("preview.revalidation");
        const result = await sim.runTasks([
          {
            name: "old-request",
            f: async (task) => {
              await seed(task, h);
              const route = (await admitPreview(task, deps, request(task)))._unsafeUnwrap();
              const validation = await revalidatePreview(held.task(task), deps, route, true);
              expect(validation.isErr() && validation.error.code).toBe("stale_target");
            },
          },
          {
            name: "compute-replacement",
            f: async (task) => {
              await held.wait(task);
              const orb = h.store.orbSnapshot("orb-a")!;
              if (replacement === "execution") replaceExecution();
              else if (replacement === "wrong-compute") h.world.reportWrongOrbId("orb-a", "orb-b");
              else
                h.store.seedOrb({
                  ...orb,
                  ...(replacement === "token"
                    ? { runtimeTokenHash: "replacement-token" }
                    : { hostIncarnation: orb.hostIncarnation + 1 }),
                });
              held.release(task);
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      },
    );
  });
}

for (const failpoint of [
  FAILPOINTS.storeRead,
  FAILPOINTS.providerObserve,
  FAILPOINTS.runtimeHealth,
]) {
  it(`admission fails closed at ${failpoint}`, async () => {
    await runDst(
      {
        name: `preview-admission-failure-${failpoint}`,
        iterations: 3,
        failpointProbabilities: { [failpoint]: 1 },
        lateTimerProbability: 0,
      },
      async (sim) => {
        const { h, deps } = fixture();
        const result = await sim.runTasks([
          {
            name: "request",
            f: async (task) => {
              await seed(task, h);
              expect((await admitPreview(task, deps, request(task))).isErr()).toBe(true);
              expect(h.store.orbSnapshot("orb-a")?.previewActiveUntil).toBeNull();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      },
    );
  });
}

it("missing and stopped previews never start compute", async () => {
  await runDst({ name: "preview-no-autostart", iterations: 3 }, async (sim) => {
    const { h, deps } = fixture();
    const result = await sim.runTasks([
      {
        name: "request",
        f: async (task) => {
          const missing = await admitPreview(task, deps, { ...request(task), orbId: "missing" });
          expect(missing.isErr() && missing.error.code).toBe("orb_not_found");
          await seed(task, h);
          await requestOrbStop(task, deps, "orb-a");
          const stopped = await admitPreview(task, deps, request(task));
          expect(stopped.isErr() && stopped.error.code).toBe("orb_unavailable");
          expect(h.store.orbSnapshot("orb-a")?.state).toBe("stopping");
        },
      },
    ]);
    expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
  });
});

it("an idle reaper that wins prepares the runtime fence and rejects the paused admission", async () => {
  await runDst(
    { name: "preview-idle-runtime-fence", iterations: 20, lateTimerProbability: 0 },
    async (sim) => {
      const { h, deps } = fixture();
      const held = gate("preview.before-protection");
      const prepare = deps.runtimeClient.prepareIdleStop;
      let fenced = false;
      deps.runtimeClient.prepareIdleStop = (...args) =>
        prepare(...args).map((value) => {
          fenced = value.prepared;
          return value;
        });
      const result = await sim.runTasks([
        {
          name: "preview-request",
          f: async (task) => {
            await seed(task, h);
            await task.sleep(
              deps.constants.idleStopAfterMs + 100,
              "idle eligibility before admission",
            );
            const admission = await admitPreview(held.task(task), deps, request(task));
            expect(fenced).toBe(true);
            expect(admission.isErr()).toBe(true);
            expect(h.store.orbSnapshot("orb-a")?.previewActiveUntil).toBeNull();
            expect(h.store.orbSnapshot("orb-a")?.state).not.toBe("running");
          },
        },
        {
          name: "idle-reaper-and-runtime-drain",
          f: async (task) => {
            await held.wait(task);
            deps.control.recordPullSuccess("orb-a", task.monotonicNow(), "idle", "runtime-1");
            await reconcileOrbOnce(task, deps, "orb-a");
            expect(h.store.orbSnapshot("orb-a")?.state).toBe("stopping");
            await reconcileOrbOnce(task, deps, "orb-a");
            expect(fenced).toBe(true);
            held.release(task);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    },
  );
});

it("admission defeats the actual idle reconciler CAS after its stale row read", async () => {
  await runDst(
    { name: "preview-real-idle-reconciler-race", iterations: 20, lateTimerProbability: 0 },
    async (sim) => {
      const { h, deps } = fixture();
      const held = gate("preview.test.lifecycle-idle-cas");
      const cas = h.store.casTransition.bind(h.store);
      h.store.casTransition = (task, input) =>
        input.stopReason === "idle"
          ? ResultAsync.fromSafePromise(
              held.task(task).checkpoint("preview.test.lifecycle-idle-cas"),
            ).andThen(() => cas(task, input))
          : cas(task, input);
      const result = await sim.runTasks([
        {
          name: "idle-reconciler",
          f: async (task) => {
            await seed(task, h);
            await task.sleep(deps.constants.idleStopAfterMs + 100, "orb becomes idle");
            deps.control.recordPullSuccess("orb-a", task.monotonicNow(), "idle", "runtime-1");
            await reconcileOrbOnce(task, deps, "orb-a");
            expect(h.store.orbSnapshot("orb-a")?.state).toBe("running");
          },
        },
        {
          name: "preview-request",
          f: async (task) => {
            await held.wait(task);
            expect((await admitPreview(task, deps, request(task))).isOk()).toBe(true);
            held.release(task);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    },
  );
});
