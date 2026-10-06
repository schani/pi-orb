import type { HistoryRecord } from "@pi-orb/protocol";
import { ConditionVariable } from "determined";
import { err, errAsync, ok, okAsync, ResultAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { orbView } from "../http/views.ts";
import { makeHarness, makeOrbRow, makeProjectRow } from "../testkit/fixtures.ts";
import { runDst, waitUntil } from "../testkit/sim.ts";
import { commitAgentHistory } from "./agent-history.ts";
import type { AgentPlane } from "./agent-ports.ts";
import { reconcileCentralAgent, reconcileOrbOnce, requestOrbStop } from "./lifecycle.ts";
import { pollLoop } from "./loops.ts";

describe("independent central dispatcher", () => {
  it("does not deliver a claimed old batch after explicit Stop", async () => {
    await runDst({ name: "central-dispatch-stop-claim", iterations: 15 }, async (sim) => {
      const h = makeHarness();
      const gate = new ConditionVariable("claim stop authority");
      let queued = false;
      let claimed = false;
      let released = false;
      let delivered = 0;
      const original = h.store.claimNextOrbMessageBatch.bind(h.store);
      h.store.claimNextOrbMessageBatch = (task, request) =>
        new ResultAsync(
          (async () => {
            const result = await original(task, request);
            claimed = true;
            gate.notifyAll(task, "claimed");
            while (!released) await gate.wait(task, "stop accepted");
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
        deliverMessage: () => {
          delivered++;
          return okAsync({
            v: 1 as const,
            messageId: "old",
            status: "persisted" as const,
            delivery: "turn" as const,
            operationId: "turn",
            duplicate: false,
          });
        },
        pullHistory: unavailable,
        prepareIdleStop: unavailable,
        suspend: () => okAsync(undefined),
        dispose: () => okAsync(undefined),
        session: () => null,
        close: () => okAsync(undefined),
      };
      const deps = { ...h.deps, agentPlane: plane };
      h.store.seedOrb(makeOrbRow("orb", "project", "creating"));
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
            expect(
              (
                await h.store.enqueueOrbMessage(task, {
                  orbId: "orb",
                  messageId: "old",
                  content: [{ type: "text", text: "old" }],
                  now: task.wallNow(),
                })
              ).isOk(),
            ).toBe(true);
            queued = true;
            gate.notifyAll(task, "queued");
            while (!claimed) await gate.wait(task, "claimed batch");
            expect((await requestOrbStop(task, deps, "orb")).isOk()).toBe(true);
            released = true;
            gate.notifyAll(task, "stop accepted");
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(delivered).toBe(0);
      expect(h.store.messageSnapshots("orb")[0]).toMatchObject({
        status: "delivering",
        autoStart: false,
      });
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
        h.store.seedOrb(makeOrbRow("orb", "project", "creating"));
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
