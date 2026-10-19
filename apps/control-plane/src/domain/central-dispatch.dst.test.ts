import type { HistoryRecord } from "@pi-orb/protocol";
import { ConditionVariable } from "determined";
import { err, errAsync, ok, okAsync, ResultAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { orbView } from "../http/views.ts";
import { makeHarness, makeOrbRow, makeProjectRow } from "../testkit/fixtures.ts";
import { runDst, TEST_WALL_EPOCH, waitUntil } from "../testkit/sim.ts";
import { commitAgentHistory } from "./agent-history.ts";
import type { AgentPlane } from "./agent-ports.ts";
import {
  reconcileCentralAgent,
  reconcileOrbOnce,
  requestOrbSleep,
  requestOrbStop,
} from "./lifecycle.ts";
import { pollLoop } from "./loops.ts";

describe("independent central dispatcher", () => {
  it.each(["deliver", "stop", "sleep"] as const)("fences claimed input after %s", async (fence) => {
    await runDst({ name: `central-dispatch-${fence}-claim`, iterations: 15 }, async (sim) => {
      const h = makeHarness();
      const project = makeProjectRow("project");
      const peer = "00000000-0000-4000-8000-00000000000a";
      const inputs = ["old", "peer", "last"];
      const sender = {
        orbId: peer,
        projectId: project.id,
        ownerUserId: project.ownerUserId,
        caller: {
          kind: "central" as const,
          orbId: peer,
          projectId: project.id,
          ownerUserId: project.ownerUserId,
          agentAdmissionVersion: 0,
        },
      };
      const gate = new ConditionVariable(`claim ${fence} authority`);
      let queued = false;
      let claimed = false;
      let released = false;
      let delivered = 0;
      const original = h.store.claimOrbMessageBacklog.bind(h.store);
      h.store.claimOrbMessageBacklog = (task, request) =>
        new ResultAsync(
          (async () => {
            const result = await original(task, request);
            expect(result._unsafeUnwrap().map((r) => r.messageId)).toEqual(inputs);
            claimed = true;
            gate.notifyAll(task, "claimed");
            while (!released) await gate.wait(task, `${fence} accepted`);
            return result;
          })(),
        );
      const unavailable = () =>
        errAsync({
          type: "runtime_client_error" as const,
          code: "unreachable" as const,
          message: "not needed",
          retryable: true,
          answered: false,
        });
      const plane: AgentPlane = {
        placement: "central",
        health: () =>
          okAsync({
            v: 1 as const,
            orbId: "orb",
            runtimeInstanceId: "central",
            status: "initializing" as const,
            phase: "booting" as const,
          }),
        deliverMessage: unavailable,
        deliverMessages: (_task, _orb, requests) => {
          delivered++;
          expect(requests).toEqual(
            inputs.map((messageId) => ({
              baseUrl: "",
              messageId,
              messageIds: [messageId],
              content: [{ type: "text", text: messageId }],
              ...(messageId === "peer"
                ? { system: { kind: "orb_message", senderOrbId: peer } }
                : {}),
            })),
          );
          return okAsync(
            requests.map((r) =>
              ok({
                v: 1 as const,
                messageId: r.messageId,
                status: "persisted" as const,
                delivery: "turn" as const,
                operationId: "turn",
                duplicate: false,
              }),
            ),
          );
        },
        pullHistory: unavailable,
        prepareIdleStop: unavailable,
        suspend: () => okAsync(undefined),
        dispose: () => okAsync(undefined),
        session: () => null,
        close: () => okAsync(undefined),
      };
      const deps = { ...h.deps, agentPlane: plane };
      h.store.seedProject(project);
      h.store.seedOrb(makeOrbRow(peer, "project", "running"));
      h.store.seedOrb(makeOrbRow("orb", "project", fence === "sleep" ? "running" : "creating"));
      const result = await sim.runTasks([
        {
          name: "dispatcher",
          f: async (task) => {
            while (!queued) await gate.wait(task, "input queued");
            await reconcileCentralAgent(task, deps, "orb");
          },
        },
        {
          name: "stop",
          f: async (task) => {
            for (const messageId of inputs)
              expect(
                (
                  await h.store.enqueueOrbMessage(task, {
                    orbId: "orb",
                    messageId,
                    content: [{ type: "text", text: messageId }],
                    now: task.wallNow(),
                    ...(messageId === "peer" ? { sender } : {}),
                  })
                ).isOk(),
              ).toBe(true);
            queued = true;
            gate.notifyAll(task, "queued");
            while (!claimed) await gate.wait(task, "claimed batch");
            if (fence === "deliver") {
              (
                await h.store.enqueueOrbMessage(task, {
                  orbId: "orb",
                  messageId: "later",
                  content: [{ type: "text", text: "later" }],
                  now: task.wallNow(),
                })
              )._unsafeUnwrap();
            } else {
              const accepted =
                fence === "stop"
                  ? await requestOrbStop(task, deps, "orb")
                  : await requestOrbSleep(
                      task,
                      deps,
                      "orb",
                      {
                        kind: "central",
                        orbId: "orb",
                        projectId: "project",
                        ownerUserId: project.ownerUserId,
                        agentAdmissionVersion: 0,
                      },
                      300,
                      "sleep",
                    );
              expect(accepted.isOk()).toBe(true);
            }
            released = true;
            gate.notifyAll(task, `${fence} accepted`);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      if (fence === "sleep")
        expect(h.store.orbSnapshot("orb")).toMatchObject({ sleepId: "sleep", stopReason: null });
      const rows = h.store.messageSnapshots("orb");
      expect(rows.slice(0, inputs.length).map((r) => r.deliveryBatchId)).toEqual(inputs);
      expect(rows.slice(0, inputs.length).map((r) => r.status)).toEqual(
        inputs.map(() => "delivering"),
      );
      if (fence === "deliver") {
        expect(delivered).toBe(1);
        expect(rows.slice(0, inputs.length).every((r) => r.operationId === "turn")).toBe(true);
        expect(rows.at(-1)).toMatchObject({
          messageId: "later",
          status: "queued",
          deliveryBatchId: null,
        });
      } else {
        expect(delivered).toBe(0);
        for (const row of rows)
          expect(row).toMatchObject({ status: "delivering", autoStart: false });
      }
    });
  });
  it("delivers later input and completes Stop while VM provisioning remains held", async () => {
    // Isolate admission progress, not provider-deadline recovery (covered separately).
    await runDst(
      { name: "central-dispatch-held-provision", iterations: 15, lateTimerProbability: 0 },
      async (sim) => {
        const h = makeHarness({
          constants: { historyPullIntervalMs: 10_000 },
        });
        const gate = new ConditionVariable("provider admission test");
        let admitted = false;
        let held = false;
        let release = false;
        let providerFinished = false;
        let suspended = false;
        const records: HistoryRecord[] = [];
        const deliveries: string[] = [];
        const original = h.deps.hostProvider.provision.bind(h.deps.hostProvider);
        h.deps.hostProvider.provision = (task, request, context) =>
          new ResultAsync(
            (async () => {
              held = true;
              gate.notifyAll(task, "provider held");
              const cancel = () => gate.notifyAll(task, "provider cancelled");
              context.signal.addEventListener("abort", cancel, { once: true });
              while (!release && !context.signal.aborted) await gate.wait(task, "provider release");
              context.signal.removeEventListener("abort", cancel);
              if (context.signal.aborted)
                return err({
                  type: "orb_host_provider_error" as const,
                  provider: "fake",
                  operation: "provision" as const,
                  code: "cancelled" as const,
                  message: "cancelled",
                  retryable: true,
                });
              const result = await original(task, request, context);
              providerFinished = true;
              return result;
            })(),
          );
        const plane: AgentPlane = {
          placement: "central",
          health: () =>
            okAsync({
              v: 1 as const,
              orbId: "orb",
              runtimeInstanceId: "central",
              status: "ready" as const,
              checkoutCommit: "central",
              sessionId: "central",
              activity: "busy" as const,
            }),
          deliverMessage: (task, _orb, request) =>
            new ResultAsync(
              (async () => {
                if (!deliveries.includes(request.messageId)) {
                  const last = records.at(-1);
                  records.push({
                    id: request.messageId,
                    parentId: last?.id ?? null,
                    timestamp: new Date(task.wallNow()).toISOString(),
                    overflow: {},
                    type: "message",
                    role: "user",
                    content: [...request.content],
                    inboxMessageIds: [...(request.messageIds ?? [request.messageId])],
                  });
                  const committed = await commitAgentHistory(task, deps, {
                    orbId: "orb",
                    runtimeInstanceId: "central",
                    activity: "busy",
                    session: { id: "central", overflow: {} },
                    records,
                    headId: request.messageId,
                  });
                  if (committed.isErr()) return err(committed.error);
                  deliveries.push(request.messageId);
                }
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
          pullHistory: (_task, _orb, request) => {
            const after =
              request.after === null
                ? -1
                : records.findIndex((record) => record.id === request.after);
            return okAsync({
              v: 1 as const,
              orbId: "orb",
              runtimeInstanceId: "central",
              activity: "busy" as const,
              session: { id: "central", overflow: {} },
              records: records.slice(after + 1),
              cursor: records.at(-1)?.id ?? null,
              headId: records.at(-1)?.id ?? null,
            });
          },
          prepareIdleStop: () => okAsync({ v: 1 as const, prepared: false }),
          suspend: () => {
            suspended = true;
            return okAsync(undefined);
          },
          dispose: () => okAsync(undefined),
          close: () => okAsync(undefined),
          session: () => ({
            runtimeInstanceId: "central",
            workActive: () => !suspended,
            snapshot: () => err({ message: "not needed" }),
            liveView: () => null,
            subscribe: () => () => undefined,
            request: () =>
              okAsync({ type: "accepted" as const, operationId: "turn", duplicate: false }),
          }),
        };
        const deps = { ...h.deps, agentPlane: plane };
        const stop = new AbortController();
        h.store.seedProject(makeProjectRow("project"));
        h.store.seedOrb(
          makeOrbRow("orb", "project", "creating", { stateChangedAt: TEST_WALL_EPOCH }),
        );
        const result = await sim.runTasks([
          {
            name: "vm",
            f: async (task) => {
              while (!admitted) await gate.wait(task, "first input admission");
              await reconcileOrbOnce(task, deps, "orb");
            },
          },
          {
            name: "central-poll",
            f: async (task) => {
              while (!held) await gate.wait(task, "provider starts");
              await pollLoop(task, deps, stop.signal);
            },
          },
          {
            name: "driver",
            f: async (task) => {
              expect(
                (
                  await h.store.enqueueOrbMessage(task, {
                    orbId: "orb",
                    messageId: "first",
                    content: [{ type: "text", text: "first" }],
                    now: task.wallNow(),
                  })
                ).isOk(),
              ).toBe(true);
              admitted = true;
              gate.notifyAll(task, "input admitted");
              await waitUntil(task, "VM provision entered", () => held);
              expect(deliveries).toEqual(["first"]);
              deps.control.setNextAttemptAt("poll:orb", task.monotonicNow() + 10_000);
              const sentAt = task.monotonicNow();
              expect(
                (
                  await h.store.enqueueOrbMessage(task, {
                    orbId: "orb",
                    messageId: "second",
                    content: [{ type: "text", text: "steer" }],
                    now: task.wallNow(),
                  })
                ).isOk(),
              ).toBe(true);
              await waitUntil(
                task,
                "later central input delivered",
                () => deliveries.includes("second"),
                { timeoutMs: 2_000 },
              );
              expect(task.monotonicNow() - sentAt).toBeLessThan(2_000);
              expect(providerFinished).toBe(false);
              expect(
                orbView(h.store.orbSnapshot("orb")!, deps.control, { centralAgent: true }),
              ).toMatchObject({ state: "creating", activity: "busy" });
              expect(deps.control.getLiveness("orb")).toBeNull();
              expect((await requestOrbStop(task, deps, "orb")).isOk()).toBe(true);
              expect(suspended).toBe(true);
              expect(providerFinished).toBe(false);
              expect(h.store.messageSnapshots("orb").map((message) => message.status)).toEqual([
                "delivered",
                "delivered",
              ]);
              stop.abort();
              release = true;
              gate.notifyAll(task, "release after Stop");
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      },
    );
  });
});
