import { mkdirSync, writeFileSync } from "node:fs";
import type { HistoryRecord } from "@pi-orb/protocol";
import { ApplicationFailure, type SimulationTask } from "determined";
import { err, errAsync, okAsync, type Result, type ResultAsync } from "neverthrow";
import { afterAll, describe, expect, it } from "vitest";
import { FAILPOINTS } from "../testkit/failpoints.ts";
import {
  makeHarness,
  makeProjectRow,
  restartControlPlane,
  seedRunningOrb,
  TEST_USER_ID,
} from "../testkit/fixtures.ts";
import {
  assertAtMostOneHost,
  assertReplicaComplete,
  assertReplicaIntegrity,
} from "../testkit/invariants.ts";
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
const FOREIGN = "00000000-0000-4000-8000-000000000023";
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
  "sleep",
  "sleep",
  "stop",
  "start",
  "tick",
  "poll",
  "advance",
  "wall",
  "busy",
  "idle",
  "restart",
  "crash",
  "delay",
  "retry",
  "stale",
  "foreign",
  "archive",
  "delete",
  "preempt",
  "unreachable",
  "pull-outage",
  "pause-compute",
  "pause-history",
  "stop-ack",
  "stop-rollback",
] as const;
type Command = (typeof commands)[number];

class CampaignLogs extends LogCapture {
  lateChoices = 0;
  override log(...parts: readonly unknown[]): void {
    if (typeof parts[0] === "string" && parts[0].startsWith("dst: non-earliest timer"))
      this.lateChoices++;
    super.log(...parts);
  }
  override reset(): void {
    super.reset();
    this.lateChoices = 0;
  }
}

describe("stateful lifecycle campaign", () => {
  const totals: Record<string, number> = {};
  let completed = 0;
  afterAll(() => {
    console.log("lifecycle-campaign coverage", JSON.stringify(totals));
    if (completed !== seedCount * 2 || seedCount < 64 || process.env["DST_REPLAY"]) return;
    for (const placement of ["guest", "central"]) {
      for (const key of [
        "accept:human",
        "accept:orb_message",
        "overlapping-caller",
        "crash",
        "preempt",
        "stop-ack-loss",
        "stop-rollback",
        "non-earliest-timer",
        "due:wake",
        "due:expired",
        "authority:archive",
        "authority:delete",
        "guest-accept:pending",
        "guest-accept:durable",
        "effect:hang",
        "effect:persist-without-ack",
        "delivery-crash",
        "effect:unreachable",
        "effect:pull-outage",
        "effect:failpoint",
      ]) {
        expect(
          totals[`${placement}:applied:${key}`] ?? 0,
          `applied coverage ${placement}:${key}`,
        ).toBeGreaterThan(0);
      }
    }
  });
  for (const placement of ["guest", "central"] as const) {
    for (let seed = firstSeed; seed < firstSeed + seedCount; seed++) {
      it(`${placement} seed ${seed}`, async ({ signal }) => {
        const logs = new CampaignLogs();
        await runDst(
          {
            name: `lifecycle-campaign-${placement}-seed-${seed}`,
            seed,
            iterations: 1,
            logCapture: logs,
            signal,
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
            let computePaused = false;
            let historyPaused = false;
            let workers = 2;
            let wallOffset = 0;
            let centralBusy = false;
            let centralPrepared = false;
            let activeSleep: string | null = null;
            let lastPeer: { messageId: string; message: string } | undefined;
            let latestStop = false;
            let cleanup: "archive" | "delete" | undefined;
            const sleeps = new Map<string, number>();
            const submitted = new Map<string, DeliverMessageClientRequest>();
            const coverage = new Set<string>();
            const counts: Record<string, number> = {};
            const count = (key: string, amount = 1) => {
              counts[key] = (counts[key] ?? 0) + amount;
            };
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
            let activeCalls = 0;
            let authorityOrder = 0;
            let unreachableUntil = 0;
            const dispatchReads = new Map<
              SimulationTask,
              {
                read: boolean;
                open: boolean;
                version: number | null;
                order: number;
                revoked: string[];
              }
            >();
            const deliveryModes = new Map<SimulationTask, string>();
            const getOrb = h.store.getOrb.bind(h.store);
            h.store.getOrb = (task, id) =>
              getOrb(task, id).map((row) => {
                const dispatch = dispatchReads.get(task);
                if (id === ORB && dispatch && !dispatch.read) {
                  Object.assign(dispatch, {
                    read: true,
                    open: !latestStop && !cleanup && activeSleep === null,
                    version: row?.agentAdmissionVersion ?? null,
                    order: authorityOrder,
                    revoked: [...accepted].filter(([, entry]) => entry.revoked).map(([id]) => id),
                  });
                  witness(task, "dispatch-authority-read", dispatch);
                }
                return row;
              });
            function witness(task: SimulationTask, edge: string, data: unknown) {
              task.log(`lifecycle: campaign witness=${edge} data=${JSON.stringify(data)}`);
            }
            function accept(task: SimulationTask, row: OrbMessageRow) {
              if (accepted.has(row.messageId)) return;
              accepted.set(row.messageId, {
                content: row.content,
                system: row.system,
                order: acceptanceOrder++,
              });
              count(`applied:accept:${row.system?.kind ?? "human"}`);
              witness(task, "accepted", {
                id: row.messageId,
                content: row.content,
                system: row.system,
                order: acceptanceOrder - 1,
              });
            }
            function authority(task: SimulationTask, reason: string, revoke: boolean) {
              authorityOrder++;
              latestStop = reason === "stop";
              activeSleep = null;
              for (const entry of accepted.values()) entry.revoked = revoke ? reason : undefined;
              count(`applied:authority:${reason}`);
              witness(task, "authority", {
                reason,
                revoke,
                order: authorityOrder,
                ids: [...accepted.keys()],
              });
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
                  accept(task, value.message);
                }
                return value;
              });
            const schedule = h.store.scheduleOrbSleep.bind(h.store);
            h.store.scheduleOrbSleep = (task, params) =>
              schedule(task, params).map((row) => {
                activeSleep = params.sleepId;
                expect(row.sleepUntil).toBe(task.wallNow() + params.durationSeconds * 1_000);
                sleeps.set(params.sleepId, present(row.sleepUntil));
                witness(task, "sleep-committed", {
                  id: params.sleepId,
                  deadline: row.sleepUntil,
                  caller: params.caller,
                });
                count(`applied:sleep:${row.state}`);
                return row;
              });
            const due = h.store.processDueOrbSleep.bind(h.store);
            h.store.processDueOrbSleep = (task, params) =>
              due(task, params).map((value) => {
                if (value === "wake" || value === "expired") {
                  expect(activeSleep).toBe(params.sleepId);
                  activeSleep = null;
                  const row = present(
                    h.store.messageSnapshots(ORB).find((row) => row.messageId === params.sleepId),
                  );
                  expect(row.content).toEqual([
                    {
                      type: "text",
                      text:
                        value === "wake"
                          ? "Scheduled sleep finished."
                          : "Scheduled sleep expired before compute stopped.",
                    },
                  ]);
                  expect(row.system).toEqual({
                    kind: value === "wake" ? "sleep_wake" : "sleep_expired",
                    sleepUntil: new Date(present(sleeps.get(params.sleepId))).toISOString(),
                  });
                  accept(task, row);
                  count(`applied:due:${value}`);
                }
                return value;
              });
            const stop = h.store.requestOrbStop.bind(h.store);
            h.store.requestOrbStop = (task, params) =>
              stop(task, params)
                .map((value) => {
                  authority(task, "stop", true);
                  return value;
                })
                .mapErr((error) => {
                  if (
                    error.type === "store_error" &&
                    error.message.includes("acknowledgement lost")
                  ) {
                    authority(task, "stop", true);
                    count("applied:stop-ack-loss");
                  }
                  if (
                    error.type === "store_error" &&
                    error.message.includes("scripted store failure")
                  )
                    count("applied:stop-rollback");
                  return error;
                });
            const cancelSleep = h.store.cancelOrbSleep.bind(h.store);
            h.store.cancelOrbSleep = (task, params) =>
              cancelSleep(task, params).map((row) => {
                activeSleep = null;
                witness(task, "sleep-cancelled-by-start", params);
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
            let lastVersion = 0;
            let lastAdmission = 0;
            let lastIncarnation = 0;

            function clock(raw: SimulationTask): SimulationTask {
              const proxy: SimulationTask = new Proxy(raw, {
                get(target, key) {
                  if (key === "wallNow") return () => target.wallNow() + wallOffset;
                  if (key === "checkpoint")
                    return (...parts: readonly unknown[]) => {
                      if (parts[0] === "central.dispatch-before-authority") {
                        dispatchReads.set(proxy, {
                          read: false,
                          open: false,
                          version: null,
                          order: authorityOrder,
                          revoked: [],
                        });
                        witness(target, "dispatch-begin", { order: authorityOrder });
                      }
                      return target.checkpoint(...parts);
                    };
                  if (key === "failpoint")
                    return async (...parts: readonly unknown[]) => {
                      if (parts[0] === FAILPOINTS.runtimeDeliverMessage) currentTask = target;
                      if (!driving) return target.checkpoint("healthy boundary", ...parts);
                      try {
                        await target.failpoint(...parts);
                        if (parts[0] === FAILPOINTS.runtimeDeliverMessage) {
                          currentTask = target;
                          const script = world.deliverMessageScriptOf(
                            placement === "guest"
                              ? `http://${h.world.hostRefOf(ORB)?.resourceId}:8080`
                              : url(),
                          );
                          deliveryModes.set(proxy, script?.kind ?? "unreachable");
                          count(`applied:delivery-boundary:${script?.kind ?? "unreachable"}`);
                          witness(target, "delivery-boundary", script);
                        }
                      } catch (error) {
                        if (error instanceof ApplicationFailure) {
                          count("applied:effect:failpoint");
                          count(`applied:failpoint:${String(parts[0])}`);
                        }
                        witness(target, "fault", parts);
                        throw error;
                      }
                    };
                  const value = Reflect.get(target, key) as unknown;
                  return typeof value === "function" ? value.bind(target) : value;
                },
              });
              return proxy;
            }
            const recordIds = (record: HistoryRecord) =>
              record.type === "message" || record.type === "event"
                ? (record.inboxMessageIds ?? [])
                : [];
            const world = placement === "guest" ? h.world : central.world;
            const sessionRecords = () => (world.filesystemExists(ORB) ? world.entriesOf(ORB) : []);
            const deliver = world.deliverInboxBatch.bind(world);
            world.deliverInboxBatch = (id, request, options) => {
              const result = deliver(id, request, options);
              if (!result.duplicate)
                count(`applied:guest-accept:${options?.flush === false ? "pending" : "durable"}`);
              else count("applied:duplicate-receipt");
              witness(currentTask, "guest-receipt", { request, result });
              return result;
            };
            let currentTask: SimulationTask;
            const runtimeCrash = world.crashRuntimeBeforeEnqueue.bind(world);
            world.crashRuntimeBeforeEnqueue = (task, id) => {
              const before = world.runtimeInstanceIdOf(id);
              runtimeCrash(task, id);
              if (world.runtimeInstanceIdOf(id) !== before) count("applied:delivery-crash");
            };
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
            const runtime =
              placement === "guest" ? h.deps.runtimeClient : central.deps.runtimeClient;
            const health = runtime.health.bind(runtime);
            runtime.health = (task, baseUrl, context) =>
              health(task, baseUrl, context).mapErr((error) => {
                if (error.message === "no runtime" && task.monotonicNow() < unreachableUntil) {
                  count("applied:effect:unreachable");
                  witness(task, "unreachable-response", error);
                }
                return error;
              });
            const pull = runtime.pullHistory.bind(runtime);
            runtime.pullHistory = (task, request, context) =>
              pull(task, request, context).mapErr((error) => {
                if (error.message === "scripted outage") {
                  count("applied:effect:pull-outage");
                  witness(task, "pull-outage-response", error);
                }
                return error;
              });
            const transportDeliver = runtime.deliverMessage.bind(runtime);
            runtime.deliverMessage = (task, request, context) => {
              deliveryModes.delete(task);
              return transportDeliver(task, request, context).mapErr((error) => {
                if (deliveryModes.get(task) === "hang" && error.code === "cancelled")
                  count("applied:effect:hang");
                if (error.message === "deliver message: answer lost") {
                  const persisted = request.messageIds.every((id) =>
                    sessionRecords().flatMap(recordIds).includes(id),
                  );
                  count(
                    persisted
                      ? "applied:effect:persist-without-ack"
                      : "applied:effect:pending-without-ack",
                  );
                }
                witness(task, "delivery-error", {
                  ids: request.messageIds,
                  mode: deliveryModes.get(task),
                  error,
                });
                return error;
              });
            };
            const guestDeliver = h.deps.runtimeClient.deliverMessage.bind(h.deps.runtimeClient);
            h.deps.runtimeClient.deliverMessage = (task, request, context) => {
              inspectRequest(request);
              return guestDeliver(task, request, context);
            };

            function inspectCentral(request: DeliverMessageClientRequest) {
              inspectRequest(request);
              return { ...request, baseUrl: url() };
            }
            const plane: AgentPlane = {
              placement: "central",
              health: (task, _orb, context) => {
                central.world.setActivity(ORB, centralBusy ? "busy" : "idle");
                return central.deps.runtimeClient.health(task, url(), context);
              },
              deliverMessage: (task, orb, request, context) => {
                // Observe orchestration's authority read; Native owns the subsequent acceptance fence.
                const dispatch = present(dispatchReads.get(task));
                expect(
                  dispatch.read && dispatch.open,
                  "dispatch must begin under open authority",
                ).toBe(true);
                expect(orb.agentAdmissionVersion, "dispatch carries its observed authority").toBe(
                  dispatch.version,
                );
                expect(
                  request.messageIds.some((id) => dispatch.revoked.includes(id)),
                  "no newly dispatched revoked input",
                ).toBe(false);
                witness(task, "dispatch-attempt", {
                  ...dispatch,
                  carried: orb.agentAdmissionVersion,
                  currentOrder: authorityOrder,
                  ids: request.messageIds,
                });
                if (authorityOrder !== dispatch.order)
                  count("applied:dispatch-spans-authority-change");
                dispatchReads.delete(task);
                return central.deps.runtimeClient.deliverMessage(
                  task,
                  inspectCentral(request),
                  context,
                );
              },
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

            let currentWall = 0;
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
              coverage.add(`state:${orb.state}`);
              if (orb.sleepId !== null && orb.sleepUntil !== null && orb.sleepUntil <= currentWall)
                coverage.add(`overdue:${orb.state}`);
              expect(
                orb.sleepId,
                "accepted Sleep survives until explicit cancellation or due processing",
              ).toBe(activeSleep);
              expect(orb.sleepId === null).toBe(orb.sleepUntil === null);
              expect(orb.stateVersion).toBeGreaterThanOrEqual(lastVersion);
              expect(orb.agentAdmissionVersion).toBeGreaterThanOrEqual(lastAdmission);
              expect(orb.hostIncarnation).toBeGreaterThanOrEqual(lastIncarnation);
              lastVersion = orb.stateVersion;
              lastAdmission = orb.agentAdmissionVersion;
              lastIncarnation = orb.hostIncarnation;
              assertAtMostOneHost(h.world, ORB);
              if (world.filesystemExists(ORB)) assertReplicaIntegrity(world, h.store, ORB);
            }

            async function run(task: SimulationTask, command: Command) {
              coverage.add(command);
              count(`command:${command}`);
              currentWall = task.wallNow();
              const orb = h.store.orbSnapshot(ORB);
              witness(task, "invoke", {
                seed,
                placement,
                command,
                state: orb?.state,
                wall: task.wallNow(),
              });
              const id = `campaign-${seed}-${ordinal++}`;
              const response = async <T, E>(pending: ResultAsync<T, E>): Promise<Result<T, E>> => {
                const result = await pending;
                witness(task, "response", {
                  id,
                  command,
                  ok: result.isOk(),
                  value: result.isOk() ? result.value : result.error,
                });
                count(`result:${command}:${result.isOk() ? "ok" : "err"}`);
                return result;
              };
              if (
                ["busy", "idle", "crash", "delay"].includes(command) &&
                (!world.filesystemExists(ORB) || !h.world.filesystemExists(ORB))
              )
                return;
              switch (command) {
                case "human": {
                  const result = await response(
                    enqueueOrbMessage(task, deps, {
                      orbId: ORB,
                      messageId: id,
                      content: [{ type: "text", text: id }],
                    }),
                  );
                  if (result.isOk()) {
                    count("admitted:human");
                  }
                  break;
                }
                case "peer":
                case "retry":
                case "foreign": {
                  const source = present(
                    h.store.orbSnapshot(command === "foreign" ? FOREIGN : PEER),
                  );
                  const request =
                    command === "retry" && lastPeer ? lastPeer : { messageId: id, message: id };
                  const result = await response(
                    sendOrbMessage(
                      task,
                      deps,
                      {
                        orbId: source.id,
                        projectId: source.projectId,
                        ownerUserId: command === "foreign" ? "foreign-owner" : TEST_USER_ID,
                        caller: {
                          runtimeTokenHash: present(source.runtimeTokenHash),
                          hostIncarnation: source.hostIncarnation,
                        },
                      },
                      { ...request, orbId: ORB },
                    ),
                  );
                  if (command === "foreign") expect(result.isErr(), "owner isolation").toBe(true);
                  else if (result.isOk()) {
                    lastPeer = request;
                    count("admitted:peer");
                  }
                  break;
                }
                case "sleep":
                case "stale": {
                  if (!orb || (placement === "guest" && !orb.runtimeTokenHash)) break;
                  const duration =
                    [1, 2, 5, 30, 120][Math.floor(task.random("sleep duration") * 5)] ?? 1;
                  const caller =
                    placement === "central"
                      ? {
                          kind: "central" as const,
                          orbId: ORB,
                          projectId: PROJECT,
                          ownerUserId: TEST_USER_ID,
                          agentAdmissionVersion:
                            orb.agentAdmissionVersion - (command === "stale" ? 1 : 0),
                        }
                      : {
                          runtimeTokenHash:
                            command === "stale" ? "revoked-token" : present(orb.runtimeTokenHash),
                          hostIncarnation: orb.hostIncarnation,
                        };
                  const result = await response(
                    requestOrbSleep(task, deps, ORB, caller, duration, id),
                  );
                  if (command === "stale")
                    expect(result.isErr(), "stale incarnation rejected").toBe(true);
                  if (result.isOk()) {
                    expect(sleeps.get(id)).toBe(result.value.sleepUntil);
                    count(`sleep-accepted:${orb.state}`);
                  }
                  break;
                }
                case "stop-ack":
                  h.store.failNextOrbStopAfterCommit(1);
                  await response(requestOrbStop(task, deps, ORB));
                  break;
                case "stop-rollback":
                  h.store.failNextClearOrbMessageAutoStart(1);
                  await response(requestOrbStop(task, deps, ORB));
                  break;
                case "pause-compute":
                  computePaused = !computePaused;
                  break;
                case "pause-history":
                  historyPaused = !historyPaused;
                  break;
                case "preempt":
                  if (h.world.filesystemExists(ORB) && h.world.hostStateOf(ORB) === "running") {
                    h.world.preemptHost(task, ORB, 1_000);
                    count("applied:preempt");
                  }
                  break;
                case "unreachable":
                  if (world.filesystemExists(ORB)) {
                    const duration = 10_000 + task.random("unreachable duration") * 30_000;
                    unreachableUntil = task.monotonicNow() + duration;
                    world.setRuntimeUnreachable(task, ORB, duration);
                    count("applied:unreachable-window");
                  }
                  break;
                case "pull-outage":
                  if (world.filesystemExists(ORB))
                    world.setPullOutage(
                      task,
                      ORB,
                      10_000 + task.random("pull outage duration") * 30_000,
                    );
                  if (world.filesystemExists(ORB)) count("applied:pull-outage-window");
                  break;
                case "stop": {
                  await response(requestOrbStop(task, deps, ORB));
                  break;
                }
                case "start": {
                  await response(requestOrbStart(task, deps, ORB));
                  break;
                }
                case "tick":
                  await reconcileAllOnce(task, deps);
                  break;
                case "poll":
                  await pollAllOnce(task, deps);
                  break;
                case "advance":
                  await task.sleep(
                    [1, 500, 5_000, 30_000][Math.floor(task.random("advance duration") * 4)] ?? 1,
                    "campaign advance",
                  );
                  break;
                case "wall":
                  wallOffset +=
                    [-5_000, 1_000, 10_000][Math.floor(task.random("wall jump") * 3)] ?? 0;
                  break;
                case "busy":
                  centralBusy = true;
                  centralPrepared = false;
                  h.world.setActivity(ORB, "busy");
                  break;
                case "idle":
                  centralBusy = false;
                  if (world.filesystemExists(ORB)) world.flushPendingInboxBatches(ORB);
                  if (h.world.filesystemExists(ORB)) h.world.setActivity(ORB, "idle");
                  break;
                case "restart":
                  deps = restartControlPlane({ ...h, deps }).deps;
                  count("applied:restart-control-and-auth");
                  break;
                case "crash":
                  if (world.hostStateOf(ORB) === "running") {
                    const before = world.runtimeInstanceIdOf(ORB);
                    world.restartRuntimeProcess(task, ORB);
                    expect(world.runtimeInstanceIdOf(ORB)).not.toBe(before);
                    count("applied:crash");
                  }
                  break;
                case "delay": {
                  const mode = task.random("delivery window");
                  world.scriptDeliverMessage(
                    ORB,
                    mode < 0.25
                      ? { kind: "hang", durationMs: 10_000 }
                      : mode < 0.5
                        ? { kind: "enqueue_without_persist" }
                        : mode < 0.75
                          ? { kind: "persist_without_ack" }
                          : { kind: "crash_before_enqueue" },
                  );
                  break;
                }
                case "archive":
                case "delete":
                  // Cleanup is selected throughout the sequence, not a mandatory final suffix.
                  if (task.random("admit cleanup command") < 0.03) {
                    const result = await response(
                      (command === "archive" ? requestOrbArchive : requestOrbDeletion)(
                        task,
                        deps,
                        ORB,
                      ),
                    );
                    if (result.isOk()) cleanup = command;
                  }
                  break;
              }
            }

            const result = await sim.runTasks([
              {
                name: "compute worker",
                f: async (raw) => {
                  const task = clock(raw);
                  await waitUntil(task, "campaign seeded", () => ready, { intervalMs: 1 });
                  while (driving) {
                    const role = deps;
                    if (!computePaused) await reconcileAllOnce(task, role);
                    await task.sleep(100 + task.random("compute tick") * 400, "compute tick");
                  }
                  workers--;
                },
              },
              {
                name: "history worker",
                f: async (raw) => {
                  const task = clock(raw);
                  await waitUntil(task, "campaign seeded", () => ready, { intervalMs: 1 });
                  while (driving) {
                    const role = deps;
                    if (!historyPaused) await pollAllOnce(task, role);
                    await task.sleep(100 + task.random("history tick") * 400, "history tick");
                  }
                  workers--;
                },
              },
              ...[0, 1].map((actor) => ({
                name: `caller ${actor}`,
                f: async (raw: SimulationTask) => {
                  const task = clock(raw);
                  await waitUntil(task, "campaign seeded", () => ready, { intervalMs: 1 });
                  for (let step = actor; step < commandsPerSeed; step += 2) {
                    const command = present(
                      commands[Math.floor(task.random("next command") * commands.length)],
                    );
                    if (activeCalls > 0) count("applied:overlapping-caller");
                    activeCalls++;
                    const before = { ...counts };
                    await run(task, command);
                    activeCalls--;
                    currentWall = task.wallNow();
                    safety();
                    witness(task, "command-complete", {
                      actor,
                      step,
                      command,
                      state: h.store.orbSnapshot(ORB)?.state,
                      observedDuringCall: Object.fromEntries(
                        Object.entries(counts)
                          .filter(([key, value]) => value !== before[key])
                          .map(([key, value]) => [key, value - (before[key] ?? 0)]),
                      ),
                    });
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
                  seedRunningOrb(task, h, FOREIGN);
                  const foreignProject = present(h.store.projectSnapshot(`project-of-${FOREIGN}`));
                  h.store.seedProject({ ...foreignProject, ownerUserId: "foreign-owner" });
                  seedRunningOrb(task, central, ORB);
                  if (task.random("initial lifecycle") < 0.5) {
                    seedRunningOrb(task, h, ORB, { bootLatencyMs: 50, initDurationMs: 0 });
                    coverage.add("initial:running");
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
                    coverage.add("initial:creating");
                  }
                  h.store.seedOrb({ ...present(h.store.orbSnapshot(PEER)), projectId: PROJECT });
                  ready = true;
                  await waitUntil(task, "caller actors joined", () => callers === 0, {
                    intervalMs: 100,
                  });
                  driving = false;
                  computePaused = false;
                  historyPaused = false;
                  await waitUntil(task, "all pre-quiescence actors finished", () => workers === 0, {
                    intervalMs: 100,
                  });
                  h.store.failNextClearOrbMessageAutoStart(0);
                  h.store.failNextOrbStopAfterCommit(0);
                  if (world.filesystemExists(ORB)) {
                    world.setRuntimeUnreachable(task, ORB, 0);
                    world.setPullOutage(task, ORB, 0);
                    world.scriptDeliverMessage(ORB, { kind: "ok" });
                  }
                  if (world.filesystemExists(ORB)) world.flushPendingInboxBatches(ORB);
                  centralBusy = false;
                  if (h.world.filesystemExists(ORB)) h.world.setActivity(ORB, "idle");
                  wallOffset = Math.max(0, wallOffset);
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
                    currentWall = task.wallNow();
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
                  const obligations = [...accepted].map(([id, entry]) => ({
                    id,
                    ...entry,
                    receipt: receipts.has(id),
                  }));
                  witness(task, "final", {
                    final,
                    obligations,
                    budget,
                    now: task.monotonicNow(),
                    deadline,
                    counts,
                  });
                  expect(
                    settled,
                    `progress obligations: ${JSON.stringify(obligations)} final=${JSON.stringify(final)}`,
                  ).toBe(true);
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
                  count("applied:non-earliest-timer", logs.lateChoices);
                  safety();
                  for (const key of coverage) count(`covered:${key}`);
                  const evidenceDir = `.context/lifecycle-campaign/${process.pid}`;
                  mkdirSync(evidenceDir, { recursive: true });
                  writeFileSync(
                    `${evidenceDir}/${placement}-${seed}.json`,
                    JSON.stringify({
                      seed,
                      placement,
                      counts,
                      obligations,
                      witnesses: logs.lines(),
                    }),
                  );
                  completed++;
                  for (const [key, value] of Object.entries(counts))
                    totals[`${placement}:${key}`] = (totals[`${placement}:${key}`] ?? 0) + value;
                },
              },
            ]);
            expect(result.isOk(), result.isErr() ? result.error.stack : "").toBe(true);
          },
        );
      });
    }
  }
});
