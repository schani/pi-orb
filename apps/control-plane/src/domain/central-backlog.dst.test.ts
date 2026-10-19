import { ConditionVariable } from "determined";
import { err, errAsync, ok, okAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { makeHarness, makeOrbRow, makeProjectRow } from "../testkit/fixtures.ts";
import { runDst } from "../testkit/sim.ts";
import type { AgentPlane } from "./agent-ports.ts";
import { reconcileCentralAgent, requestOrbSleep, requestOrbStop } from "./lifecycle.ts";
import type { DeliverMessageClientRequest } from "./ports.ts";

const peerA = "00000000-0000-4000-8000-00000000000a";
const peerB = "00000000-0000-4000-8000-00000000000b";
const inputs = [
  { messageId: "human-first" },
  { messageId: "peer-a", senderOrbId: peerA },
  { messageId: "peer-b", senderOrbId: peerB },
  { messageId: "human-last" },
] as const;

describe("central backlog admission", () => {
  describe.each(["fresh", "recovery"] as const)("%s", (mode) => {
    it.each([
      "deliver",
      "reject-one",
      "reject-all",
      "integrity-all",
      "retry-all",
      "ambiguous-all",
      "stop",
      "sleep",
    ] as const)("%s applies to the whole claimed snapshot", async (action) => {
      await runDst(
        { name: `central-backlog-${mode}-${action}`, seed: 410, iterations: 10 },
        async (sim) => {
          const h = makeHarness();
          const project = makeProjectRow("project");
          h.store.seedProject(project);
          h.store.seedOrb(makeOrbRow("orb", project.id, "running"));
          for (const id of [peerA, peerB]) h.store.seedOrb(makeOrbRow(id, project.id, "running"));
          const gate = new ConditionVariable("backlog authority");
          let queued = false;
          let claimed = false;
          let released = false;
          const deliveries: (readonly DeliverMessageClientRequest[])[] = [];
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
            deliverMessages: (_task, _orb, requests) => {
              deliveries.push(requests);
              expect(requests).toEqual(
                inputs.map((input) => ({
                  baseUrl: "",
                  messageId: input.messageId,
                  messageIds: [input.messageId],
                  content: [{ type: "text", text: input.messageId }],
                  ...("senderOrbId" in input
                    ? { system: { kind: "orb_message", senderOrbId: input.senderOrbId } }
                    : {}),
                })),
              );
              if (action === "retry-all") return unavailable();
              if (
                action === "reject-all" ||
                action === "integrity-all" ||
                action === "ambiguous-all"
              )
                return errAsync({
                  type: "runtime_client_error" as const,
                  code:
                    action === "reject-all"
                      ? "legacy_backend"
                      : action === "integrity-all"
                        ? "history_integrity"
                        : "invalid_response",
                  message: "snapshot rejected",
                  retryable: false,
                  answered: true,
                });
              return okAsync(
                requests.map((request) =>
                  action === "reject-one" && request.messageId === "peer-a"
                    ? err({
                        type: "runtime_client_error" as const,
                        code: "invalid_response" as const,
                        message: "rejected partition",
                        retryable: false,
                        answered: true,
                      })
                    : ok({
                        v: 1 as const,
                        messageId: request.messageId,
                        status: "persisted" as const,
                        delivery: "turn" as const,
                        operationId: "turn",
                        duplicate: mode === "recovery",
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
          const result = await sim.runTasks([
            {
              name: "dispatcher",
              f: async (task) => {
                while (!queued) await gate.wait(task, "backlog queued");
                const checkpoint = task.checkpoint.bind(task);
                task.checkpoint = async (...log) => {
                  await checkpoint(...log);
                  if (log[0] !== "central.dispatch-before-authority") return;
                  expect(h.store.messageSnapshots("orb").map((row) => row.status)).toEqual(
                    inputs.map(() => "delivering"),
                  );
                  claimed = true;
                  gate.notifyAll(task, "snapshot claimed");
                  while (!released) await gate.wait(task, "authority decided");
                };
                await reconcileCentralAgent(task, deps, "orb");
              },
            },
            {
              name: "driver",
              f: async (task) => {
                for (const input of inputs) {
                  const senderOrbId = "senderOrbId" in input ? input.senderOrbId : undefined;
                  expect(
                    (
                      await h.store.enqueueOrbMessage(task, {
                        orbId: "orb",
                        messageId: input.messageId,
                        content: [{ type: "text", text: input.messageId }],
                        now: task.wallNow(),
                        ...(senderOrbId === undefined
                          ? {}
                          : {
                              sender: {
                                orbId: senderOrbId,
                                projectId: project.id,
                                ownerUserId: project.ownerUserId,
                                caller: {
                                  kind: "central" as const,
                                  orbId: senderOrbId,
                                  projectId: project.id,
                                  ownerUserId: project.ownerUserId,
                                  agentAdmissionVersion: 0,
                                },
                              },
                            }),
                      })
                    ).isOk(),
                  ).toBe(true);
                  if (mode === "recovery")
                    expect(
                      (
                        await h.store.claimNextOrbMessageBatch(task, {
                          orbId: "orb",
                          now: task.wallNow(),
                        })
                      ).isOk(),
                    ).toBe(true);
                }
                queued = true;
                gate.notifyAll(task, "backlog queued");
                while (!claimed) await gate.wait(task, "snapshot claimed");
                if (action !== "stop" && action !== "sleep")
                  expect(
                    (
                      await h.store.enqueueOrbMessage(task, {
                        orbId: "orb",
                        messageId: "later",
                        content: [{ type: "text", text: "later" }],
                        now: task.wallNow(),
                      })
                    ).isOk(),
                  ).toBe(true);
                else
                  expect(
                    (action === "stop"
                      ? await requestOrbStop(task, deps, "orb")
                      : await requestOrbSleep(
                          task,
                          deps,
                          "orb",
                          {
                            kind: "central",
                            orbId: "orb",
                            projectId: project.id,
                            ownerUserId: project.ownerUserId,
                            agentAdmissionVersion: 0,
                          },
                          300,
                          "sleep",
                        )
                    ).isOk(),
                  ).toBe(true);
                released = true;
                gate.notifyAll(task, "authority decided");
              },
            },
          ]);
          expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
          expect(claimed).toBe(true);
          const admitted = action !== "stop" && action !== "sleep";
          expect(deliveries).toHaveLength(admitted ? 1 : 0);
          const rows = h.store.messageSnapshots("orb");
          expect(rows.slice(0, inputs.length).map((row) => row.deliveryBatchId)).toEqual(
            inputs.map((input) => input.messageId),
          );
          expect(rows.slice(0, inputs.length).map((row) => row.status)).toEqual(
            inputs.map((input) =>
              action === "reject-all" ||
              action === "integrity-all" ||
              (action === "reject-one" && input.messageId === "peer-a")
                ? "failed"
                : "delivering",
            ),
          );
          if (action === "reject-one") {
            expect(rows.find((row) => row.messageId === "peer-a")).toMatchObject({
              lastError: "rejected partition",
              operationId: null,
            });
            expect(
              rows
                .slice(0, inputs.length)
                .filter((row) => row.messageId !== "peer-a")
                .every((row) => row.operationId === "turn"),
            ).toBe(true);
          }
          if (action === "reject-all" || action === "integrity-all")
            expect(
              rows
                .slice(0, inputs.length)
                .every((row) => row.lastError === "snapshot rejected" && row.operationId === null),
            ).toBe(true);
          if (action === "retry-all" || action === "ambiguous-all")
            expect(rows.every((row) => row.operationId === null && row.lastError === null)).toBe(
              true,
            );
          if (admitted)
            expect(rows.at(-1)).toMatchObject({
              messageId: "later",
              status: "queued",
              deliveryBatchId: null,
            });
          else expect(rows.every((row) => !row.autoStart)).toBe(true);
        },
      );
    });
  });
});
