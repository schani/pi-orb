import type { HistoryRecord } from "@pi-orb/protocol";
import { errAsync, okAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import { orbView } from "../http/views.ts";
import { makeHarness, makeOrbRow, makeProjectRow, TEST_USER_ID } from "../testkit/fixtures.ts";
import { LogCapture, runDst } from "../testkit/sim.ts";
import { commitAgentHistory } from "./agent-history.ts";
import type { AgentPlane } from "./agent-ports.ts";
import type { RuntimeClientError } from "./errors.ts";
import { reconcileCentralAgent, requestOrbStart } from "./lifecycle.ts";
import { cancelQueuedUserTurn } from "./queued-turn-cancellation.ts";

const message = "This orb uses the old Pi backend. Create a new orb to continue.";
// This agreed boundary verdict predates the production error-union addition.
const refusal = {
  type: "runtime_client_error",
  code: "legacy_backend",
  answered: true,
  retryable: false,
  message,
} as unknown as RuntimeClientError;
const first = "00000000-0000-4000-8000-000000000061";
const second = "00000000-0000-4000-8000-000000000062";
const later = "00000000-0000-4000-8000-000000000063";

function rejectingPlane() {
  const checkStartup = vi.fn((..._args: Parameters<AgentPlane["health"]>) =>
    errAsync<void, RuntimeClientError>(refusal),
  );
  const deliverMessage = vi.fn<AgentPlane["deliverMessage"]>(() => errAsync(refusal));
  const health = vi.fn<AgentPlane["health"]>(() => errAsync(refusal));
  const plane: AgentPlane & { checkStartup: typeof checkStartup } = {
    placement: "central",
    checkStartup,
    health,
    deliverMessage,
    pullHistory: () => errAsync(refusal),
    prepareIdleStop: () => errAsync(refusal),
    suspend: () => okAsync(undefined),
    dispose: () => okAsync(undefined),
    session: () => null,
    close: () => okAsync(undefined),
  };
  return { plane, checkStartup, deliverMessage, health };
}

it("manual refusal precedes sleep cancellation and CAS, and shares one rejection edge with dispatch", async () => {
  const log = new LogCapture();
  await runDst(
    { name: "legacy-start-no-mutation", iterations: 10, logCapture: log },
    async (sim) => {
      const h = makeHarness();
      const f = rejectingPlane();
      const deps = { ...h.deps, agentPlane: f.plane };
      h.store.seedProject(makeProjectRow("project"));
      h.store.seedOrb(
        makeOrbRow("orb", "project", "running", {
          harnessSessionId: "old-pi-session",
          harnessSessionHeader: { id: "old-pi-session", overflow: {} },
          sleepId: "accepted-sleep",
          sleepUntil: 1_767_229_200_000,
        }),
      );
      const before = h.store.orbSnapshot("orb");
      const cas = vi.spyOn(h.store, "casTransition");
      const sleep = vi.spyOn(h.store, "cancelOrbSleep");
      const result = await sim.runTasks([
        {
          name: "manual-and-dispatch",
          f: async (task) => {
            for (let i = 0; i < 3; i++) {
              const started = await requestOrbStart(task, deps, "orb");
              expect(started.isErr()).toBe(true);
              expect(started._unsafeUnwrapErr()).toMatchObject({
                code: "conflict",
                retryable: false,
                message,
              });
            }
            await reconcileCentralAgent(task, deps, "orb");
            await reconcileCentralAgent(task, deps, "orb");
            expect(h.store.orbSnapshot("orb")).toEqual(before);
            expect(cas).not.toHaveBeenCalled();
            expect(sleep).not.toHaveBeenCalled();
            expect(f.deliverMessage).not.toHaveBeenCalled();
            expect(log.matching(" central-agent-start-rejected ")).toHaveLength(1);
            expect(log.matching("legacy_backend")).toHaveLength(1);
            expect(log.matching(" central-agent-unavailable ")).toHaveLength(0);
            expect(log.matching(" central-delivery-blocked ")).toHaveLength(0);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    },
  );
});

it.each(["queued", "delivering", "cancelled-member"] as const)(
  "legacy dispatch terminally fails %s batches without history rotation or compute failure",
  async (scenario) => {
    const log = new LogCapture();
    await runDst(
      { name: `legacy-batch-${scenario}`, iterations: 10, logCapture: log },
      async (sim) => {
        const h = makeHarness();
        const f = rejectingPlane();
        const deps = { ...h.deps, agentPlane: f.plane };
        h.store.seedProject(makeProjectRow("project"));
        h.store.seedOrb(makeOrbRow("orb", "project", "starting"));
        const result = await sim.runTasks([
          {
            name: "dispatch",
            f: async (task) => {
              const record: HistoryRecord = {
                type: "message",
                id: "old-history",
                parentId: null,
                timestamp: new Date(task.wallNow()).toISOString(),
                overflow: {},
                role: "user",
                content: [{ type: "text", text: "retained transcript" }],
              };
              (
                await commitAgentHistory(task, deps, {
                  orbId: "orb",
                  runtimeInstanceId: "old-runtime",
                  activity: "idle",
                  session: { id: "old-pi-session", overflow: {} },
                  records: [record],
                  headId: record.id,
                })
              )._unsafeUnwrap();
              const before = h.store.orbSnapshot("orb")!;
              for (const id of [first, second])
                (
                  await h.store.enqueueOrbMessage(task, {
                    orbId: "orb",
                    messageId: id,
                    content: [{ type: "text", text: id }],
                    now: task.wallNow(),
                  })
                )._unsafeUnwrap();
              let frozenBatch: string | null = null;
              if (scenario !== "queued") {
                const frozen = (
                  await h.store.claimNextOrbMessageBatch(task, {
                    orbId: "orb",
                    now: task.wallNow(),
                  })
                )._unsafeUnwrap();
                frozenBatch = frozen[0]!.deliveryBatchId;
                if (scenario === "cancelled-member") {
                  expect(
                    (
                      await cancelQueuedUserTurn(
                        task,
                        h.store,
                        {
                          kind: "central",
                          ownerUserId: TEST_USER_ID,
                          projectId: "project",
                          orbId: "orb",
                          agentAdmissionVersion: before.agentAdmissionVersion,
                        },
                        `inbox:${second}`,
                      )
                    )._unsafeUnwrap(),
                  ).toBe("cancelled");
                }
              }
              await reconcileCentralAgent(task, deps, "orb");
              const failed = h.store.messageSnapshots("orb");
              expect(failed.find((row) => row.messageId === first)).toMatchObject({
                status: "failed",
                lastError: message,
              });
              expect(failed.find((row) => row.messageId === second)).toMatchObject({
                status: "failed",
                lastError:
                  scenario === "cancelled-member" ? "Cancelled before agent admission" : message,
              });
              const request = f.deliverMessage.mock.calls[0]![2];
              expect(request.messageIds).toEqual(
                scenario === "cancelled-member" ? [first] : [first, second],
              );
              if (scenario === "delivering") expect(request.messageId).toBe(frozenBatch);
              if (scenario === "cancelled-member") expect(request.messageId).not.toBe(frozenBatch);
              for (let i = 0; i < 3; i++) await reconcileCentralAgent(task, deps, "orb");
              expect(h.store.messageSnapshots("orb")).toEqual(failed);
              expect(f.deliverMessage).toHaveBeenCalledTimes(1);
              // A terminal batch must not wedge later FIFO input or become a retry obligation.
              (
                await h.store.enqueueOrbMessage(task, {
                  orbId: "orb",
                  messageId: later,
                  content: [{ type: "text", text: "later" }],
                  now: task.wallNow(),
                })
              )._unsafeUnwrap();
              await reconcileCentralAgent(task, deps, "orb");
              expect(
                h.store.messageSnapshots("orb").find((row) => row.messageId === later),
              ).toMatchObject({ status: "failed", lastError: message });
              expect(f.deliverMessage).toHaveBeenCalledTimes(2);
              expect(h.store.replicaRecords("orb")).toEqual([record]);
              expect(h.store.orbSnapshot("orb")).toMatchObject({
                state: before.state,
                stateVersion: before.stateVersion,
                lastError: before.lastError,
                agentAdmissionVersion: before.agentAdmissionVersion,
                harnessSessionId: before.harnessSessionId,
                harnessSessionHeader: before.harnessSessionHeader,
                replicationCursor: before.replicationCursor,
                replicatedHeadId: before.replicatedHeadId,
              });
              expect(
                orbView(h.store.orbSnapshot("orb")!, deps.control, {}).lastError,
              ).toBeUndefined();
              const visible = (await h.store.listOrbMessages(task, "orb"))._unsafeUnwrap();
              expect(visible.find((row) => row.messageId === first)?.lastError).toBe(message);
              expect(log.matching(" central-agent-start-rejected ")).toHaveLength(1);
              expect(log.matching(" message-batch-failed ")).toHaveLength(2);
              expect(log.matching(" central-delivery-blocked ")).toHaveLength(0);
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      },
    );
  },
);
