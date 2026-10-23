import type { HistoryRecord } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, errAsync, ok, okAsync, ResultAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { FAILPOINTS } from "../testkit/failpoints.ts";
import { makeHarness, makeProjectRow, seedRunningOrb, TEST_USER_ID } from "../testkit/fixtures.ts";
import { assertReplicaComplete, assertReplicaIntegrity } from "../testkit/invariants.ts";
import { LogCapture, runDst, waitUntil } from "../testkit/sim.ts";
import type { AgentPlane } from "./agent-ports.ts";
import {
  createOrb,
  enqueueOrbMessage,
  requestOrbArchive,
  requestOrbDeletion,
  requestOrbSleep,
  requestOrbStart,
  requestOrbStop,
} from "./lifecycle.ts";
import { pollAllOnce, reconcileAllOnce } from "./loops.ts";
import type { OrbMessageRow } from "./orb.ts";
import { sendOrbMessage } from "./orb-messaging.ts";
import type { ControlPlaneDeps, DeliverMessageClientRequest } from "./ports.ts";

const ORB = "00000000-0000-4000-8000-000000000021";
const PEER = "00000000-0000-4000-8000-000000000022";
const PROJECT = `project-of-${ORB}`;
const seedCount = Number(process.env["LIFECYCLE_CAMPAIGN_SEEDS"] ?? 64);
const firstSeed = Number(process.env["LIFECYCLE_CAMPAIGN_FIRST_SEED"] ?? 0);
const commandsPerSeed = Number(process.env["LIFECYCLE_CAMPAIGN_COMMANDS"] ?? 96);

function present<T>(value: T | null | undefined): T {
  expect(value).not.toBeNull();
  expect(value).not.toBeUndefined();
  if (value === null || value === undefined) throw new Error("required campaign fixture");
  return value;
}

const commands = [
  "human",
  "peer",
  "retry",
  "sleep",
  "stop",
  "start",
  "environment",
  "cleanup",
] as const;
type Command = (typeof commands)[number];

describe("stateful lifecycle campaign", () => {
  for (const placement of ["guest", "central"] as const) {
    for (let seed = firstSeed; seed < firstSeed + seedCount; seed++) {
      it(`${placement} seed ${seed}`, async ({ signal }) => {
        const logs = new LogCapture();
        await runDst(
          {
            name: `lifecycle-campaign-${placement}-seed-${seed}`,
            seed,
            iterations: 1,
            signal,
            logCapture: logs,
            failpointProbabilities: {
              [FAILPOINTS.storeRead]: 0.02,
              [FAILPOINTS.storeWrite]: 0.02,
              [FAILPOINTS.providerObserve]: 0.02,
              [FAILPOINTS.providerStart]: 0.02,
              [FAILPOINTS.providerStop]: 0.02,
              [FAILPOINTS.providerDestroy]: 0.02,
              [FAILPOINTS.runtimeHealth]: 0.02,
              [FAILPOINTS.runtimePull]: 0.02,
              [FAILPOINTS.runtimeDeliverMessage]: 0.02,
            },
            maxSchedulingSteps: 100_000,
            maxVirtualDurationMs: 3_600_000,
          },
          async (sim) => {
            const h = makeHarness({ constants: { idleStopAfterMs: 3_600_000 } });
            // Central model work has its own lifetime, independent of compute stop/start.
            const central = makeHarness();
            const inventory = h.store.listOrbsInStates.bind(h.store);
            h.store.listOrbsInStates = (task, states) =>
              inventory(task, states).map((rows) => rows.filter((row) => row.id === ORB));
            let deps: ControlPlaneDeps = h.deps;
            let ready = false;
            let driving = true;
            let workers = 2;
            let centralBusy = false;
            let centralPrepared = false;
            let activeSleep: string | null = null;
            let lastPeer: { messageId: string; message: string } | undefined;
            let latestStop = false;
            let cleanup: "archive" | "delete" | undefined;
            const sleeps = new Map<string, number>();
            const submitted = new Map<string, DeliverMessageClientRequest>();
            const accepted = new Map<
              string,
              {
                content: OrbMessageRow["content"];
                system: OrbMessageRow["system"];
                order: number;
                revoked?: string | undefined;
              }
            >();
            let acceptanceOrder = 0;
            let callers = 2;
            function accept(
              _task: SimulationTask,
              row: Pick<OrbMessageRow, "messageId" | "content" | "system">,
            ) {
              if (accepted.has(row.messageId)) return;
              accepted.set(row.messageId, {
                content: row.content,
                system: row.system,
                order: acceptanceOrder++,
              });
            }
            function authority(_task: SimulationTask, reason: string, revoke: boolean) {
              latestStop = reason === "stop";
              activeSleep = null;
              for (const entry of accepted.values()) entry.revoked = revoke ? reason : undefined;
            }
            // Observe committed boundary results, independently of command response order.
            const enqueue = h.store.enqueueOrbMessage.bind(h.store);
            h.store.enqueueOrbMessage = (task, params) =>
              enqueue(task, params).map((value) => {
                if (params.orbId === ORB && !value.duplicate) {
                  authority(task, "input", false);
                  expect(value.message.messageId).toBe(params.messageId);
                  expect(value.message.content).toEqual(params.content);
                  expect(value.message.system).toEqual(
                    params.sender ? { kind: "orb_message", senderOrbId: PEER } : null,
                  );
                  accept(task, {
                    messageId: params.messageId,
                    content: params.content,
                    system: params.sender ? { kind: "orb_message", senderOrbId: PEER } : null,
                  });
                }
                return value;
              });
            const schedule = h.store.scheduleOrbSleep.bind(h.store);
            h.store.scheduleOrbSleep = (task, params) =>
              schedule(task, params).map((row) => {
                activeSleep = params.sleepId;
                const deadline = task.wallNow() + params.durationSeconds * 1_000;
                expect(row.sleepUntil).toBe(deadline);
                sleeps.set(params.sleepId, deadline);
                return row;
              });
            const due = h.store.processDueOrbSleep.bind(h.store);
            h.store.processDueOrbSleep = (task, params) =>
              due(task, params).map((value) => {
                if (value === "wake" || value === "expired") {
                  const sleepId = present(activeSleep);
                  expect(params.sleepId).toBe(sleepId);
                  const sleepUntil = new Date(present(sleeps.get(sleepId))).toISOString();
                  activeSleep = null;
                  accept(task, {
                    messageId: sleepId,
                    content: [
                      {
                        type: "text",
                        text:
                          value === "wake"
                            ? "Scheduled sleep finished."
                            : "Scheduled sleep expired before compute stopped.",
                      },
                    ],
                    system: { kind: value === "wake" ? "sleep_wake" : "sleep_expired", sleepUntil },
                  });
                }
                return value;
              });
            const stop = h.store.requestOrbStop.bind(h.store);
            h.store.requestOrbStop = (task, params) =>
              stop(task, params).map((value) => {
                authority(task, "stop", true);
                return value;
              });
            const cancelSleep = h.store.cancelOrbSleep.bind(h.store);
            h.store.cancelOrbSleep = (task, params) =>
              cancelSleep(task, params).map((row) => {
                activeSleep = null;
                return row;
              });
            const transition = h.store.casTransition.bind(h.store);
            h.store.casTransition = (task, params) =>
              transition(task, params).map((row) => {
                if (params.orbId === ORB && params.cancelSleep && params.toState === "starting")
                  authority(task, "start", false);
                return row;
              });
            const archive = h.store.requestOrbArchive.bind(h.store);
            h.store.requestOrbArchive = (task, params) =>
              archive(task, params).map((row) => {
                cleanup = "archive";
                authority(task, "archive", true);
                return row;
              });
            const deletion = h.store.requestOrbDeletion.bind(h.store);
            h.store.requestOrbDeletion = (task, params) =>
              deletion(task, params).map((row) => {
                cleanup = "delete";
                authority(task, "delete", true);
                return row;
              });
            let ordinal = 0;
            function clock(raw: SimulationTask): SimulationTask {
              return new Proxy(raw, {
                get(target, key) {
                  if (key === "failpoint" && !driving)
                    return (...parts: readonly unknown[]) =>
                      target.checkpoint("healthy boundary", ...parts);
                  const value = Reflect.get(target, key) as unknown;
                  return typeof value === "function" ? value.bind(target) : value;
                },
              });
            }
            const recordIds = (record: HistoryRecord) =>
              record.type === "message" || record.type === "event"
                ? (record.inboxMessageIds ?? [])
                : [];
            const world = placement === "guest" ? h.world : central.world;
            const sessionRecords = () => (world.filesystemExists(ORB) ? world.entriesOf(ORB) : []);
            const url = () => `http://${present(central.store.orbSnapshot(ORB)).hostRef}:8080`;
            const unavailable = (message: string) =>
              errAsync({
                type: "runtime_client_error" as const,
                code: "unreachable" as const,
                message,
                retryable: true,
                answered: false,
              });

            function inspectRequest(request: DeliverMessageClientRequest) {
              const rows = h.store.messageSnapshots(ORB);
              const batch = request.messageIds.map((id) =>
                present(rows.find((row) => row.messageId === id)),
              );
              expect(batch.length).toBeGreaterThan(0);
              expect(request.system ?? null).toEqual(batch[0]?.system);
              for (const row of batch) {
                const entry = present(accepted.get(row.messageId));
                expect(row.content).toEqual(entry.content);
                expect(row.system).toEqual(entry.system);
              }
              expect(request.content).toEqual([
                {
                  type: "text",
                  text: batch
                    .map((row) =>
                      row.content
                        .map((block) => (block.type === "text" ? block.text : ""))
                        .join("\n"),
                    )
                    .join("\n\n"),
                },
              ]);
              if (request.system) expect(batch).toHaveLength(1);
              else expect(batch.every((row) => row.system === null)).toBe(true);
              expect(batch.map((row) => row.ordinal)).toEqual(
                batch.map((row) => row.ordinal).sort((a, b) => a - b),
              );
              for (const id of request.messageIds) {
                const previous = submitted.get(id);
                if (previous)
                  expect({ ...request, baseUrl: "" }).toEqual({ ...previous, baseUrl: "" });
                submitted.set(id, request);
              }
            }
            const guestDeliver = h.deps.runtimeClient.deliverMessage.bind(h.deps.runtimeClient);
            h.deps.runtimeClient.deliverMessage = (task, request, context) => {
              inspectRequest(request);
              return guestDeliver(task, request, context);
            };

            const plane: AgentPlane = {
              placement: "central",
              health: (task, _orb, context) => {
                central.world.setActivity(ORB, centralBusy ? "busy" : "idle");
                return central.deps.runtimeClient.health(task, url(), context);
              },
              deliverMessage: (task, orb, request, context) => {
                inspectRequest(request);
                return central.deps.runtimeClient.deliverMessage(
                  task,
                  { ...request, baseUrl: url() },
                  context,
                );
              },
              deliverMessages: (task, orb, requests, context) =>
                new ResultAsync(
                  (async () => {
                    const responses = [];
                    for (const request of requests) {
                      const response = await plane.deliverMessage(task, orb, request, context);
                      responses.push(response);
                      if (response.isErr() && response.error.retryable) {
                        responses.push(
                          ...requests.slice(responses.length).map(() =>
                            err({
                              type: "runtime_client_error" as const,
                              code: "unreachable" as const,
                              answered: false,
                              retryable: true,
                              message: "Earlier partition not admitted",
                            }),
                          ),
                        );
                        break;
                      }
                    }
                    return ok(responses);
                  })(),
                ),
              prepareIdleStop: (_task, _orb, _context) => {
                central.world.setActivity(ORB, centralBusy ? "busy" : "idle");
                if (centralBusy) return okAsync({ v: 1 as const, prepared: false });
                centralPrepared = true;
                return okAsync({ v: 1 as const, prepared: true });
              },
              pullHistory: (task, _orb, request, context) =>
                central.deps.runtimeClient.pullHistory(
                  task,
                  { ...request, baseUrl: url() },
                  context,
                ),
              suspend: (_task, _id, _context, _through) => {
                centralBusy = false;
                centralPrepared = true;
                return okAsync(undefined);
              },
              dispose: () => {
                centralBusy = false;
                centralPrepared = true;
                return okAsync(undefined);
              },
              session: () => ({
                runtimeInstanceId: "central-campaign",
                workActive: () => centralBusy && !centralPrepared,
                snapshot: () => err({ message: "use history port" }),
                liveView: () => null,
                subscribe: () => () => undefined,
                request: () => unavailable("not used"),
              }),
              close: () => okAsync(undefined),
            };
            if (placement === "central") deps = { ...deps, agentPlane: plane };

            function safety() {
              const orb = h.store.orbSnapshot(ORB);
              const rows = h.store.messageSnapshots(ORB);
              expect(new Set(rows.map((row) => row.messageId)).size).toBe(rows.length);
              for (const row of rows) {
                expect(row.orbId).toBe(ORB);
                if (row.system?.kind === "orb_message") expect(row.system.senderOrbId).toBe(PEER);
                if (row.system && row.system.kind !== "orb_message") {
                  const deadline = present(sleeps.get(row.messageId));
                  expect(
                    row.createdAt,
                    "notice never precedes accepted deadline",
                  ).toBeGreaterThanOrEqual(deadline);
                  expect(row.system.sleepUntil).toBe(new Date(deadline).toISOString());
                }
              }
              for (const record of sessionRecords()) {
                const ids = recordIds(record);
                if (ids.length === 0) continue;
                const request = present(submitted.get(present(ids[0])));
                expect(ids, "durable batch membership").toEqual(request.messageIds);
                if (record.type === "message") expect(record.content).toEqual(request.content);
              }
              const ids = sessionRecords().flatMap(recordIds);
              expect(new Set(ids).size, "one durable session record per inbox identity").toBe(
                ids.length,
              );
              let previous = -1;
              for (const id of ids) {
                const entry = present(accepted.get(id));
                expect(
                  entry.order,
                  "durable receipts follow independent acceptance order",
                ).toBeGreaterThan(previous);
                previous = entry.order;
                // Deleted rows may already be gone; the captured request remains evidence.
                const row = rows.find((row) => row.messageId === id);
                if (row) {
                  expect(row.content).toEqual(entry.content);
                } else expect(submitted.has(id)).toBe(true);
              }
              if (!orb) return;
              expect(
                orb.sleepId,
                "accepted Sleep survives until explicit cancellation or due processing",
              ).toBe(activeSleep);
              expect(orb.sleepId === null).toBe(orb.sleepUntil === null);
              if (world.filesystemExists(ORB)) assertReplicaIntegrity(world, h.store, ORB);
            }

            async function run(task: SimulationTask, command: Command, id: string, actor: number) {
              const orb = h.store.orbSnapshot(ORB);
              task.log(
                `lifecycle: campaign command=${command} id=${id} actor=${actor} state=${orb?.state}`,
              );
              switch (command) {
                case "human":
                  return enqueueOrbMessage(task, deps, {
                    orbId: ORB,
                    messageId: id,
                    content: [{ type: "text", text: id }],
                  });
                case "peer":
                case "retry": {
                  const source = present(h.store.orbSnapshot(PEER));
                  const request =
                    command === "retry" && lastPeer ? lastPeer : { messageId: id, message: id };
                  const result = await sendOrbMessage(
                    task,
                    deps,
                    {
                      orbId: PEER,
                      projectId: PROJECT,
                      ownerUserId: TEST_USER_ID,
                      caller: {
                        runtimeTokenHash: present(source.runtimeTokenHash),
                        hostIncarnation: source.hostIncarnation,
                      },
                    },
                    { ...request, orbId: ORB },
                  );
                  if (result.isOk()) lastPeer = request;
                  return result;
                }
                case "sleep": {
                  if (!orb || (placement === "guest" && !orb.runtimeTokenHash)) return;
                  const caller =
                    placement === "central"
                      ? {
                          kind: "central" as const,
                          orbId: ORB,
                          projectId: PROJECT,
                          ownerUserId: TEST_USER_ID,
                          agentAdmissionVersion: orb.agentAdmissionVersion,
                        }
                      : {
                          runtimeTokenHash: present(orb.runtimeTokenHash),
                          hostIncarnation: orb.hostIncarnation,
                        };
                  const duration = present(
                    [1, 2, 5, 30, 120][Math.floor(task.random("sleep duration") * 5)],
                  );
                  return requestOrbSleep(task, deps, ORB, caller, duration, id);
                }
                case "stop":
                  return requestOrbStop(task, deps, ORB);
                case "start":
                  return requestOrbStart(task, deps, ORB);
                case "cleanup":
                  if (task.random("cleanup admission") < 0.06)
                    return (
                      task.random("cleanup kind") < 0.5 ? requestOrbArchive : requestOrbDeletion
                    )(task, deps, ORB);
                  return;
                case "environment": {
                  centralBusy = task.random("activity") < 0.5;
                  centralPrepared = false;
                  if (h.world.filesystemExists(ORB)) {
                    h.world.setActivity(ORB, centralBusy ? "busy" : "idle");
                    if (
                      h.world.hostStateOf(ORB) === "running" &&
                      task.random("host interruption") < 0.2
                    )
                      h.world.preemptHost(task, ORB, 1_000);
                  }
                  if (world.filesystemExists(ORB) && !centralBusy)
                    world.flushPendingInboxBatches(ORB);
                  return task.sleep(
                    present([1, 500, 5_000, 30_000][Math.floor(task.random("time advance") * 4)]),
                    "environment advance",
                  );
                }
              }
            }

            const result = await sim.runTasks([
              ...(["compute", "history"] as const).map((role) => ({
                name: `${role} worker`,
                f: async (raw: SimulationTask) => {
                  const task = clock(raw);
                  await waitUntil(task, "campaign seeded", () => ready, { intervalMs: 1 });
                  while (driving) {
                    const current = deps;
                    await (role === "compute" ? reconcileAllOnce : pollAllOnce)(task, current);
                    await task.sleep(100 + task.random(`${role} tick`) * 400, `${role} tick`);
                  }
                  workers--;
                },
              })),
              ...[0, 1].map((actor) => ({
                name: `caller ${actor}`,
                f: async (raw: SimulationTask) => {
                  const task = clock(raw);
                  await waitUntil(task, "campaign seeded", () => ready, { intervalMs: 1 });
                  for (let step = actor; step < commandsPerSeed; step += 2) {
                    const command = present(
                      commands[Math.floor(task.random("next command") * commands.length)],
                    );
                    const id = `campaign-${seed}-${ordinal++}`;
                    const result = await run(task, command, id, actor);
                    const error = result?.isErr() ? result.error : null;
                    task.log(
                      `lifecycle: campaign result=${result ? result.isOk() : "environment"} id=${id} command=${command} actor=${actor} error_type=${error && "type" in error ? error.type : error ? "code_only" : "none"} code=${error && "code" in error ? error.code : "none"}`,
                    );
                    safety();
                    await task.sleep(task.random("command spacing") * 500, "command spacing");
                  }
                  callers--;
                },
              })),
              {
                name: "commands and oracle",
                f: async (raw) => {
                  const task = clock(raw);
                  seedRunningOrb(task, h, PEER);
                  seedRunningOrb(task, central, ORB);
                  if (task.random("initial lifecycle") < 0.5) {
                    seedRunningOrb(task, h, ORB, { bootLatencyMs: 50, initDurationMs: 0 });
                  } else {
                    h.store.seedProject(makeProjectRow(PROJECT));
                    h.world.configureOrb(ORB, { bootLatencyMs: 50, initDurationMs: 0 });
                    const initialization = new Proxy(task, {
                      get(target, key) {
                        if (key === "failpoint")
                          return (...parts: readonly unknown[]) =>
                            target.checkpoint("initialization", ...parts);
                        const value = Reflect.get(target, key) as unknown;
                        return typeof value === "function" ? value.bind(target) : value;
                      },
                    });
                    expect(
                      (
                        await createOrb(initialization, deps, { orbId: ORB, projectId: PROJECT })
                      ).isOk(),
                    ).toBe(true);
                  }
                  h.store.seedOrb({ ...present(h.store.orbSnapshot(PEER)), projectId: PROJECT });
                  ready = true;
                  await waitUntil(task, "caller actors joined", () => callers === 0, {
                    intervalMs: 100,
                  });
                  driving = false;
                  await waitUntil(task, "all pre-quiescence actors finished", () => workers === 0, {
                    intervalMs: 100,
                  });
                  if (world.filesystemExists(ORB)) {
                    world.setRuntimeUnreachable(task, ORB, 0);
                    world.setPullOutage(task, ORB, 0);
                    world.scriptDeliverMessage(ORB, { kind: "ok" });
                  }
                  if (world.filesystemExists(ORB)) world.flushPendingInboxBatches(ORB);
                  centralBusy = false;
                  if (h.world.filesystemExists(ORB)) h.world.setActivity(ORB, "idle");
                  // Budget covers remaining wall deadlines plus boot/setup, drain, backstop and FIFO pages.
                  const c = deps.constants;
                  const remainingSleep = Math.max(
                    0,
                    (h.store.orbSnapshot(ORB)?.sleepUntil ?? task.wallNow()) - task.wallNow(),
                  );
                  const budget =
                    remainingSleep +
                    c.setupHookHoldMs +
                    c.createStartDeadlineMs +
                    c.postRestartGraceMs +
                    c.unreachableBootDeadlineMs +
                    c.deletionQuarantineMs +
                    c.hostBackstopIntervalMs +
                    (accepted.size + 2) *
                      (c.runtimeRequestTimeoutMs +
                        c.providerOperationTimeoutMs +
                        c.retryBackoffCapMs +
                        c.historyPullIntervalMs);
                  const deadline = task.monotonicNow() + budget;
                  let settled = false;
                  while (task.monotonicNow() <= deadline) {
                    if (world.filesystemExists(ORB)) world.flushPendingInboxBatches(ORB);
                    centralBusy = false;
                    if (h.world.filesystemExists(ORB)) h.world.setActivity(ORB, "idle");
                    await reconcileAllOnce(task, deps);
                    await pollAllOnce(task, deps);
                    safety();
                    const orb = h.store.orbSnapshot(ORB);
                    const receipts = new Set(sessionRecords().flatMap(recordIds));
                    const owed = [...accepted].filter(
                      ([id, entry]) =>
                        !entry.revoked &&
                        (!receipts.has(id) ||
                          h.store.messageSnapshots(ORB).find((row) => row.messageId === id)
                            ?.status !== "delivered"),
                    );
                    const complete =
                      !orb ||
                      !world.filesystemExists(ORB) ||
                      (placement === "guest" && latestStop && orb.state === "stopped") ||
                      h.store.replicaRecords(ORB).length === sessionRecords().length;
                    const terminal =
                      cleanup === "delete"
                        ? !orb
                        : cleanup === "archive"
                          ? orb?.state === "archived"
                          : orb?.sleepId === null &&
                            (latestStop
                              ? orb.state === "stopped"
                              : ["running", "stopped"].includes(orb.state)) &&
                            !centralBusy &&
                            !deps.control.hasAgentWork(ORB);
                    if (terminal && complete && owed.length === 0) {
                      settled = true;
                      break;
                    }
                    await task.sleep(c.reconcileTickMs, "fair quiescence tick");
                  }
                  const final = h.store.orbSnapshot(ORB);
                  const receipts = new Set(sessionRecords().flatMap(recordIds));
                  expect(settled, `unsettled lifecycle: ${JSON.stringify(final)}`).toBe(true);
                  for (const [id, entry] of accepted) {
                    if (!entry.revoked) {
                      expect(receipts.has(id), `durable receipt required: ${id}`).toBe(true);
                      expect(
                        h.store.messageSnapshots(ORB).find((row) => row.messageId === id)?.status,
                        `replicated receipt required: ${id}`,
                      ).toBe("delivered");
                    }
                  }
                  if (
                    final &&
                    world.filesystemExists(ORB) &&
                    (placement === "central" ||
                      final.state === "running" ||
                      final.state === "archived")
                  )
                    assertReplicaComplete(world, h.store, ORB);
                  safety();
                },
              },
            ]);
            expect(result.isOk(), result.isErr() ? result.error.stack : "").toBe(true);
            const resultLines = logs.matching("campaign result=");
            expect(resultLines).toHaveLength(commandsPerSeed);
            for (const line of resultLines) {
              expect(line).toMatch(
                /result=(true|false|environment) id=campaign-\d+-\d+ command=\w+ actor=[01] error_type=\w+ code=\w+/,
              );
              const id = / id=(\S+)/.exec(line)?.[1];
              const command = / command=(\S+)/.exec(line)?.[1];
              const actor = / actor=(\S+)/.exec(line)?.[1];
              expect(
                logs.matching(`campaign command=${command} id=${id} actor=${actor} `),
              ).toHaveLength(1);
            }
          },
        );
      });
    }
  }
});
