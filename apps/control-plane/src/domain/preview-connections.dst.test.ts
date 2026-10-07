import { ConditionVariable, type SimulationTask } from "determined";
import { ResultAsync } from "neverthrow";
import { expect, it } from "vitest";
import { makeHarness, seedRunningOrb } from "../testkit/fixtures.ts";
import { LogCapture, runDst } from "../testkit/sim.ts";
import { ControlState } from "./control-state.ts";
import { reconcileOrbOnce, requestOrbStop } from "./lifecycle.ts";
import { admitPreview, type PreviewRoute } from "./preview.ts";
import {
  type PreviewConnection,
  PreviewConnections,
  type PreviewWatchRunner,
} from "./preview-connections.ts";

function fixture() {
  const h = makeHarness();
  const runtime = h.deps.runtimeClient;
  const touch = h.store.touchLastBusy.bind(h.store);
  let touches = 0;
  h.store.touchLastBusy = (task, input) => {
    touches++;
    return touch(task, input);
  };
  const deps = {
    ...h.deps,
    runtimeClient: {
      health: (...args: Parameters<typeof runtime.health>) =>
        runtime
          .health(...args)
          .map((value) =>
            value.status === "ready"
              ? { ...value, incarnation: 0, executionId: "execution-1" }
              : value,
          ),
      prepareIdleStop: runtime.prepareIdleStop.bind(runtime),
      pullHistory: runtime.pullHistory.bind(runtime),
      deliverMessage: runtime.deliverMessage.bind(runtime),
      readDisplayDetail: runtime.readDisplayDetail.bind(runtime),
      readLiveDisplayDetail: runtime.readLiveDisplayDetail.bind(runtime),
      readDisplayImage: runtime.readDisplayImage.bind(runtime),
    },
  };
  const remote = { ...deps, control: new ControlState() };
  const changed = new ConditionVariable("preview watcher work");
  const queue: { operation: (task: SimulationTask) => Promise<void>; done: () => void }[] = [];
  let finishing = false;
  let producerTask: SimulationTask | undefined;
  let beforeCompletion: ((task: SimulationTask) => Promise<void>) | undefined;
  const run: PreviewWatchRunner = (_orb, operation) =>
    ResultAsync.fromSafePromise(
      new Promise<void>((done) => {
        queue.push({ operation, done });
        if (producerTask !== undefined) changed.notifyAll(producerTask, "watch runner enqueued");
      }),
    );
  const connections = new PreviewConnections(deps, run);
  return {
    h,
    deps,
    remote,
    connections,
    touches: () => touches,
    beforeCompletion: (hook: (task: SimulationTask) => Promise<void>) => {
      beforeCompletion = hook;
    },
    seed: async (task: SimulationTask) => {
      seedRunningOrb(task, h, "orb-a");
      const orb = h.store.orbSnapshot("orb-a")!;
      for (const cp of [deps, remote]) {
        cp.control.noteStateEpisode(orb.id, orb.stateChangedAt);
        cp.control.recordPullSuccess(orb.id, task.monotonicNow(), "idle", "runtime-1");
      }
      expect(
        (
          await h.store.registerPreview(task, {
            orbId: orb.id,
            port: 5173,
            registrationId: "r1",
            caller: { runtimeTokenHash: orb.runtimeTokenHash!, hostIncarnation: 0 },
            now: task.wallNow(),
          })
        )._unsafeUnwrap().type,
      ).toBe("registered");
      return (
        await admitPreview(task, deps, {
          orbId: orb.id,
          port: 5173,
          origin: "https://preview.test",
          expiresAt: task.wallNow() + 3600000,
        })
      )._unsafeUnwrap();
    },
    add: (
      task: SimulationTask,
      route: PreviewRoute,
      http: boolean,
      cancel: Parameters<PreviewConnections["add"]>[3],
    ) => {
      producerTask = task;
      const connection = connections.add(task, route, http, cancel)._unsafeUnwrap();
      changed.notifyAll(task, "watcher enqueued");
      return connection;
    },
    watcher: async (task: SimulationTask) => {
      while (!finishing || queue.length > 0) {
        while (!finishing && queue.length === 0) await changed.wait(task, "await watcher");
        const work = queue.shift();
        if (work === undefined) return;
        await work.operation(task);
        await beforeCompletion?.(task);
        work.done();
        await task.checkpoint("preview.test.watcher-completion");
      }
    },
    finish: (task: SimulationTask) => {
      connections.close(task);
      finishing = true;
      changed.notifyAll(task, "test shutdown");
    },
  };
}

for (const change of ["stop", "revoke-reregister", "token"] as const) {
  it(`another CP ${change} cancels old routes within ten seconds without local notifications`, async () => {
    const logs = new LogCapture();
    await runDst(
      {
        name: `preview-two-cp-${change}`,
        iterations: 20,
        lateTimerProbability: 0,
        logCapture: logs,
      },
      async (sim) => {
        const f = fixture();
        const ready = new ConditionVariable("stream ready");
        let route: PreviewRoute | undefined;
        let connection: PreviewConnection | undefined;
        let changedAt: number | undefined;
        let cancellations = 0;
        let cancelledAt = 0;
        const result = await sim.runTasks([
          {
            name: "stream-owner-cp-a",
            f: async (task) => {
              route = await f.seed(task);
              connection = f.add(task, route, true, () => {
                cancellations++;
                cancelledAt = task.wallNow();
                ready.notifyAll(task, "cancelled");
              });
              ready.notifyAll(task, "route ready");
              while (changedAt === undefined || cancellations === 0)
                await ready.wait(task, "wait remote cancellation");
              expect(cancelledAt - changedAt).toBeLessThanOrEqual(10000);
              expect(cancellations).toBe(1);
              await connection.release(task);
              await connection.release(task);
              f.finish(task);
              expect(cancellations).toBe(1);
              expect(logs.matching("preview-streams-terminated")).toHaveLength(1);
            },
          },
          {
            name: "mutator-cp-b",
            f: async (task) => {
              while (route === undefined) await ready.wait(task, "wait admission");
              const orb = f.h.store.orbSnapshot("orb-a")!;
              if (change === "stop") await requestOrbStop(task, f.remote, "orb-a");
              else if (change === "token")
                f.h.store.seedOrb({ ...orb, runtimeTokenHash: "replacement-token" });
              else {
                const input = {
                  orbId: "orb-a",
                  port: 5173,
                  caller: {
                    runtimeTokenHash: orb.runtimeTokenHash!,
                    hostIncarnation: orb.hostIncarnation,
                  },
                  now: task.wallNow(),
                };
                expect((await f.h.store.unregisterPreview(task, input))._unsafeUnwrap().type).toBe(
                  "revoked",
                );
                expect(
                  (
                    await f.h.store.registerPreview(task, { ...input, registrationId: "r2" })
                  )._unsafeUnwrap().type,
                ).toBe("registered");
                const next = (
                  await admitPreview(task, f.remote, {
                    orbId: "orb-a",
                    port: 5173,
                    origin: route.origin,
                    expiresAt: route.expiresAt,
                  })
                )._unsafeUnwrap();
                expect(next.target.registrationId).toBe("r2");
                expect(next.target.registrationId).not.toBe(route.target.registrationId);
              }
              changedAt = task.wallNow();
              ready.notifyAll(task, "remote authority changed");
            },
          },
          { name: "authority-watcher-cp-a", f: f.watcher },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      },
    );
  });
}

for (const active of [false, true]) {
  it(`${active ? "HTTP/SSE keeps" : "silent WebSocket does not keep"} compute past the idle window without browser presence`, async () => {
    await runDst(
      { name: `preview-idle-stream-${active}`, iterations: 15, lateTimerProbability: 0 },
      async (sim) => {
        const f = fixture();
        const ready = new ConditionVariable("stream ready");
        let route: PreviewRoute | undefined;
        let cancellations = 0;
        const result = await sim.runTasks([
          {
            name: "stream-owner",
            f: async (task) => {
              route = await f.seed(task);
              f.add(task, route, active, () => {
                cancellations++;
              });
              ready.notifyAll(task, "admitted");
            },
          },
          {
            name: "idle-reaper",
            f: async (task) => {
              while (route === undefined) await ready.wait(task, "await route");
              for (let i = 0; i < 12; i++) {
                await task.sleep(5000, "idle reaper tick");
                f.deps.control.recordPullSuccess("orb-a", task.monotonicNow(), "idle", "runtime-1");
                await reconcileOrbOnce(task, f.deps, "orb-a");
                if (active) expect(f.h.store.orbSnapshot("orb-a")?.state).toBe("running");
                else if (f.h.store.orbSnapshot("orb-a")?.state !== "running") break;
              }
              expect(f.h.store.orbSnapshot("orb-a")?.state).toBe(active ? "running" : "stopping");
              if (!active) {
                await task.sleep(10000, "stopping authority reaches watcher");
                expect(cancellations).toBe(1);
              }
              f.finish(task);
            },
          },
          { name: "authority-watcher", f: f.watcher },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      },
    );
  });
}

it("actual WebSocket application activity renews once then silence lets the lease expire", async () => {
  await runDst(
    { name: "preview-ws-application-activity", iterations: 15, lateTimerProbability: 0 },
    async (sim) => {
      const f = fixture();
      const ready = new ConditionVariable("stream ready");
      let connection: PreviewConnection | undefined;
      const result = await sim.runTasks([
        {
          name: "websocket-application",
          f: async (task) => {
            const route = await f.seed(task);
            connection = f.add(task, route, false, () => {});
            ready.notifyAll(task, "admitted");
            for (let i = 0; i < 8; i++) {
              await task.sleep(4000, "application frame");
              connection.activity();
            }
          },
        },
        {
          name: "idle-reaper",
          f: async (task) => {
            while (connection === undefined) await ready.wait(task, "await websocket");
            await task.sleep(30000, "application messages span idle period");
            f.deps.control.recordPullSuccess("orb-a", task.monotonicNow(), "idle", "runtime-1");
            await reconcileOrbOnce(task, f.deps, "orb-a");
            expect(f.h.store.orbSnapshot("orb-a")?.state).toBe("running");
            expect(f.h.store.orbSnapshot("orb-a")!.previewActiveUntil!).toBeGreaterThan(
              task.wallNow(),
            );
            await task.sleep(60000, "no further application frames");
            f.deps.control.recordPullSuccess("orb-a", task.monotonicNow(), "idle", "runtime-1");
            await reconcileOrbOnce(task, f.deps, "orb-a");
            expect(f.h.store.orbSnapshot("orb-a")?.state).toBe("stopping");
            f.finish(task);
          },
        },
        { name: "authority-watcher", f: f.watcher },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    },
  );
});

it("stalled authority read cancels by deadline and cannot renew activity after cancellation", async () => {
  await runDst(
    { name: "preview-stalled-authority", iterations: 10, lateTimerProbability: 0 },
    async (sim) => {
      const f = fixture();
      const read = f.h.store.readPreviewAuthority.bind(f.h.store);
      let stalled = false;
      const reading = new ConditionVariable("store read pending");
      let pending:
        | {
            input: Parameters<typeof read>[1];
            resolve: (value: Awaited<ReturnType<typeof read>>) => void;
          }
        | undefined;
      f.h.store.readPreviewAuthority = (task, input) => {
        if (!stalled) return read(task, input);
        const promise = new Promise<Awaited<ReturnType<typeof read>>>((resolve) => {
          pending = { input, resolve };
        });
        reading.notifyAll(task, "authority read submitted");
        return ResultAsync.fromSafePromise(promise).andThen((value) => value);
      };
      let cancellations = 0;
      let cancelAt = 0;
      const result = await sim.runTasks([
        {
          name: "stream-owner",
          f: async (task) => {
            const route = await f.seed(task);
            const initialLease = f.h.store.orbSnapshot("orb-a")!.previewActiveUntil;
            stalled = true;
            f.add(task, route, true, () => {
              cancellations++;
              cancelAt = task.wallNow();
            });
            const admittedAt = task.wallNow();
            await task.sleep(10000, "bounded cancellation deadline");
            expect(cancellations).toBe(1);
            expect(cancelAt - admittedAt).toBeLessThanOrEqual(10000);
            await task.sleep(20000, "allow abandoned store read to complete");
            expect(f.h.store.orbSnapshot("orb-a")!.previewActiveUntil).toBe(initialLease);
            f.finish(task);
            expect(cancellations).toBe(1);
          },
        },
        {
          name: "store-io",
          f: async (task) => {
            while (pending === undefined) await reading.wait(task, "await stalled read");
            await task.sleep(20000, "stalled store read");
            pending.resolve(await read(task, pending.input));
          },
        },
        { name: "authority-watcher", f: f.watcher },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    },
  );
});

it("concurrent release and shutdown detach ownership exactly once", async () => {
  await runDst(
    { name: "preview-release-shutdown", iterations: 30, lateTimerProbability: 0 },
    async (sim) => {
      const f = fixture();
      const ready = new ConditionVariable("connection cleanup");
      let connection: PreviewConnection | undefined;
      let cancellations = 0;
      let completed = 0;
      const result = await sim.runTasks([
        {
          name: "stream-owner",
          f: async (task) => {
            const route = await f.seed(task);
            connection = f.add(task, route, true, () => {
              cancellations++;
            });
            ready.notifyAll(task, "admitted");
            while (completed < 2) await ready.wait(task, "await competing cleanup");
            expect(cancellations + f.touches()).toBe(1);
            await connection.release(task);
            f.finish(task);
            expect(cancellations + f.touches()).toBe(1);
          },
        },
        {
          name: "response-release",
          f: async (task) => {
            while (connection === undefined) await ready.wait(task, "await response");
            await task.checkpoint("preview.test.response-release");
            await connection.release(task);
            completed++;
            ready.notifyAll(task, "released");
          },
        },
        {
          name: "gateway-shutdown",
          f: async (task) => {
            while (connection === undefined) await ready.wait(task, "await response");
            await task.checkpoint("preview.test.gateway-shutdown");
            f.connections.close(task);
            completed++;
            ready.notifyAll(task, "shutdown");
          },
        },
        { name: "authority-watcher", f: f.watcher },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    },
  );
});

it("release and re-add the same orb during watcher completion keeps one live watcher", async () => {
  await runDst(
    { name: "preview-release-readd", iterations: 30, lateTimerProbability: 0 },
    async (sim) => {
      const f = fixture();
      const ready = new ConditionVariable("stream ownership");
      let completionReached = false;
      let readded = false;
      f.beforeCompletion(async (task) => {
        if (completionReached) return;
        await task.checkpoint("preview.test.watcher-before-completion");
        completionReached = true;
        ready.notifyAll(task, "old watcher exited");
        while (!readded) await ready.wait(task, "hold old watcher completion");
      });
      let route: PreviewRoute | undefined;
      let connection: PreviewConnection | undefined;
      let cancellations = 0;
      const result = await sim.runTasks([
        {
          name: "first-owner",
          f: async (task) => {
            route = await f.seed(task);
            connection = f.add(task, route, false, () => {
              cancellations++;
            });
            ready.notifyAll(task, "first admitted");
          },
        },
        {
          name: "release-readd",
          f: async (task) => {
            while (connection === undefined || route === undefined)
              await ready.wait(task, "await first owner");
            await task.sleep(5000, "release at watcher tick");
            await connection.release(task);
            while (!completionReached) await ready.wait(task, "old watcher operation exits");
            const next = f.add(task, route, true, () => {
              cancellations++;
            });
            readded = true;
            ready.notifyAll(task, "replacement added before runner completion");
            await task.sleep(1000, "stop replacement stream");
            await requestOrbStop(task, f.remote, "orb-a");
            await task.sleep(10000, "cross-instance watcher deadline");
            expect(cancellations).toBe(1);
            await next.release(task);
            f.finish(task);
            expect(cancellations).toBe(1);
          },
        },
        { name: "authority-watcher", f: f.watcher },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    },
  );
});
