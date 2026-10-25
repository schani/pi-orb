import type { HistoryRecord } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, errAsync, ok, okAsync, ResultAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { FAILPOINTS } from "../testkit/failpoints.ts";
import { makeHarness, makeProjectRow, seedRunningOrb, TEST_USER_ID } from "../testkit/fixtures.ts";
import { assertReplicaComplete, assertReplicaIntegrity } from "../testkit/invariants.ts";
import { LogCapture, runDst, waitUntil } from "../testkit/sim.ts";
import { STORE_OPERATIONS, type StoreOperation } from "../testkit/store.ts";
import type { HealthOverride } from "../testkit/world.ts";
import type { AgentPlane } from "./agent-ports.ts";
import { ControlState } from "./control-state.ts";
import type { StoreError } from "./errors.ts";
import {
  createOrb,
  enqueueOrbMessage,
  requestOrbArchive,
  requestOrbDeletion,
  requestOrbSleep,
  requestOrbStart,
  requestOrbStop,
} from "./lifecycle.ts";
import { orphanSweepOnce, pollAllOnce, reconcileAllOnce } from "./loops.ts";
import type { OrbMessageRow, OrbRow } from "./orb.ts";
import { sendOrbMessage } from "./orb-messaging.ts";
import type { ControlPlaneDeps, DeliverMessageClientRequest } from "./ports.ts";

const ORB = "00000000-0000-4000-8000-000000000021";
const PEER = "00000000-0000-4000-8000-000000000022";
const PROJECT = `project-of-${ORB}`;
const seedCount = Number(process.env["LIFECYCLE_CAMPAIGN_SEEDS"] ?? 256);
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
  "storeFault",
  "health",
  "transport",
  "controller",
  "advance",
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
            const faultOperations = Object.keys(STORE_OPERATIONS) as StoreOperation[];
            const passes = new Map<
              SimulationTask,
              {
                terminal?: {
                  version: number;
                  incarnation: number;
                  instance: string;
                  observedAt: number;
                };
                blocked: boolean;
                row?: OrbRow;
              }
            >();
            const getOrb = h.store.getOrb.bind(h.store);
            h.store.getOrb = (task, id) =>
              getOrb(task, id).map((row) => {
                const pass = passes.get(task);
                if (pass && id === ORB && row && !pass.row) pass.row = row;
                return row;
              });
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
                failureVersion?: number | undefined;
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
                failureVersion:
                  h.store.orbSnapshot(ORB)?.state === "failed"
                    ? h.store.orbSnapshot(ORB)?.stateVersion
                    : undefined,
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
            // Evidence comes from port results, never lifecycle verdicts or error strings.
            type Evidence = {
              answeredAt: number;
              silentHealthAt: number;
              terminal: boolean;
              providerFailed: boolean;
              unansweredSince: number | null;
              healthPass: SimulationTask | null;
            };
            const evidence = new Map<string, Evidence>();
            const restarts = new Map<string, number>();
            const episode = (row: OrbRow) => `${row.hostIncarnation}:${row.stateChangedAt}`;
            const instances = new Map<string, string>();
            const key = (row: OrbRow) =>
              `${episode(row)}:${row.hostRef}:${h.world.runtimeInstanceIdOf(ORB) ?? instances.get(episode(row))}`;
            function observed(row: OrbRow): Evidence {
              const id = key(row);
              let value = evidence.get(id);
              if (!value) {
                value = {
                  answeredAt: -Infinity,
                  silentHealthAt: -Infinity,
                  terminal: false,
                  providerFailed: false,
                  unansweredSince: null,
                  healthPass: null,
                };
                evidence.set(id, value);
              }
              return value;
            }
            const observe = h.deps.hostProvider.observe.bind(h.deps.hostProvider);
            h.deps.hostProvider.observe = (task, ref, context) => {
              const before = h.store.orbSnapshot(ORB);
              return observe(task, ref, context).map((value) => {
                if (before?.hostRef === ref.resourceId)
                  observed(before).providerFailed =
                    value === null || ["stopped", "failed"].includes(value.state);
                return value;
              });
            };
            const startHost = h.deps.hostProvider.start.bind(h.deps.hostProvider);
            h.deps.hostProvider.start = (task, request, context) => {
              const before = h.store.orbSnapshot(ORB);
              const facts = before ? observed(before) : null;
              const corroborated =
                facts?.unansweredSince !== null &&
                facts?.unansweredSince !== undefined &&
                facts.silentHealthAt - facts.unansweredSince > deps.constants.unreachableGraceMs &&
                facts.silentHealthAt > facts.answeredAt;
              return startHost(task, request, context).map((value) => {
                if (before?.state === "stopping" && facts && corroborated)
                  restarts.set(episode(before), task.monotonicNow());
                return value;
              });
            };
            const fail = h.store.failOrbAndRequestComputeDiscard.bind(h.store);
            h.store.failOrbAndRequestComputeDiscard = (task, params) => {
              const before = h.store.orbSnapshot(params.orbId);
              return fail(task, params)
                .map((row) => {
                  if (row.id === ORB && before?.stateVersion === params.expectedStateVersion) {
                    const facts = observed(before);
                    const restartedAt = restarts.get(episode(before));
                    const silent =
                      restartedAt !== undefined &&
                      facts.silentHealthAt - restartedAt > deps.constants.postRestartGraceMs &&
                      facts.answeredAt < restartedAt &&
                      facts.healthPass === task;
                    if (["running", "stopping"].includes(before.state))
                      expect(
                        facts.terminal || facts.providerFailed || silent,
                        `compute failure requires current execution/provider evidence: ${JSON.stringify({ ...facts, healthPass: undefined })}`,
                      ).toBe(true);
                    if (placement === "central") {
                      expect(row.agentAdmissionVersion).toBe(before.agentAdmissionVersion);
                      expect(row.harnessSessionId).toBe(before.harnessSessionId);
                    }
                    expect(row.runtimeTokenHash).toBeNull();
                    expect(row.hostDiscardThroughIncarnation).toBe(before.hostIncarnation);
                  }
                  return row;
                })
                .mapErr((error) => {
                  const pass = passes.get(task);
                  if (
                    error.type === "store_error" &&
                    pass?.terminal &&
                    before &&
                    before.stateVersion === pass.terminal.version &&
                    before.hostIncarnation === pass.terminal.incarnation &&
                    task.monotonicNow() >= pass.terminal.observedAt
                  )
                    pass.blocked = true;
                  return error;
                });
            };
            const discard = h.deps.hostProvider.discardCompute.bind(h.deps.hostProvider);
            h.deps.hostProvider.discardCompute = (task, request, context) => {
              if (request.orbId === ORB) {
                const row = h.store.orbSnapshot(ORB);
                expect(
                  row !== null &&
                    ((row.hostDiscardThroughIncarnation ?? -1) >= request.throughIncarnation ||
                      row.hostIncarnation > request.throughIncarnation),
                  "compute discard requires a current committed incarnation fence",
                ).toBe(true);
              }
              return discard(task, request, context);
            };
            const health = h.deps.runtimeClient.health.bind(h.deps.runtimeClient);
            h.deps.runtimeClient.health = (task, baseUrl, context) => {
              const before = passes.get(task)?.row ?? h.store.orbSnapshot(ORB);
              const instance = h.world.runtimeInstanceIdOf(ORB);
              return health(task, baseUrl, context)
                .map((value) => {
                  if (
                    before &&
                    value.orbId === ORB &&
                    value.runtimeInstanceId === instance &&
                    baseUrl === `http://${before.hostRef}:8080`
                  ) {
                    instances.set(episode(before), value.runtimeInstanceId);
                    const facts = observed(before);
                    facts.answeredAt = task.monotonicNow();
                    facts.unansweredSince = null;
                    facts.terminal = value.status === "failed";
                    const pass = passes.get(task);
                    if (pass && before.state === "running" && value.status === "failed")
                      pass.terminal = {
                        version: before.stateVersion,
                        incarnation: before.hostIncarnation,
                        instance: value.runtimeInstanceId,
                        observedAt: task.monotonicNow(),
                      };
                  }
                  return value;
                })
                .mapErr((error) => {
                  if (before && instance === h.world.runtimeInstanceIdOf(ORB)) {
                    const facts = observed(before);
                    if (error.answered) {
                      facts.answeredAt = task.monotonicNow();
                      facts.unansweredSince = null;
                    } else {
                      facts.healthPass = task;
                      facts.silentHealthAt = task.monotonicNow();
                      facts.unansweredSince ??= task.monotonicNow();
                    }
                  }
                  return error;
                });
            };
            const pull = h.deps.runtimeClient.pullHistory.bind(h.deps.runtimeClient);
            h.deps.runtimeClient.pullHistory = (task, request, context) => {
              const before = h.store.orbSnapshot(ORB);
              const instance = h.world.runtimeInstanceIdOf(ORB);
              return pull(task, request, context)
                .map((value) => {
                  if (
                    before &&
                    value.orbId === ORB &&
                    instance === h.world.runtimeInstanceIdOf(ORB)
                  ) {
                    observed(before).answeredAt = task.monotonicNow();
                    observed(before).unansweredSince = null;
                  }
                  return value;
                })
                .mapErr((error) => {
                  if (before && instance === h.world.runtimeInstanceIdOf(ORB)) {
                    const facts = observed(before);
                    if (error.answered) {
                      facts.answeredAt = task.monotonicNow();
                      facts.unansweredSince = null;
                    } else facts.unansweredSince ??= task.monotonicNow();
                  }
                  return error;
                });
            };
            function answered(task: SimulationTask, row: OrbRow | null, instance: string | null) {
              if (row && instance === h.world.runtimeInstanceIdOf(ORB)) {
                observed(row).answeredAt = task.monotonicNow();
                observed(row).unansweredSince = null;
              }
            }
            const prepare = h.deps.runtimeClient.prepareIdleStop.bind(h.deps.runtimeClient);
            h.deps.runtimeClient.prepareIdleStop = (task, baseUrl, context) => {
              const row = h.store.orbSnapshot(ORB);
              const instance = h.world.runtimeInstanceIdOf(ORB);
              return prepare(task, baseUrl, context)
                .map((value) => {
                  answered(task, row, instance);
                  return value;
                })
                .mapErr((error) => {
                  if (error.answered) answered(task, row, instance);
                  return error;
                });
            };
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
              const row = h.store.orbSnapshot(ORB);
              const instance = h.world.runtimeInstanceIdOf(ORB);
              return guestDeliver(task, request, context)
                .map((value) => {
                  answered(task, row, instance);
                  return value;
                })
                .mapErr((error) => {
                  if (error.answered) answered(task, row, instance);
                  return error;
                });
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
                case "storeFault": {
                  const operation = present(
                    faultOperations[
                      Math.floor(task.random("store operation") * faultOperations.length)
                    ],
                  );
                  const choice = task.random("store result");
                  const fault: StoreError | null =
                    choice < 0.3
                      ? null
                      : {
                          type: "store_error",
                          code: choice < 0.65 ? "invariant" : "unavailable",
                          retryable: choice >= 0.65,
                          message: `campaign store fault: ${operation}`,
                        };
                  task.log(
                    `lifecycle: campaign store operation=${operation} result=${fault?.code ?? "ok"}`,
                  );
                  h.store.setOperationFault(operation, fault);
                  return;
                }
                case "health": {
                  if (!h.world.filesystemExists(ORB)) return;
                  const choice = task.random("guest health");
                  const value: HealthOverride | null =
                    choice < 0.4
                      ? null
                      : choice < 0.6
                        ? { status: "initializing" as const, phase: "loading_session" as const }
                        : choice < 0.85
                          ? {
                              status: "failed" as const,
                              error: {
                                code: "execution_failed",
                                message: "campaign execution failure",
                                retryable: task.random("health retryability") < 0.5,
                              },
                            }
                          : {
                              type: "runtime_client_error",
                              code: choice < 0.925 ? "http_error" : "invalid_response",
                              message: "campaign health response",
                              answered: true,
                              retryable: true,
                            };
                  task.log(
                    `lifecycle: campaign guest result=${value === null ? "ready" : "status" in value ? value.status : value.code}`,
                  );
                  h.world.setHealth(ORB, value);
                  return;
                }
                case "transport":
                  if (h.world.filesystemExists(ORB))
                    h.world.setRuntimeUnreachable(
                      task,
                      ORB,
                      task.random("guest reachability") < 0.5 ? 0 : 5_000,
                    );
                  return;
                case "controller":
                  deps = { ...deps, control: new ControlState() };
                  return reconcileAllOnce(task, deps);
                case "advance":
                  return task.sleep(
                    present([1_000, 30_000, 350_000][Math.floor(task.random("elapsed time") * 3)]),
                    "elapsed time",
                  );
                case "environment": {
                  centralBusy = task.random("activity") < 0.5;
                  centralPrepared = false;
                  if (h.world.filesystemExists(ORB)) {
                    h.world.setActivity(ORB, task.random("guest activity") < 0.5 ? "busy" : "idle");
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
                    const pass: {
                      terminal?: {
                        version: number;
                        incarnation: number;
                        instance: string;
                        observedAt: number;
                      };
                      blocked: boolean;
                    } = { blocked: false };
                    if (role === "compute") passes.set(task, pass);
                    await (role === "compute" ? reconcileAllOnce : pollAllOnce)(task, current);
                    if (pass.terminal && !pass.blocked) {
                      const row = h.store.orbSnapshot(ORB);
                      if (
                        row?.stateVersion === pass.terminal.version &&
                        row.hostIncarnation === pass.terminal.incarnation &&
                        h.world.runtimeInstanceIdOf(ORB) === pass.terminal.instance
                      )
                        expect(
                          row.state,
                          "validated terminal execution health must end its running episode",
                        ).not.toBe("running");
                    }
                    passes.delete(task);
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
                  h.store.clearOperationFaults();
                  deps = { ...deps, control: new ControlState() };
                  if (h.world.filesystemExists(ORB)) {
                    h.world.setHealth(ORB, null);
                    h.world.setRuntimeUnreachable(task, ORB, 0);
                  }
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
                  const recoveryStarts = new Set<number>();
                  while (task.monotonicNow() <= deadline) {
                    if (world.filesystemExists(ORB)) world.flushPendingInboxBatches(ORB);
                    centralBusy = false;
                    if (h.world.filesystemExists(ORB)) h.world.setActivity(ORB, "idle");
                    // Recovery demand is explicit; retained inputs still owe their receipts.
                    const failed = h.store.orbSnapshot(ORB);
                    if (
                      failed?.state === "failed" &&
                      !cleanup &&
                      !latestStop &&
                      failed.hostDiscardThroughIncarnation === null &&
                      [...accepted].some(
                        ([id, entry]) =>
                          !entry.revoked &&
                          (!sessionRecords().flatMap(recordIds).includes(id) ||
                            h.store.messageSnapshots(ORB).find((row) => row.messageId === id)
                              ?.status !== "delivered"),
                      ) &&
                      !recoveryStarts.has(failed.stateVersion)
                    ) {
                      const incarnation = failed.hostIncarnation;
                      await reconcileAllOnce(task, deps);
                      if (
                        ![...accepted.values()].some(
                          (entry) => !entry.revoked && entry.failureVersion === failed.stateVersion,
                        )
                      ) {
                        expect(
                          h.store.orbSnapshot(ORB)?.state,
                          "standing demand cannot clear a terminal latch",
                        ).toBe("failed");
                        expect(h.store.orbSnapshot(ORB)?.hostIncarnation).toBe(incarnation);
                        const started = await requestOrbStart(task, deps, ORB);
                        if (started.isOk()) recoveryStarts.add(failed.stateVersion);
                      }
                    }
                    await reconcileAllOnce(task, deps);
                    await orphanSweepOnce(task, deps);
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
                      (placement === "guest" &&
                        (orb.state === "failed" || (latestStop && orb.state === "stopped"))) ||
                      h.store.replicaRecords(ORB).length === sessionRecords().length;
                    const terminal =
                      cleanup === "delete"
                        ? !orb
                        : cleanup === "archive"
                          ? orb?.state === "archived"
                          : orb?.sleepId === null &&
                            (latestStop
                              ? ["stopped", "failed"].includes(orb.state)
                              : ["running", "stopped", "failed"].includes(orb.state)) &&
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
