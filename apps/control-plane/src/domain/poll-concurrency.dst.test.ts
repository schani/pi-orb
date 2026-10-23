import type { HistoryRecord } from "@pi-orb/protocol";
import { ConditionVariable, type SimulationTask } from "determined";
import { ok, okAsync, type Result, ResultAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { SdkAgentPlane } from "../adapters/sdk-agent-plane.ts";
import { FAILPOINTS } from "../testkit/failpoints.ts";
import {
  makeHarness,
  makeOrbRow,
  makeProjectRow,
  restartControlPlane,
  seedRunningOrb,
} from "../testkit/fixtures.ts";
import { assertReplicaComplete } from "../testkit/invariants.ts";
import { LogCapture, runDst, waitUntil } from "../testkit/sim.ts";
import { SimulationTaskRunner } from "../testkit/simulation-task-runner.ts";
import { commitAgentHistory } from "./agent-history.ts";
import type { AgentPlane } from "./agent-ports.ts";
import { HarnessAgentPlane } from "./harness-agent-plane.ts";
import { requestOrbDeletion, requestOrbStop } from "./lifecycle.ts";
import { pollLoop, type ReconcileTaskRunner, reconcileLoop } from "./loops.ts";
import type { CommitPullBatchParams } from "./ports.ts";

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
          const runner = new SimulationTaskRunner();
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
          const claim = h.store.claimOrbMessageBacklog.bind(h.store);
          h.store.claimOrbMessageBacklog = (task, request) =>
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
        const runner = new SimulationTaskRunner();
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

// In-memory atomic-stage boundaries, not PostgreSQL isolation.
const boundaryCases = (["stop", "delete"] as const).flatMap(
  (ending) =>
    [
      { ending, fault: "before", order: "lifecycle-first" },
      { ending, fault: "after", order: "commit-first" },
      { ending, fault: "cas", order: "lifecycle-first" },
      { ending, fault: "cas", order: "commit-first" },
    ] as const,
);
it.each(boundaryCases)(
  "composes poll $fault/$ending/$order at the commit boundary",
  async ({ fault, ending, order }) => {
    const logs = new LogCapture();
    const before = FAILPOINTS.storeCommitBefore,
      after = FAILPOINTS.storeCommitAfter;
    const injection = fault === "before" ? before : fault === "after" ? after : "";
    const edge = order === "lifecycle-first" ? before : after;
    const firstError =
      fault === "cas"
        ? order === "lifecycle-first"
          ? "cursor_conflict"
          : undefined
        : "store_error";
    await runDst(
      {
        name: `poll-boundary-${fault}-${ending}-${order}`,
        iterations: 10,
        lateTimerProbability: 0,
        logCapture: logs,
        failpointProbabilities: { [injection]: 1 },
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
        const ids = ["a", "b", "c"];
        const gate = new ConditionVariable("atomic stage");
        let captured: CommitPullBatchParams | undefined;
        let deliveryTask: SimulationTask | undefined;
        let ready = false,
          boundary = false,
          command = false,
          lifecycle = false;
        let release = false,
          completed = false;
        const until = (task: SimulationTask, why: string, check: () => boolean) =>
          waitUntil(task, why, check, { intervalMs: 20, timeoutMs: 60_000 });
        const replica = (id: string) => h.store.replicaRecords(id);
        const messages = (id: string) => h.store.messageSnapshots(id);
        const receipts = (id: string) =>
          replica(id).flatMap((r) =>
            r.type === "message" || r.type === "event" ? (r.inboxMessageIds ?? []) : [],
          );
        const delivered = (id: string, suffix: string) =>
          messages(id).some((r) => r.messageId === `${id}-${suffix}` && r.status === "delivered");
        const atomic = (present: boolean) => {
          expect(captured?.records).toHaveLength(1);
          expect(replica("a")).toEqual(present ? captured?.records : []);
          expect(receipts("a")).toEqual(present ? ["a-first"] : []);
          expect(delivered("a", "first")).toBe(present);
          expect(h.store.orbSnapshot("a")).toMatchObject({
            replicationCursor: present ? captured?.nextCursor : null,
            replicatedHeadId: present ? captured?.nextHeadId : null,
          });
        };
        // This SDK-backed central port models guest acceptance, not Native admission.
        const trace: { edge: string; ids: readonly string[]; version?: number; state?: string }[] =
          [];
        const openAdmissionVersion = 0;
        let permitted: string[] | undefined;
        const entered: string[] = [];
        const accept = h.world.deliverInboxBatch.bind(h.world);
        h.world.deliverInboxBatch = (orbId, request, options) => {
          const response = accept(orbId, request, options);
          if (orbId === "a" && !response.duplicate) {
            // No await separates acceptance from this public authority snapshot.
            const authority = h.store.orbSnapshot(orbId);
            trace.push({
              edge: "guest-accepted",
              ids: [...request.messageIds],
              version: authority?.agentAdmissionVersion ?? -1,
              state: authority?.state ?? "missing",
            });
            expect(
              authority,
              `new modeled guest acceptance outside open authority: ${JSON.stringify(trace)}`,
            ).toMatchObject({ state: "running", agentAdmissionVersion: openAdmissionVersion });
          }
          return response;
        };
        const append = h.world.appendInboxMessage.bind(h.world);
        h.world.appendInboxMessage = (orbId, messageIds, text, classification) => {
          const record = append(orbId, messageIds, text, classification);
          if (orbId === "a") trace.push({ edge: "guest-durable", ids: [...messageIds] });
          return record;
        };
        const original = h.store.commitPullBatch.bind(h.store);
        const scoped = (task: SimulationTask, first = false): SimulationTask => ({
          ...task,
          failpoint: async (name, ...args) => {
            if (name === after && args[0] === "a")
              trace.push({
                edge: "public-commit-observed",
                ids: [h.store.orbSnapshot("a")?.replicationCursor ?? ""],
              });
            if (first && name === edge) {
              trace.push({ edge: `held-${name}`, ids: [] });
              boundary = true;
              gate.notifyAll(task, "transaction at atomic boundary");
              while (!release) await gate.wait(task, "lifecycle versus stage/response");
            }
            return task.failpoint(first && name === injection ? name : "disabled", ...args);
          },
        });
        const errorIs = (r: Result<unknown, { type: string }>, type?: string) =>
          expect(r.isErr() ? r.error.type : undefined).toBe(type);
        h.store.commitPullBatch = (task, request) =>
          new ResultAsync(
            (async () => {
              // Hold delivery's projection, not the independent history lane's transaction.
              if (request.orbId === "a" && task !== deliveryTask)
                while (!completed) await gate.wait(task, "initial delivery projection");
              const first = request.orbId === "a" && captured === undefined;
              if (first) captured = request;
              else if (request.orbId === "a")
                while (!completed) await gate.wait(task, "recovery admission");
              const result = await original(scoped(task, first), request);
              if (first) {
                errorIs(result, firstError);
                atomic(fault !== "before");
                completed = true;
                gate.notifyAll(task, "recovery admitted after atomicity witness");
              }
              return result;
            })(),
          );
        const good = (r: { isOk(): boolean }) => expect(r.isOk()).toBe(true);
        const enqueue = async (task: SimulationTask, id: string, suffix: string, wake = true) =>
          good(
            await h.store.enqueueOrbMessage(task, {
              orbId: id,
              messageId: `${id}-${suffix}`,
              content: [{ type: "text", text: suffix }],
              now: task.wallNow(),
              wake,
            }),
          );
        const state = () => h.store.orbSnapshot("a")?.state ?? null;
        const terminal = ending === "stop" ? "stopped" : null;
        for (const process of [0, 1]) {
          const previous = h.deps.control;
          if (process) h = restartControlPlane(h);
          expect(h.deps.control === previous).toBe(process === 0);
          const sdk = new SdkAgentPlane(h.deps);
          const pi: AgentPlane = {
            placement: "central",
            health: sdk.health.bind(sdk),
            deliverMessage: (task, orb, request, context) => {
              if (orb.id === "a") {
                entered.push(...request.messageIds);
                trace.push({ edge: "port-entered", ids: [...request.messageIds] });
              }
              return sdk.deliverMessage(task, orb, request, context).andThen((response) => {
                h.world.flushPendingInboxBatches(orb.id);
                const session = h.world.sessionHeaderOf(orb.id);
                if (session === null) throw new Error("seeded session missing");
                const records = [...h.world.entriesOf(orb.id)];
                if (orb.id === "a") deliveryTask = task;
                return commitAgentHistory(task, h.deps, {
                  orbId: orb.id,
                  runtimeInstanceId: orb.id,
                  session,
                  records,
                  headId: records.at(-1)?.id ?? null,
                  activity: "busy",
                }).map(() => response);
              });
            },
            pullHistory: sdk.pullHistory.bind(sdk),
            prepareIdleStop: sdk.prepareIdleStop.bind(sdk),
            suspend: sdk.suspend.bind(sdk),
            dispose: sdk.dispose.bind(sdk),
            close: sdk.close.bind(sdk),
            session: sdk.session.bind(sdk),
          };
          const deps = { ...h.deps, agentPlane: new HarnessAgentPlane(pi, sdk, h.store) };
          const stop = new AbortController(),
            workersStop = new AbortController();
          const runner = new SimulationTaskRunner();
          const active = new Set<string>();
          const run: ReconcileTaskRunner = (lane, operation) => {
            expect(active.has(lane), `overlapping ${lane}`).toBe(false);
            active.add(lane);
            return runner.run(lane, operation).finally(() => active.delete(lane));
          };
          let finished = 0;
          const loop = async (task: SimulationTask, poll: boolean) => {
            while (!ready) await gate.wait(task, "fleet seeded");
            await (poll ? pollLoop : reconcileLoop)(task, deps, stop.signal, run);
            if (++finished === 2) workersStop.abort();
          };
          const result = await sim.runTasks([
            ...ids
              .flatMap((id) => [id, `central:${id}`, `poll:${id}`])
              .map((lane) => ({
                name: `${process}:${lane}`,
                f: (task: SimulationTask) => runner.worker(task, lane, workersStop.signal),
              })),
            { name: "poller", f: (task) => loop(task, true) },
            { name: "reconciler", f: (task) => loop(task, false) },
            {
              name: "lifecycle actor",
              f: async (task) => {
                if (process) return;
                while (!command) await gate.wait(task, "lifecycle command");
                good(
                  await (ending === "stop" ? requestOrbStop : requestOrbDeletion)(task, deps, "a"),
                );
                const authority = h.store.orbSnapshot("a");
                expect(authority).toMatchObject({
                  state: ending === "stop" ? "stopping" : "deleting",
                  agentAdmissionVersion: openAdmissionVersion + 1,
                });
                // This observes the committed fence version, not its mutation timestamp.
                trace.push({
                  edge: "fence-version-observed",
                  ids: [],
                  version: authority?.agentAdmissionVersion ?? -1,
                });
                permitted = trace
                  .filter((e) => e.edge === "guest-accepted" && e.version === openAdmissionVersion)
                  .flatMap((e) => e.ids);
                expect(permitted, JSON.stringify(trace)).toEqual(["a-first"]);
                if (fault === "cas") {
                  if (captured === undefined) throw new Error("missing pending CAS");
                  const competitor = await original(scoped(task), captured);
                  errorIs(competitor, order === "commit-first" ? "cursor_conflict" : undefined);
                  atomic(true);
                }
                lifecycle = true;
              },
            },
            {
              name: "driver",
              f: async (task) => {
                if (!process) {
                  for (const id of ids) {
                    seedRunningOrb(task, h, id);
                    const orb = h.store.orbSnapshot(id);
                    if (orb === null) throw new Error("seeded orb missing");
                    h.store.seedOrb({
                      ...orb,
                      name: id,
                      harness: id === "b" ? "claude" : "pi",
                    });
                  }
                  h.world.scriptDeliverMessage("a", { kind: "enqueue_without_persist" });
                  await enqueue(task, "a", "first");
                  ready = true;
                  gate.notifyAll(task, "fleet ready");
                  await until(task, "actual transaction boundary", () => boundary);
                  atomic(order === "commit-first");
                  expect(
                    trace.filter((e) => e.edge === "guest-accepted").flatMap((e) => e.ids),
                  ).toEqual(["a-first"]);
                  expect(trace.map((e) => e.edge).slice(0, 3)).toEqual([
                    "port-entered",
                    "guest-accepted",
                    "guest-durable",
                  ]);
                  await enqueue(task, "a", "later");
                  trace.push({ edge: "inbox-queued", ids: ["a-later"] });
                  for (const suffix of ["first", "later"]) {
                    for (const id of ids.slice(1)) {
                      await enqueue(task, id, suffix);
                      await until(task, `${id} receipt while A held`, () => delivered(id, suffix));
                      assertReplicaComplete(h.world, h.store, id);
                      expect(release).toBe(false);
                    }
                    await task.sleep(80, "future dispatcher ticks");
                  }
                  expect(entered, JSON.stringify(trace)).toEqual(["a-first"]);
                  expect(messages("a").find((r) => r.messageId === "a-later")).toMatchObject({
                    status: "queued",
                    autoStart: false,
                  });
                  command = true;
                  gate.notifyAll(task, "lifecycle command admitted");
                  await until(task, "command during pending commit", () => lifecycle);
                  expect(permitted, JSON.stringify(trace)).toEqual(["a-first"]);
                  const calls = runner.calls;
                  await task.sleep(80, "live dispatch across durable fence");
                  expect(runner.calls).toBeGreaterThan(calls);
                  expect(finished).toBe(0);
                  trace.push({ edge: "release-old-commit", ids: [] });
                  release = true;
                  gate.notifyAll(task, "release admitted old transaction");
                  await until(task, "old transaction settles", () => completed);
                  await until(task, "live lifecycle reaches terminal", () => state() === terminal);
                  if (ending === "stop") {
                    await until(task, "admitted final flush", () => delivered("a", "first"));
                    expect(receipts("a"), JSON.stringify(trace)).toEqual(permitted);
                    await enqueue(task, "a", "fenced", false);
                  } else {
                    if (captured === undefined) throw new Error("missing late commit");
                    const inbox = messages("a");
                    const traceLength = trace.length;
                    errorIs(await original(scoped(task), captured), "replication_integrity");
                    expect(trace).toHaveLength(traceLength);
                    expect(h.store.orbSnapshot("a")).toBeNull();
                    expect(replica("a")).toEqual([]);
                    expect(messages("a")).toEqual(inbox);
                  }
                } else {
                  // Both old loops and all admitted lanes drained; this is not crash recovery.
                  await until(
                    task,
                    "drained restart preserves terminal",
                    () => state() === terminal,
                  );
                }
                for (const id of ids.slice(1)) {
                  const suffix = process ? "restart" : "after-stop";
                  await enqueue(task, id, suffix);
                  await until(task, "unrelated live FIFO", () => delivered(id, suffix));
                  assertReplicaComplete(h.world, h.store, id);
                  expect(receipts(id)).toEqual([
                    `${id}-first`,
                    `${id}-later`,
                    `${id}-after-stop`,
                    ...(process ? [`${id}-restart`] : []),
                  ]);
                  expect(finished).toBe(0);
                }
                await task.sleep(200, "all lanes honor terminal fence");
                expect(state()).toBe(terminal);
                if (ending === "stop") {
                  assertReplicaComplete(h.world, h.store, "a");
                  expect(receipts("a"), JSON.stringify(trace)).toEqual(permitted);
                  expect(messages("a").every((r) => !r.autoStart)).toBe(true);
                  expect(messages("a").find((r) => r.messageId === "a-later")).toMatchObject({
                    status: "queued",
                    autoStart: false,
                  });
                  expect(messages("a").find((r) => r.messageId === "a-fenced")).toMatchObject({
                    status: "queued",
                    autoStart: false,
                  });
                }
                expect(
                  trace.filter((e) => e.edge === "guest-accepted").flatMap((e) => e.ids),
                ).toEqual(permitted);
                expect(finished).toBe(0);
                if (ending === "stop") expect(h.world.hostStateOf("a")).toBe("stopped");
                else expect(h.world.hostCount("a")).toBe(0);
                stop.abort();
              },
            },
          ]);
          expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
          expect(finished).toBe(2);
          expect(active.size).toBe(0);
        }
        expect(logs.matching("stop-accepted")).toHaveLength(ending === "stop" ? 1 : 0);
        expect(logs.matching("delete_requested")).toHaveLength(ending === "delete" ? 1 : 0);
        expect(logs.matching("task-crashed")).toHaveLength(0);
      },
    );
  },
);
