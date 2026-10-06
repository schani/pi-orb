import type { PullHistoryResponse } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { expect, it } from "vitest";
import {
  background,
  ComposedClaudeFixture,
  childEdge,
  childHook,
  rootResult,
  submitReceipt,
} from "../../../orb-runtime/src/testkit/claude-composed.ts";
import { FAILPOINTS } from "../testkit/failpoints.ts";
import {
  discardFinalized,
  makeHarness,
  restartControlPlane,
  seedRunningOrb,
  TEST_CONSTANTS,
  type TestHarness,
} from "../testkit/fixtures.ts";
import { runDst, waitUntil } from "../testkit/sim.ts";
import type { RuntimeClientError } from "./errors.ts";
import { requestOrbArchive, requestOrbDeletion } from "./lifecycle.ts";
import { pollLoop, reconcileLoop } from "./loops.ts";
import type { OrbHostProvider, OrbRuntimeClient } from "./ports.ts";

const clientError = (message: string): RuntimeClientError => ({
  type: "runtime_client_error",
  code: "history_unavailable",
  message,
  answered: true,
  retryable: true,
});

function bindRuntime(harness: TestHarness, f: ComposedClaudeFixture) {
  const transport = harness.deps.runtimeClient;
  let prepared = false;
  const runtimeClient: OrbRuntimeClient = {
    ...transport,
    readDisplayDetail: (...args) => transport.readDisplayDetail(...args),
    readLiveDisplayDetail: (...args) => transport.readLiveDisplayDetail(...args),
    readDisplayImage: (...args) => transport.readDisplayImage(...args),
    deliverMessage: (_task, request) =>
      f.agent
        .deliverInboxMessage(request.messageId, request.messageIds, request.content, request.system)
        .mapErr((error) => clientError(error.message)),
    health: (...args) => transport.health(...args).map(() => f.agent.getHealth()),
    prepareIdleStop: (task) =>
      ResultAsync.fromSafePromise(task.checkpoint("real Claude prepare admission fence")).andThen(
        () =>
          f.agent
            .prepareIdleStop()
            .map((value) => {
              prepared ||= value;
              return { v: 1 as const, prepared: value };
            })
            .mapErr((error) => clientError(error.message)),
      ),
    pullHistory: (task, request, context) => {
      const snapshot = f.agent.replicationSnapshot();
      if (snapshot.isErr()) return errAsync(clientError(snapshot.error.message));
      const value = snapshot.value;
      const index =
        request.after === null
          ? -1
          : value.records.findIndex((record) => record.id === request.after);
      if (request.after !== null && index < 0)
        return errAsync(clientError("unknown real Claude cursor"));
      const records = value.records.slice(index + 1, index + 1 + request.limit);
      const cursor = records.at(-1)?.id ?? request.after;
      const response: PullHistoryResponse = {
        v: 1,
        orbId: value.orbId,
        runtimeInstanceId: value.runtimeInstanceId,
        activity: value.activity,
        session: value.session,
        records,
        cursor,
        headId: cursor,
      };
      // The real runtime snapshot is captured before simulated transport delay/failure.
      return transport.pullHistory(task, { ...request, after: null }, context).map(() => response);
    },
  };
  return { ...harness.deps, runtimeClient, wasPrepared: () => prepared };
}

function seedClaudeOrb(task: SimulationTask, harness: TestHarness) {
  seedRunningOrb(task, harness, "orb-a");
  const orb = harness.store.orbSnapshot("orb-a");
  if (orb === null) throw new Error("seeded Claude orb missing");
  harness.store.seedOrb({ ...orb, harness: "claude" });
}

const fuzz = { [FAILPOINTS.runtimePull]: 0.03, [FAILPOINTS.storeCommitAfter]: 0.03 };

it("archive seals real normalized root history only after child handoff, native exit, stdout EOF and final replication commit", async () => {
  await runDst(
    {
      name: "claude-composed-cp-archive",
      iterations: 40,
      lateTimerProbability: 0,
      failpointProbabilities: fuzz,
    },
    async (sim) => {
      const f = new ComposedClaudeFixture();
      const harness = makeHarness({ constants: { deletionQuarantineMs: 2_000 } });
      try {
        expect((await f.attach()).isOk()).toBe(true);
        const base = bindRuntime(harness, f);
        let sealed = false;
        const store = new Proxy(harness.store, {
          get(target, key) {
            if (key === "sealOrbArchive")
              return (...args: Parameters<typeof target.sealOrbArchive>) => {
                expect(base.wasPrepared()).toBe(true);
                expect(f.agent.gateView().activity).toBe("idle");
                expect(f.query.closeRequested).toBe(true);
                expect(harness.store.replicaRecords("orb-a").map((record) => record.id)).toEqual(
                  f.agent
                    .replicationSnapshot()
                    ._unsafeUnwrap()
                    .records.map((record) => record.id),
                );
                sealed = true;
                return target.sealOrbArchive(...args);
              };
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const deps = { ...base, store };
        const stop = new AbortController();
        const result = await sim.runTasks([
          { name: "poller", f: (task) => pollLoop(task, deps, stop.signal) },
          { name: "reconciler", f: (task) => reconcileLoop(task, deps, stop.signal) },
          {
            name: "native-and-archive-driver",
            f: async (task) => {
              seedClaudeOrb(task, harness);
              const input = await submitReceipt(task, f);
              await childHook(task, f);
              f.childFile();
              await f.query.emit(task, background([]));
              await f.query.emit(task, rootResult);
              expect((await requestOrbArchive(task, deps, "orb-a")).isOk()).toBe(true);
              for (let i = 0; i < 4; i++) {
                await task.sleep(
                  TEST_CONSTANTS.idleStopAfterMs,
                  "archive cannot mistake quiet child for idle",
                );
                expect(f.agent.gateView().activity).toBe("busy");
                expect(harness.world.filesystemExists("orb-a")).toBe(true);
                expect(sealed).toBe(false);
              }
              await f.query.emit(task, childEdge("task_notification"));
              await task.sleep(
                TEST_CONSTANTS.historyPullIntervalMs,
                "terminal child awaits native root handoff",
              );
              expect(sealed).toBe(false);
              await f.query.emit(task, rootResult);
              f.query.exit();
              await task.sleep(
                TEST_CONSTANTS.idleStopAfterMs,
                "process exit does not mean stdout drain",
              );
              expect(sealed).toBe(false);
              expect(f.agent.gateView().activity).toBe("busy");
              f.append({
                type: "assistant",
                uuid: "late-final-root",
                message: { content: "retained final output" },
              });
              f.query.endOutput();
              await f.agent.closeExtensions();
              await waitUntil(
                task,
                "archive sealed and workspace removed",
                () => harness.store.orbSnapshot("orb-a")?.state === "archived",
                { timeoutMs: 180_000 },
              );
              expect(sealed).toBe(true);
              expect(harness.world.filesystemExists("orb-a")).toBe(false);
              const replica = harness.store.replicaRecords("orb-a");
              expect(replica.find((record) => record.id === input.uuid)).toMatchObject({
                inboxMessageIds: ["inbox"],
              });
              expect(replica.some((record) => record.id === "late-final-root")).toBe(true);
              expect(replica.some((record) => record.id === "private-child")).toBe(false);
              expect(
                (
                  await f.agent.submitMessage([{ type: "text", text: "after seal" }], "late")
                ).isErr(),
              ).toBe(true);
              stop.abort();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      } finally {
        f.dispose();
      }
    },
  );
});

it("real child-only activity survives CP restart, stale pulls and wall-clock jumps until process/history drain", async () => {
  await runDst(
    {
      name: "claude-composed-cp-restart-clock",
      iterations: 30,
      lateTimerProbability: 0,
      failpointProbabilities: fuzz,
    },
    async (sim) => {
      const f = new ComposedClaudeFixture();
      let harness = makeHarness();
      let wallJump = 0;
      const clock = (task: SimulationTask): SimulationTask =>
        new Proxy(task, {
          get(target, key) {
            if (key === "wallNow") return () => target.wallNow() + wallJump;
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      try {
        expect((await f.attach()).isOk()).toBe(true);
        for (const phase of [0, 1]) {
          if (phase === 1) harness = restartControlPlane(harness);
          const deps = bindRuntime(harness, f);
          const stop = new AbortController();
          const result = await sim.runTasks([
            { name: `poller-${phase}`, f: (task) => pollLoop(clock(task), deps, stop.signal) },
            {
              name: `reconciler-${phase}`,
              f: (task) => reconcileLoop(clock(task), deps, stop.signal),
            },
            {
              name: `driver-${phase}`,
              f: async (raw) => {
                const task = clock(raw);
                if (phase === 0) {
                  seedClaudeOrb(task, harness);
                  await submitReceipt(task, f);
                  await f.query.emit(task, childEdge("task_started"));
                  await f.query.emit(task, rootResult);
                }
                await waitUntil(
                  task,
                  "busy real snapshot observed",
                  () => deps.control.getLiveness("orb-a")?.activity === "busy",
                );
                await task.checkpoint("clock correction is not monotonic transport timeout");
                wallJump = phase === 0 ? 3_600_000 : -3_600_000;
                for (let i = 0; i < 3; i++) {
                  await task.sleep(
                    TEST_CONSTANTS.idleStopAfterMs,
                    "silent real native child remains busy",
                  );
                  expect(harness.store.orbSnapshot("orb-a")?.state).toBe("running");
                  expect(f.agent.gateView().activity).toBe("busy");
                }
                if (phase === 1) {
                  await f.query.emit(task, childEdge("task_notification"));
                  await f.query.emit(task, rootResult);
                  f.query.exit();
                  f.query.endOutput();
                  await f.agent.closeExtensions();
                  await task.sleep(
                    TEST_CONSTANTS.idleStopAfterMs,
                    "backward wall clock retains conservative future lastBusyAt",
                  );
                  expect(harness.store.orbSnapshot("orb-a")?.state).toBe("running");
                  await task.checkpoint("wall clock catches up to persisted busy timestamp");
                  wallJump = 2 * 3_600_000;
                  await waitUntil(
                    task,
                    "idle-stop after final real replication",
                    () => harness.store.orbSnapshot("orb-a")?.state === "stopped",
                    { timeoutMs: 180_000 },
                  );
                  expect(deps.wasPrepared()).toBe(true);
                  expect(harness.store.replicaRecords("orb-a").map((record) => record.id)).toEqual(
                    f.agent
                      .replicationSnapshot()
                      ._unsafeUnwrap()
                      .records.map((record) => record.id),
                  );
                }
                stop.abort();
              },
            },
          ]);
          expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        }
      } finally {
        f.dispose();
      }
    },
  );
});

it.each(["before", "after"] as const)(
  "continuation %s real prepare is protected or rejected during archive",
  async (timing) => {
    await runDst(
      { name: `claude-composed-cp-prepare-${timing}`, iterations: 20, lateTimerProbability: 0 },
      async (sim) => {
        const f = new ComposedClaudeFixture();
        const harness = makeHarness({ constants: { deletionQuarantineMs: 2_000 } });
        try {
          expect((await f.attach()).isOk()).toBe(true);
          const base = bindRuntime(harness, f);
          let attempted = false;
          let accepted = false;
          const attempt = async () => {
            attempted = true;
            accepted = (
              await f.agent.submitMessage([{ type: "text", text: "continuation" }], "late-op")
            ).isOk();
          };
          const deps = {
            ...base,
            runtimeClient: {
              ...base.runtimeClient,
              prepareIdleStop: (...args: Parameters<typeof base.runtimeClient.prepareIdleStop>) => {
                if (timing === "before" && !attempted)
                  return ResultAsync.fromSafePromise(attempt()).andThen(() =>
                    base.runtimeClient.prepareIdleStop(...args),
                  );
                return base.runtimeClient
                  .prepareIdleStop(...args)
                  .andThen((response) =>
                    timing === "after" && response.prepared && !attempted
                      ? ResultAsync.fromSafePromise(attempt()).map(() => response)
                      : okAsync(response),
                  );
              },
            },
          };
          const stop = new AbortController();
          const result = await sim.runTasks([
            { name: "poller", f: (task) => pollLoop(task, deps, stop.signal) },
            { name: "reconciler", f: (task) => reconcileLoop(task, deps, stop.signal) },
            {
              name: "driver",
              f: async (task) => {
                seedClaudeOrb(task, harness);
                f.append({ type: "user", uuid: "initial", message: { content: "initial" } });
                expect((await requestOrbArchive(task, deps, "orb-a")).isOk()).toBe(true);
                await waitUntil(task, "continuation raced real final prepare", () => attempted);
                await task.sleep(
                  TEST_CONSTANTS.idleStopAfterMs,
                  "observe admission/destruction decision",
                );
                expect(accepted).toBe(timing === "before");
                expect(harness.world.filesystemExists("orb-a")).toBe(accepted);
                expect(harness.store.orbSnapshot("orb-a")?.state).toBe(
                  accepted ? "archiving" : "archived",
                );
                if (accepted) {
                  expect(f.agent.gateView().activity).toBe("busy");
                  f.query.exit();
                  f.query.endOutput();
                  await f.agent.closeExtensions();
                } else expect(f.agent.gateView().acceptingWork).toBe(false);
                stop.abort();
              },
            },
          ]);
          expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        } finally {
          f.dispose();
        }
      },
    );
  },
);

it("archive cannot seal or destroy retained native files after final history commit failure", async () => {
  await runDst(
    { name: "claude-composed-cp-final-commit-failure", iterations: 20, lateTimerProbability: 0 },
    async (sim) => {
      const f = new ComposedClaudeFixture();
      const harness = makeHarness({ constants: { deletionQuarantineMs: 2_000 } });
      try {
        expect((await f.attach()).isOk()).toBe(true);
        const deps = bindRuntime(harness, f);
        const stop = new AbortController();
        const result = await sim.runTasks([
          { name: "poller", f: (task) => pollLoop(task, deps, stop.signal) },
          { name: "reconciler", f: (task) => reconcileLoop(task, deps, stop.signal) },
          {
            name: "driver",
            f: async (task) => {
              seedClaudeOrb(task, harness);
              await submitReceipt(task, f);
              expect((await requestOrbArchive(task, deps, "orb-a")).isOk()).toBe(true);
              await f.query.emit(task, rootResult);
              f.append({
                type: "assistant",
                uuid: "uncommitted-final",
                message: { content: "recoverable native output" },
              });
              await task.checkpoint(
                "final normalized index write fails while native transcript survives",
              );
              f.failCommit = true;
              f.query.exit();
              f.query.endOutput();
              await f.agent.closeExtensions();
              await task.sleep(
                3 * TEST_CONSTANTS.idleStopAfterMs,
                "archive must retain authoritative files on durability failure",
              );
              expect(f.agent.gateView().activity).toBe("busy");
              expect(f.agent.getHealth()).toMatchObject({
                status: "failed",
                error: { code: "history_unavailable" },
              });
              expect(deps.wasPrepared()).toBe(false);
              expect(harness.store.orbSnapshot("orb-a")?.state).toBe("archiving");
              expect(harness.store.deletionSnapshot("orb-a")?.historySealedAt).toBeNull();
              expect(harness.world.filesystemExists("orb-a")).toBe(true);
              expect(harness.world.hostCount("orb-a")).toBe(1);
              stop.abort();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      } finally {
        f.dispose();
      }
    },
  );
});

it("incarnation-bounded compute disposal drains the old native process without destroying retained session files", async () => {
  await runDst(
    { name: "claude-composed-cp-incarnation-discard", iterations: 20, lateTimerProbability: 0 },
    async (sim) => {
      const f = new ComposedClaudeFixture();
      const harness = makeHarness();
      try {
        expect((await f.attach()).isOk()).toBe(true);
        const base = bindRuntime(harness, f);
        const provider = base.hostProvider;
        let oldProcessDrained = false;
        const hostProvider: OrbHostProvider = new Proxy(provider, {
          get(target, key) {
            if (key === "discardCompute")
              return (...args: Parameters<typeof provider.discardCompute>) =>
                provider.discardCompute(...args).andThen(() =>
                  ResultAsync.fromSafePromise(
                    (async () => {
                      if (args[1].throughIncarnation < 0 || harness.world.hostCount("orb-a") !== 0)
                        return;
                      // This is the simulated host boundary: condemned compute cannot keep a process or stdout alive.
                      f.agent.shutdownHooks();
                      const closing = f.agent.closeExtensions();
                      await args[0].checkpoint(
                        "old native process killed by incarnation-bounded host disposal",
                      );
                      f.query.exit();
                      f.query.endOutput();
                      await closing;
                      oldProcessDrained = true;
                    })(),
                  ),
                );
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const deps = { ...base, hostProvider };
        const stop = new AbortController();
        const result = await sim.runTasks([
          { name: "poller", f: (task) => pollLoop(task, deps, stop.signal) },
          { name: "reconciler", f: (task) => reconcileLoop(task, deps, stop.signal) },
          {
            name: "driver",
            f: async (task) => {
              seedClaudeOrb(task, harness);
              const input = await submitReceipt(task, f);
              await childHook(task, f);
              const oldQuery = f.query;
              const row = harness.store.orbSnapshot("orb-a");
              if (row === null) throw new Error("running orb missing");
              expect(
                (
                  await harness.store.failOrbAndRequestComputeDiscard(task, {
                    orbId: row.id,
                    expectedStateVersion: row.stateVersion,
                    now: task.wallNow(),
                    lastError: "runtime_failed: condemned old compute",
                    evidence: "owned native process must die",
                  })
                ).isOk(),
              ).toBe(true);
              await waitUntil(task, "old incarnation disposed", () =>
                discardFinalized(harness, "orb-a"),
              );
              expect(oldProcessDrained).toBe(true);
              expect(oldQuery.closeRequested).toBe(true);
              expect(harness.store.orbSnapshot("orb-a")?.hostIncarnation).toBe(1);
              expect(harness.world.filesystemExists("orb-a")).toBe(true);
              expect(f.history.view.some((record) => record.id === input.uuid)).toBe(true);
              expect(await oldQuery.emit(task, rootResult)).toBe(false);
              expect(f.journal().ownedChildren).toEqual({ child: "Native Claude agent" });
              expect(f.agent.gateView().acceptingWork).toBe(false);
              stop.abort();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      } finally {
        f.dispose();
      }
    },
  );
});

it("explicit deletion retains whole-host authority over an uncooperative real native child", async () => {
  await runDst(
    { name: "claude-composed-cp-explicit-delete", iterations: 20, lateTimerProbability: 0 },
    async (sim) => {
      const f = new ComposedClaudeFixture();
      const harness = makeHarness({ constants: { deletionQuarantineMs: 2_000 } });
      try {
        expect((await f.attach()).isOk()).toBe(true);
        const deps = bindRuntime(harness, f);
        const stop = new AbortController();
        const result = await sim.runTasks([
          { name: "poller", f: (task) => pollLoop(task, deps, stop.signal) },
          { name: "reconciler", f: (task) => reconcileLoop(task, deps, stop.signal) },
          {
            name: "driver",
            f: async (task) => {
              seedClaudeOrb(task, harness);
              await submitReceipt(task, f);
              await childHook(task, f);
              await f.query.emit(task, rootResult);
              expect((await requestOrbDeletion(task, deps, "orb-a")).isOk()).toBe(true);
              await waitUntil(
                task,
                "explicit host deletion without child cooperation",
                () => harness.store.orbSnapshot("orb-a") === null,
                { timeoutMs: 180_000 },
              );
              expect(f.agent.gateView().activity).toBe("busy");
              expect(deps.wasPrepared()).toBe(false);
              expect(harness.world.filesystemExists("orb-a")).toBe(false);
              f.query.exit();
              f.query.endOutput();
              await f.agent.closeExtensions();
              stop.abort();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      } finally {
        f.dispose();
      }
    },
  );
});
