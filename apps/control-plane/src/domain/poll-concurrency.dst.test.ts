import type { HistoryRecord } from "@pi-orb/protocol";
import { ConditionVariable, SimpleEntropySource, type SimulationTask } from "determined";
import { ok, okAsync, ResultAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { SdkAgentPlane } from "../adapters/sdk-agent-plane.ts";
import { FAILPOINTS } from "../testkit/failpoints.ts";
import {
  makeHarness,
  makeOrbRow,
  makeProjectRow,
  restartControlPlane,
  seedRunningOrb,
} from "../testkit/fixtures.ts";
import { assertReplicaComplete, assertReplicaIntegrity } from "../testkit/invariants.ts";
import { LogCapture, runDst, waitUntil } from "../testkit/sim.ts";
import { commitAgentHistory } from "./agent-history.ts";
import type { AgentPlane } from "./agent-ports.ts";
import { HarnessAgentPlane } from "./harness-agent-plane.ts";
import { requestOrbDeletion, requestOrbStop } from "./lifecycle.ts";
import { pollLoop, type ReconcileTaskRunner, reconcileLoop } from "./loops.ts";
import type { CommitPullBatchParams } from "./ports.ts";

type ReconcileJob = {
  readonly run: (task: SimulationTask) => Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
};

/**
 * `determined` models concurrency with distinct SimulationTasks. Production
 * creates one real-time task per dispatched orb; this mailbox gives each
 * statically declared DST worker its own task while exercising the same
 * dispatcher contract.
 */
class SimulationPollTaskRunner {
  calls = 0;
  private readonly queued = new Map<string, ReconcileJob>();
  private readonly waiting = new Map<string, (job: ReconcileJob | null) => void>();

  readonly run: ReconcileTaskRunner = (orbId, operation) =>
    new Promise<void>((resolve, reject) => {
      this.calls++;
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

const phases = ["health", "claim", "delivery", "history", "commit", "naming", "catchup"] as const;

describe("real multi-orb polling (DST)", () => {
  for (const phase of phases) {
    it(`delivers B on later ticks while A holds ${phase}`, async () => {
      await runDst(
        {
          name: `poll-held-${phase}`,
          iterations: 20,
          lateTimerProbability: 0,
          logCapture: new LogCapture(),
        },
        async (sim) => {
          const h = makeHarness({
            constants: {
              reconcileTickMs: 20,
              historyPullIntervalMs: 20,
              runtimeRequestTimeoutMs: 100_000,
            },
          });
          h.store.seedProject(makeProjectRow("project"));
          for (const id of ["a", "b"])
            h.store.seedOrb(
              makeOrbRow(id, "project", "creating", {
                name: id === "a" && phase === "naming" ? null : id,
              }),
            );
          const gate = new ConditionVariable("held poll phase");
          let held = false;
          let released = false;
          let ready = false;
          let pollFinished = false;
          const stop = new AbortController();
          const workersStop = new AbortController();
          const runner = new SimulationPollTaskRunner();
          const deliveries: string[] = [];
          const records = new Map<string, HistoryRecord[]>([
            ["a", []],
            ["b", []],
          ]);
          let batches = 0;
          let holdCalls = 0;
          async function hold(task: SimulationTask) {
            holdCalls++;
            held = true;
            gate.notifyAll(task, "A held");
            while (!released) await gate.wait(task, "A release");
          }
          function record(
            task: SimulationTask,
            orbId: string,
            id: string,
            inbox = false,
          ): HistoryRecord {
            const list = records.get(orbId) ?? [];
            return {
              id,
              parentId: list.at(-1)?.id ?? null,
              timestamp: new Date(task.wallNow()).toISOString(),
              overflow: {},
              type: "message",
              role: "user",
              content: [{ type: "text", text: id }],
              ...(inbox ? { inboxMessageIds: [id] } : {}),
            };
          }
          const claim = h.store.claimNextOrbMessageBatch.bind(h.store);
          h.store.claimNextOrbMessageBatch = (task, request) =>
            new ResultAsync(
              (async () => {
                if (request.orbId === "a" && phase === "claim" && !released) await hold(task);
                return claim(task, request);
              })(),
            );
          const commit = h.store.commitPullBatch.bind(h.store);
          h.store.commitPullBatch = (task, request) =>
            new ResultAsync(
              (async () => {
                if (request.orbId === "a" && phase === "commit" && !released) await hold(task);
                return commit(task, request);
              })(),
            );
          const plane: AgentPlane = {
            placement: "central",
            health: (task, orb) =>
              new ResultAsync(
                (async () => {
                  if (orb.id === "a" && phase === "health" && !released) await hold(task);
                  return ok({
                    v: 1 as const,
                    orbId: orb.id,
                    runtimeInstanceId: orb.id,
                    status: "ready" as const,
                    checkoutCommit: "central",
                    sessionId: orb.id,
                    activity: "busy" as const,
                  });
                })(),
              ),
            deliverMessage: (task, orb, request) =>
              new ResultAsync(
                (async () => {
                  if (orb.id === "a" && phase === "delivery" && !released) await hold(task);
                  if (!deliveries.includes(request.messageId)) {
                    records.get(orb.id)?.push(record(task, orb.id, request.messageId, true));
                    deliveries.push(request.messageId);
                  }
                  gate.notifyAll(task, "delivered");
                  return ok({
                    v: 1 as const,
                    messageId: request.messageId,
                    status: "persisted" as const,
                    delivery: "steer" as const,
                    operationId: "turn",
                    duplicate: false,
                  });
                })(),
              ),
            pullHistory: (task, orb, request) =>
              new ResultAsync(
                (async () => {
                  if (orb.id === "a" && phase === "history" && !released) await hold(task);
                  const list = records.get(orb.id) ?? [];
                  if (orb.id === "a" && phase === "catchup" && !released) {
                    list.push(record(task, orb.id, `catchup-${++batches}`));
                    held = true;
                    gate.notifyAll(task, "catchup continues");
                    await task.sleep(5, "sustained new history");
                  }
                  const index =
                    request.after === null
                      ? -1
                      : list.findIndex((item) => item.id === request.after);
                  const page = list.slice(index + 1);
                  return ok({
                    v: 1 as const,
                    orbId: orb.id,
                    runtimeInstanceId: orb.id,
                    activity: "busy" as const,
                    session: { id: orb.id, overflow: {} },
                    records: page,
                    cursor: page.at(-1)?.id ?? request.after,
                    headId: list.at(-1)?.id ?? null,
                  });
                })(),
              ),
            prepareIdleStop: () => okAsync({ v: 1 as const, prepared: false }),
            suspend: () => okAsync(undefined),
            dispose: () => okAsync(undefined),
            close: () => okAsync(undefined),
            session: () => null,
          };
          const deps = {
            ...h.deps,
            agentPlane: plane,
            nameGenerator: {
              generate: (task: SimulationTask) =>
                new ResultAsync(
                  (async () => {
                    if (phase === "naming" && !released) await hold(task);
                    return ok("A name");
                  })(),
                ),
            },
          };
          const result = await sim.runTasks([
            ...["central:a", "central:b", "poll:a", "poll:b", "name:a", "name:b"].map((lane) => ({
              name: lane,
              f: (task: SimulationTask) => runner.worker(task, lane, workersStop.signal),
            })),
            {
              name: "poller",
              f: async (task) => {
                while (!ready) await gate.wait(task, "setup");
                await pollLoop(task, deps, stop.signal, runner.run);
                pollFinished = true;
                workersStop.abort();
              },
            },
            {
              name: "driver",
              f: async (task) => {
                records.get("a")?.push(record(task, "a", "seed"));
                if (["health", "claim", "delivery"].includes(phase))
                  expect(
                    (
                      await h.store.enqueueOrbMessage(task, {
                        orbId: "a",
                        messageId: "a-input",
                        content: [{ type: "text", text: "A input" }],
                        now: task.wallNow(),
                      })
                    ).isOk(),
                  ).toBe(true);
                ready = true;
                gate.notifyAll(task, "setup ready");
                while (!held) await gate.wait(task, "A enters phase");
                for (const id of ["b-first", "b-later"]) {
                  expect(
                    (
                      await h.store.enqueueOrbMessage(task, {
                        orbId: "b",
                        messageId: id,
                        content: [{ type: "text", text: id }],
                        now: task.wallNow(),
                      })
                    ).isOk(),
                  ).toBe(true);
                  await waitUntil(
                    task,
                    `${id} receipt before A release`,
                    () =>
                      h.store
                        .messageSnapshots("b")
                        .some((row) => row.messageId === id && row.status === "delivered"),
                    { intervalMs: 20, timeoutMs: 1_000 },
                  );
                  expect(released).toBe(false);
                  await task.sleep(80, "future dispatcher ticks");
                }
                if (["history", "commit", "naming", "catchup"].includes(phase)) {
                  expect(
                    (
                      await h.store.enqueueOrbMessage(task, {
                        orbId: "a",
                        messageId: "a-later",
                        content: [{ type: "text", text: "later" }],
                        now: task.wallNow(),
                      })
                    ).isOk(),
                  ).toBe(true);
                  await waitUntil(
                    task,
                    "A central lane remains independent",
                    () => deliveries.includes("a-later"),
                    { intervalMs: 20, timeoutMs: 1_000 },
                  );
                }
                if (phase === "catchup") expect(batches).toBeGreaterThan(3);
                else expect(holdCalls).toBe(1);
                stop.abort();
                const callsAtStop = runner.calls;
                await task.sleep(80, "shutdown waits for held lanes");
                expect(pollFinished).toBe(phase === "catchup");
                expect(runner.calls).toBe(callsAtStop);
                released = true;
                gate.notifyAll(task, "A released after shutdown drain check");
              },
            },
          ]);
          expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
          expect(deliveries).toContain("b-later");
          expect(pollFinished).toBe(true);
        },
      );
    });
  }
});

for (const ending of ["shutdown", "fatal"] as const) {
  it(`drains sustained catchup on ${ending} without releasing the source`, async () => {
    const logs = new LogCapture();
    await runDst(
      {
        name: `poll-catchup-${ending}`,
        iterations: 30,
        lateTimerProbability: 0,
        logCapture: logs,
        maxVirtualDurationMs: 2_000,
      },
      async (sim) => {
        const h = makeHarness({ constants: { reconcileTickMs: 20, historyPullIntervalMs: 20 } });
        h.store.seedProject(makeProjectRow("project"));
        h.store.seedOrb(makeOrbRow("a", "project", "creating", { name: "a" }));
        if (ending === "fatal")
          h.store.seedOrb(makeOrbRow("b", "project", "creating", { name: "b" }));
        const gate = new ConditionVariable("catchup boundary");
        const stop = new AbortController();
        const workersStop = new AbortController();
        const runner = new SimulationPollTaskRunner();
        const crash = new Error("crashed history lane");
        let pulls = 0;
        let commits = 0;
        let held = false;
        let releaseCommit = false;
        let triggerCrash = false;
        let finished = false;
        let failure: unknown;
        const commit = h.store.commitPullBatch.bind(h.store);
        h.store.commitPullBatch = (task, request) =>
          new ResultAsync(
            (async () => {
              if (request.orbId === "a" && commits === 3) {
                held = true;
                gate.notifyAll(task, "commit held");
                while (!releaseCommit) await gate.wait(task, "release safe commit");
              }
              const result = await commit(task, request);
              if (result.isOk()) commits++;
              return result;
            })(),
          );
        const plane: AgentPlane = {
          placement: "central",
          health: (_task, orb) =>
            okAsync({
              v: 1,
              orbId: orb.id,
              runtimeInstanceId: orb.id,
              status: "ready",
              checkoutCommit: "central",
              sessionId: orb.id,
              activity: "idle",
            }),
          deliverMessage: () => {
            throw new Error("no messages expected");
          },
          pullHistory: (task, orb, request) =>
            new ResultAsync(
              (async () => {
                const id = `record-${++pulls}`;
                const records: HistoryRecord[] =
                  orb.id === "a"
                    ? [
                        {
                          id,
                          parentId: request.after,
                          timestamp: new Date(task.wallNow()).toISOString(),
                          overflow: {},
                          type: "message",
                          role: "user",
                          content: [{ type: "text", text: id }],
                        },
                      ]
                    : [];
                await task.sleep(5, "source remains nonempty");
                return ok({
                  v: 1 as const,
                  orbId: orb.id,
                  runtimeInstanceId: orb.id,
                  activity: "idle" as const,
                  session: { id: orb.id, overflow: {} },
                  records,
                  cursor: records.at(-1)?.id ?? request.after,
                  headId: records.at(-1)?.id ?? null,
                });
              })(),
            ),
          prepareIdleStop: () => okAsync({ v: 1, prepared: false }),
          suspend: () => okAsync(undefined),
          dispose: () => okAsync(undefined),
          close: () => okAsync(undefined),
          session: () => null,
        };
        const deps = { ...h.deps, agentPlane: plane };
        const run: ReconcileTaskRunner = (lane, operation) =>
          runner.run(
            lane,
            lane === "poll:b"
              ? async (task) => {
                  while (!triggerCrash) await gate.wait(task, "crash trigger");
                  throw crash;
                }
              : operation,
          );
        const result = await sim.runTasks([
          ...["central:a", "poll:a", ...(ending === "fatal" ? ["central:b", "poll:b"] : [])].map(
            (lane) => ({
              name: lane,
              f: (task: SimulationTask) => runner.worker(task, lane, workersStop.signal),
            }),
          ),
          {
            name: "poller",
            f: async (task) => {
              try {
                await pollLoop(task, deps, stop.signal, run);
              } catch (error) {
                failure = error;
              } finally {
                finished = true;
                workersStop.abort();
              }
            },
          },
          {
            name: "driver",
            f: async (task) => {
              while (!held) await gate.wait(task, "fourth batch reaches commit");
              // A yielded catchup must not erase an existing retry episode or schedule success.
              h.deps.control.bumpRetryAttempts("poll:a");
              const nextAttempt = h.deps.control.getNextAttemptAt("poll:a");
              if (ending === "shutdown") stop.abort();
              else {
                triggerCrash = true;
                gate.notifyAll(task, "crash lane");
                await waitUntil(
                  task,
                  "crash captured",
                  () => logs.matching("poll-task-crashed").length === 1,
                  { intervalMs: 5, timeoutMs: 200 },
                );
              }
              const calls = runner.calls;
              await task.sleep(60, "admitted commit must drain");
              expect(finished).toBe(false);
              expect(commits).toBe(3);
              expect(runner.calls).toBe(calls);
              releaseCommit = true;
              gate.notifyAll(task, "finish current commit only");
              await waitUntil(task, "sustained source must not block drain", () => finished, {
                intervalMs: 5,
                timeoutMs: 200,
              });
              expect(commits).toBe(4);
              const replica = h.store.replicaRecords("a");
              expect(replica).toHaveLength(4);
              expect(h.store.orbSnapshot("a")?.replicationCursor).toBe(replica.at(-1)?.id);
              expect(h.store.orbSnapshot("a")?.replicatedHeadId).toBe(replica.at(-1)?.id);
              expect(h.deps.control.hasRetryAttempts("poll:a")).toBe(true);
              expect(h.deps.control.getNextAttemptAt("poll:a")).toBe(nextAttempt);
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        expect(failure).toBe(ending === "fatal" ? crash : undefined);
        expect(logs.matching("pull-failed")).toHaveLength(0);
        expect(logs.matching("poll-task-crashed")).toHaveLength(ending === "fatal" ? 1 : 0);
      },
    );
  });
}

// Model/native harness ports only; routing, publication, receipts and lifecycle are production.
it.each(
  (["pi", "claude"] as const).flatMap((target) =>
    (["before", "after", "cas"] as const).flatMap((fault) =>
      (["stop", "delete"] as const).map((ending) => ({ target, fault, ending })),
    ),
  ),
)(
  "composes mixed poll lanes: $target receipt $fault, $ending, restart",
  async ({ target, fault, ending }) => {
    let seed = 0x97c0ffee;
    const entropy = vi.spyOn(SimpleEntropySource.prototype, "random").mockImplementation(() => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    });
    const logs = new LogCapture();
    try {
      await runDst(
        {
          name: `poll-composed-${target}-${fault}-${ending}`,
          iterations: 20,
          lateTimerProbability: 0,
          maxVirtualDurationMs: 120_000,
          logCapture: logs,
          failpointProbabilities:
            fault === "cas"
              ? {}
              : {
                  [fault === "before" ? FAILPOINTS.storeCommitBefore : FAILPOINTS.storeCommitAfter]:
                    1,
                },
        },
        async (sim) => {
          let h = makeHarness({
            constants: {
              reconcileTickMs: 20,
              historyPullIntervalMs: 20,
              runtimeRequestTimeoutMs: 100_000,
              idleStopAfterMs: 1_000_000,
              deletionQuarantineMs: 200,
              hostBackstopIntervalMs: 100,
            },
          });
          const gate = new ConditionVariable("composed receipt window");
          const ids = ["a", "b", "c"];
          const suspended = new Set<string>();
          let ready = false;
          let held = false;
          let released = false;
          let winnerReady = false;
          let captured: CommitPullBatchParams | undefined;
          let failures = 0;
          let conflicts = 0;
          const original = h.store.commitPullBatch.bind(h.store);
          // Only the first target commit fires the existing transaction failpoints.
          const scopedTask = (task: SimulationTask, inject = false) =>
            new Proxy(task, {
              get(t, key) {
                if (key === "failpoint")
                  return (name: string, ...args: unknown[]) =>
                    t.failpoint(inject ? name : `disabled:${name}`, ...args);
                const value = Reflect.get(t, key);
                return typeof value === "function" ? value.bind(t) : value;
              },
            });
          h.store.commitPullBatch = (task, request) =>
            new ResultAsync(
              (async () => {
                const first = request.orbId === "a" && captured === undefined;
                if (first) {
                  captured = request;
                  gate.notifyAll(task, "receipt admitted");
                  if (fault === "cas") {
                    while (!winnerReady) await gate.wait(task, "competing commit wins");
                  }
                } else if (request.orbId === "a" && !released) {
                  while (!released) await gate.wait(task, "target receipt lane held");
                }
                const result = await original(scopedTask(task, first), request);
                if (first) {
                  expect(result.isErr()).toBe(true);
                  if (result.isErr()) {
                    expect(result.error.type).toBe(
                      fault === "cas" ? "cursor_conflict" : "store_error",
                    );
                    if (fault === "cas") conflicts++;
                    else failures++;
                  }
                  held = true;
                  gate.notifyAll(task, "failure happened before lifecycle command");
                  while (!released) await gate.wait(task, "failed receipt response held");
                }
                return result;
              })(),
            );
          const snapshot = (id: string) => {
            const session = h.world.sessionHeaderOf(id);
            if (session === null) throw new Error("seeded mixed session missing");
            return {
              orbId: id,
              runtimeInstanceId: `central-${id}`,
              activity: "busy" as const,
              session,
              records: [...h.world.entriesOf(id)],
              headId: h.world.entriesOf(id).at(-1)?.id ?? null,
            };
          };
          const compose = () => {
            const pi: AgentPlane = {
              placement: "central",
              health: (_task, orb) =>
                okAsync({
                  v: 1,
                  orbId: orb.id,
                  runtimeInstanceId: `central-${orb.id}`,
                  status: "ready",
                  checkoutCommit: "central",
                  sessionId: snapshot(orb.id).session.id,
                  activity: suspended.has(orb.id) ? "idle" : "busy",
                }),
              deliverMessage: (task, orb, request) => {
                expect(orb.harness).toBe("pi");
                const response = h.world.deliverInboxBatch(
                  orb.id,
                  {
                    batchId: request.messageId,
                    messageIds: request.messageIds ?? [request.messageId],
                    text: request.messageId,
                  },
                  { flush: true },
                );
                return commitAgentHistory(task, h.deps, snapshot(orb.id)).map(() => response);
              },
              pullHistory: (task, orb, request) => {
                expect(orb.harness).toBe("pi");
                const value = snapshot(orb.id);
                const index =
                  request.after === null
                    ? -1
                    : value.records.findIndex((r) => r.id === request.after);
                const records = value.records.slice(index + 1, index + 1 + request.limit);
                return ResultAsync.fromSafePromise(task.checkpoint("central harness snapshot")).map(
                  () => ({
                    v: 1 as const,
                    ...value,
                    records,
                    cursor: records.at(-1)?.id ?? request.after,
                  }),
                );
              },
              prepareIdleStop: () => okAsync({ v: 1, prepared: false }),
              suspend: (_task, id) => {
                suspended.add(id);
                return okAsync(undefined);
              },
              dispose: (_task, id) => {
                suspended.add(id);
                return okAsync(undefined);
              },
              session: () => null,
              close: () => okAsync(undefined),
            };
            return {
              ...h.deps,
              agentPlane: new HarnessAgentPlane(pi, new SdkAgentPlane(h.deps), h.store),
            };
          };
          const enqueue = async (task: SimulationTask, id: string, suffix: string) => {
            expect(
              (
                await h.store.enqueueOrbMessage(task, {
                  orbId: id,
                  messageId: `${id}-${suffix}`,
                  content: [{ type: "text", text: suffix }],
                  now: task.wallNow(),
                })
              ).isOk(),
            ).toBe(true);
          };
          const until = (
            task: SimulationTask,
            reason: string,
            predicate: () => boolean,
            timeoutMs = 10_000,
          ) => waitUntil(task, reason, predicate, { intervalMs: 20, timeoutMs });
          const delivered = (id: string, suffix: string) =>
            h.store
              .messageSnapshots(id)
              .some((row) => row.messageId === `${id}-${suffix}` && row.status === "delivered");
          const assertReceipts = (id: string) => {
            assertReplicaIntegrity(h.world, h.store, id);
            const receiptIds = h.store
              .replicaRecords(id)
              .flatMap((r) =>
                r.type === "message" || r.type === "event" ? (r.inboxMessageIds ?? []) : [],
              );
            expect(new Set(receiptIds).size).toBe(receiptIds.length);
            for (const row of h.store.messageSnapshots(id))
              expect(row.status === "delivered").toBe(receiptIds.includes(row.messageId));
            return receiptIds;
          };
          for (const process of [0, 1]) {
            if (process === 1) {
              const old = h.deps.control;
              h = restartControlPlane(h);
              expect(h.deps.control).not.toBe(old);
            }
            const deps = compose();
            const stop = new AbortController();
            const workersStop = new AbortController();
            const runner = new SimulationPollTaskRunner();
            const active = new Set<string>();
            const admissions = new Map<string, number>();
            const run: ReconcileTaskRunner = (lane, operation) => {
              expect(active.has(lane), `overlapping ${lane} in process ${process}`).toBe(false);
              active.add(lane);
              admissions.set(lane, (admissions.get(lane) ?? 0) + 1);
              return runner.run(lane, operation).finally(() => active.delete(lane));
            };
            let finished = 0;
            const loop = async (task: SimulationTask, kind: "poll" | "reconcile") => {
              while (!ready) await gate.wait(task, "seeded mixed fleet");
              if (kind === "poll") await pollLoop(task, deps, stop.signal, run);
              else await reconcileLoop(task, deps, stop.signal, run);
              if (++finished === 2) workersStop.abort();
            };
            const result = await sim.runTasks([
              ...ids
                .flatMap((id) => [id, `central:${id}`, `poll:${id}`])
                .map((lane) => ({
                  name: `${process}:${lane}`,
                  f: (task: SimulationTask) => runner.worker(task, lane, workersStop.signal),
                })),
              { name: `${process}:poller`, f: (task) => loop(task, "poll") },
              { name: `${process}:reconciler`, f: (task) => loop(task, "reconcile") },
              {
                name: `${process}:driver`,
                f: async (task) => {
                  if (process === 0) {
                    for (const id of ids) {
                      seedRunningOrb(task, h, id);
                      const orb = h.store.orbSnapshot(id);
                      if (orb === null) throw new Error("seeded mixed orb missing");
                      h.store.seedOrb({
                        ...orb,
                        name: id,
                        harness: (id === "a" ? target === "claude" : id === "c") ? "claude" : "pi",
                      });
                    }
                    await enqueue(task, "a", "first");
                    ready = true;
                    gate.notifyAll(task, "fleet ready");
                    while (captured === undefined) await gate.wait(task, "first receipt window");
                    if (fault === "cas") {
                      expect((await original(task, captured)).isOk()).toBe(true);
                      winnerReady = true;
                      gate.notifyAll(task, "real cursor CAS winner committed");
                    }
                    while (!held) await gate.wait(task, "fault actually happened");
                    expect(failures + conflicts).toBe(1);
                    assertReceipts("a");
                    expect(delivered("a", "first")).toBe(fault !== "before");
                    expect(h.store.orbSnapshot("a")).toMatchObject({
                      replicationCursor: fault === "before" ? null : captured.nextCursor,
                      replicatedHeadId: fault === "before" ? null : captured.nextHeadId,
                    });
                    expect(h.store.replicaRecords("a")).toHaveLength(fault === "before" ? 0 : 1);
                    await enqueue(task, "a", "later");
                    for (const suffix of ["first", "later"]) {
                      for (const id of ["b", "c"]) await enqueue(task, id, suffix);
                      await until(task, "both sibling receipts while A held", () =>
                        ["b", "c"].every((id) => delivered(id, suffix)),
                      );
                      for (const id of ["b", "c"]) assertReceipts(id);
                      expect(released).toBe(false);
                      expect(delivered("a", "later")).toBe(false);
                      await task.sleep(80, "later dispatcher ticks do not overlap held lane");
                    }
                    expect(admissions.get("central:c")).toBeUndefined();
                    expect(admissions.get("central:b")).toBeGreaterThan(1);
                    expect(admissions.get("poll:c")).toBeGreaterThan(1);
                    expect(
                      (
                        await (ending === "stop" ? requestOrbStop : requestOrbDeletion)(
                          task,
                          deps,
                          "a",
                        )
                      ).isOk(),
                    ).toBe(true);
                    expect(
                      logs.matching(ending === "stop" ? "stop-accepted" : "delete_requested"),
                    ).toHaveLength(1);
                    // End process admission only after the forced fault and user command; drain admitted I/O.
                    stop.abort();
                    released = true;
                    gate.notifyAll(task, "old process drains receipt responses");
                  } else {
                    await until(
                      task,
                      "restarted lifecycle completes",
                      () =>
                        ending === "stop"
                          ? h.store.orbSnapshot("a")?.state === "stopped"
                          : h.store.orbSnapshot("a") === null,
                      60_000,
                    );
                    if (ending === "stop") {
                      await until(
                        task,
                        "Stop retains accepted native receipt history",
                        () => h.store.replicaRecords("a").length === h.world.entriesOf("a").length,
                      );
                      assertReplicaComplete(h.world, h.store, "a");
                      const receiptIds = assertReceipts("a");
                      expect(delivered("a", "first")).toBe(true);
                      expect(receiptIds).toEqual(
                        ["a-first", "a-later"].slice(0, receiptIds.length),
                      );
                      expect(h.store.messageSnapshots("a").every((row) => !row.autoStart)).toBe(
                        true,
                      );
                      expect(h.world.filesystemExists("a")).toBe(true);
                    } else {
                      if (captured === undefined) throw new Error("receipt window missing");
                      const inbox = h.store.messageSnapshots("a");
                      const late = await original(scopedTask(task), captured);
                      expect(late.isErr()).toBe(true);
                      if (late.isErr())
                        expect(late.error).toMatchObject({
                          type: "replication_integrity",
                          reason: "mapping_failure",
                        });
                      expect(h.store.replicaRecords("a")).toEqual([]);
                      expect(h.store.messageSnapshots("a")).toEqual(inbox);
                      expect(h.world.filesystemExists("a")).toBe(false);
                    }
                    for (const id of ["b", "c"]) {
                      await enqueue(task, id, "restart");
                      await until(task, "sibling progresses in fresh process", () =>
                        delivered(id, "restart"),
                      );
                      assertReplicaComplete(h.world, h.store, id);
                      expect(assertReceipts(id)).toEqual([
                        `${id}-first`,
                        `${id}-later`,
                        `${id}-restart`,
                      ]);
                    }
                    await task.sleep(200, "terminal backstop cannot resurrect Stop/delete");
                    expect(h.store.orbSnapshot("a")?.state ?? null).toBe(
                      ending === "stop" ? "stopped" : null,
                    );
                    if (ending === "stop") expect(h.world.hostStateOf("a")).toBe("stopped");
                    else expect(h.world.hostCount("a")).toBe(0);
                    stop.abort();
                  }
                },
              },
            ]);
            expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
            expect(active.size).toBe(0);
            expect(finished).toBe(2);
          }
          expect(failures).toBe(fault === "cas" ? 0 : 1);
          expect(conflicts).toBe(fault === "cas" ? 1 : 0);
          expect(logs.matching("poll-task-crashed")).toHaveLength(0);
          expect(logs.matching("reconcile-task-crashed")).toHaveLength(0);
        },
      );
    } finally {
      entropy.mockRestore();
    }
  },
);
