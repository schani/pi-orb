import { expect, it } from "vitest";
import { makeHarness, makeOrbRow, makeProjectRow, TEST_USER_ID } from "../testkit/fixtures.ts";
import { runDst, waitUntil } from "../testkit/sim.ts";
import { cancelQueuedUserTurn } from "./queued-turn-cancellation.ts";

it("fences late frozen-batch rejection while cancellation survivors are detached and reclaimed", async () => {
  await runDst(
    { name: "queued-batch-cancellation-vs-late-rejection", iterations: 30 },
    async (sim) => {
      const harness = makeHarness();
      harness.store.seedProject(makeProjectRow("project"));
      harness.store.seedOrb(makeOrbRow("orb", "project", "starting"));
      const first = "00000000-0000-4000-8000-000000000031",
        second = "00000000-0000-4000-8000-000000000032";
      const caller = {
        kind: "central" as const,
        ownerUserId: TEST_USER_ID,
        projectId: "project",
        orbId: "orb",
        agentAdmissionVersion: 0,
      };
      let cancelled = false,
        reclaimed = false,
        rejected = false;
      let oldBatch: string | null = null;
      const result = await sim.runTasks([
        {
          name: "capture-batch",
          f: async (task) => {
            for (const id of [first, second])
              (
                await harness.store.enqueueOrbMessage(task, {
                  orbId: "orb",
                  messageId: id,
                  content: [{ type: "text", text: id }],
                  now: task.wallNow(),
                })
              )._unsafeUnwrap();
            oldBatch =
              (
                await harness.store.claimNextOrbMessageBatch(task, {
                  orbId: "orb",
                  now: task.wallNow(),
                })
              )._unsafeUnwrap()[0]?.deliveryBatchId ?? null;
          },
        },
        {
          name: "cancel-member",
          f: async (task) => {
            await waitUntil(task, "batch captured", () => oldBatch !== null);
            expect(
              (
                await cancelQueuedUserTurn(task, harness.store, caller, `inbox:${second}`)
              )._unsafeUnwrap(),
            ).toBe("cancelled");
            cancelled = true;
          },
        },
        {
          name: "reclaim-survivor",
          f: async (task) => {
            await waitUntil(task, "cancellation committed", () => cancelled);
            const next = (
              await harness.store.claimNextOrbMessageBatch(task, {
                orbId: "orb",
                now: task.wallNow(),
              })
            )._unsafeUnwrap();
            expect(next.map((row) => row.messageId)).toEqual([first]);
            expect(next[0]?.deliveryBatchId).not.toBe(oldBatch);
            reclaimed = true;
          },
        },
        {
          name: "late-rejection",
          f: async (task) => {
            await waitUntil(task, "cancellation committed", () => cancelled);
            if (oldBatch === null) expect.fail("Captured batch missing");
            (
              await harness.store.failOrbMessageBatch(task, {
                orbId: "orb",
                messageIds: [first, second],
                deliveryBatchId: oldBatch,
                lastError: "old native rejection",
                now: task.wallNow(),
              })
            )._unsafeUnwrap();
            rejected = true;
          },
        },
        {
          name: "verify",
          f: async (task) => {
            await waitUntil(task, "reclaim and rejection joined", () => reclaimed && rejected);
            const rows = harness.store.messageSnapshots("orb");
            expect(rows.find((row) => row.messageId === first)).toMatchObject({
              status: "delivering",
              lastError: null,
              deliveryBatchId: first,
            });
            expect(rows.find((row) => row.messageId === second)).toMatchObject({
              status: "failed",
              lastError: "Cancelled before agent admission",
            });
            expect(harness.store.orbSnapshot("orb")).toMatchObject({
              state: "starting",
              agentAdmissionVersion: 0,
              stopReason: null,
            });
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    },
  );
});
