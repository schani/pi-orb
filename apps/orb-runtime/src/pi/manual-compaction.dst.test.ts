import { SessionManager } from "@earendil-works/pi-coding-agent";
import { okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { decideRequest } from "../domain/requests.ts";
import { MemoryIdleStopFence } from "../testkit/idle-stop-fence.ts";
import { runDst } from "../testkit/sim.ts";
import { PiOrbAgent, type PiSession } from "./agent.ts";

it("compaction owns message/child/settings/stop admission until native abort and publication drain", async () => {
  await runDst({ name: "manual-compaction-admission", iterations: 30 }, async (sim) => {
    const result = await sim.runTasks([
      {
        name: "runtime",
        f: async (task) => {
          const agent = new PiOrbAgent({
            orbId: "compact-dst",
            repositoryUrl: "https://example.com/repo",
            workDir: "/test",
            skillsDir: null,
            broker: null,
            executionId: "execution",
            idleStopFence: new MemoryIdleStopFence(),
          });
          let cancellations = 0;
          const session = {
            isIdle: true,
            pendingMessageCount: 0,
            subscribe: () => () => undefined,
            compact: async () => {
              await task.checkpoint("compact claimed before SDK controller");
              expect(agent.gateView().activity).toBe("busy");
              expect(
                decideRequest(agent.gateView(), { type: "set_thinking", thinkingLevel: "low" }),
              ).toMatchObject({ type: "reject", code: "busy" });
              expect(agent.prepareIdleStop()._unsafeUnwrap()).toBe(false);
              expect(agent.admitSubagent("during-compact").isErr()).toBe(true);
              expect(
                (
                  await agent.deliverInboxMessage(
                    "inbox",
                    ["inbox"],
                    [{ type: "text", text: "queued by CP" }],
                  )
                ).isErr(),
              ).toBe(true);
              expect((await agent.abortOperation()).isOk()).toBe(true);
              await task.checkpoint("native compaction cancelling before real drain");
              expect(agent.gateView().activity).toBe("busy");
              return {};
            },
            waitForIdle: async () => {
              await task.checkpoint("compact drained before history publication");
              expect(agent.gateView().activity).toBe("busy");
            },
            abortCompaction: () => {
              cancellations++;
            },
            abort: async () => {},
          } as unknown as PiSession;
          agent.attachSession(session, SessionManager.inMemory("/test"), {
            summarize: () => okAsync(""),
          });
          expect((await agent.compact("decisions", "operation")).isOk()).toBe(true);
          expect(cancellations).toBe(1);
          expect(agent.gateView().activity).toBe("idle");
          expect(agent.snapshot()._unsafeUnwrap().records).toContainEqual(
            expect.objectContaining({
              compaction: expect.objectContaining({ outcome: "aborted" }),
            }),
          );
        },
      },
    ]);
    expect(result.isErr() ? result.error : null).toBeNull();
  });
});
