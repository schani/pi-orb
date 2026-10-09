import { expect, it } from "vitest";
import { makeHarness, makeOrbRow, makeProjectRow, TEST_USER_ID } from "../testkit/fixtures.ts";
import { runDst, waitUntil } from "../testkit/sim.ts";
import { cancelQueuedUserTurn } from "./queued-turn-cancellation.ts";

const messageId = "00000000-0000-4000-8000-000000000013";
const nextId = "00000000-0000-4000-8000-000000000014";
it("linearizes named cancellation against FIFO claim without cancelling fresh inputs or host demand", async () => {
  await runDst({ name: "queued-abort-vs-claim", iterations: 30 }, async (sim) => {
    const harness = makeHarness();
    harness.store.seedProject(makeProjectRow("project"));
    harness.store.seedOrb(makeOrbRow("orb", "project", "starting"));
    const caller = {
      kind: "central" as const,
      ownerUserId: TEST_USER_ID,
      projectId: "project",
      orbId: "orb",
      agentAdmissionVersion: 0,
    };
    let ready = false;
    let cancelled = false;
    let claimed = false;
    const result = await sim.runTasks([
      {
        name: "enqueue",
        f: async (task) => {
          (
            await harness.store.enqueueOrbMessage(task, {
              orbId: "orb",
              messageId,
              content: [{ type: "text", text: "cancel me" }],
              now: task.wallNow(),
            })
          )._unsafeUnwrap();
          ready = true;
        },
      },
      {
        name: "cancel",
        f: async (task) => {
          await waitUntil(task, "first input accepted", () => ready);
          expect(
            (
              await cancelQueuedUserTurn(task, harness.store, caller, `inbox:${messageId}`)
            )._unsafeUnwrap(),
          ).toBe("cancelled");
          cancelled = true;
        },
      },
      {
        name: "claim",
        f: async (task) => {
          await waitUntil(task, "first input accepted", () => ready);
          (
            await harness.store.claimNextOrbMessageBatch(task, {
              orbId: "orb",
              now: task.wallNow(),
            })
          )._unsafeUnwrap();
          claimed = true;
        },
      },
      {
        name: "fresh",
        f: async (task) => {
          await waitUntil(task, "abort and claim settled", () => cancelled && claimed);
          expect(
            (
              await cancelQueuedUserTurn(task, harness.store, caller, `inbox:${messageId}`)
            )._unsafeUnwrap(),
          ).toBe("cancelled");
          (
            await harness.store.enqueueOrbMessage(task, {
              orbId: "orb",
              messageId: nextId,
              content: [{ type: "text", text: "fresh" }],
              now: task.wallNow(),
            })
          )._unsafeUnwrap();
          expect(
            (
              await harness.store.claimNextOrbMessageBatch(task, {
                orbId: "orb",
                now: task.wallNow(),
              })
            )
              ._unsafeUnwrap()
              .map((row) => row.messageId),
          ).toEqual([nextId]);
          expect(harness.store.orbSnapshot("orb")).toMatchObject({
            state: "starting",
            stopReason: null,
            agentAdmissionVersion: 0,
          });
          expect(harness.store.messageSnapshots("orb")[0]).toMatchObject({
            status: "failed",
            lastError: "Cancelled before agent admission",
          });
        },
      },
    ]);
    expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
  });
});
