import type { HistoryRecord } from "@pi-orb/protocol";
import { describe, expect, it } from "vitest";
import { FAILPOINTS } from "../testkit/failpoints.ts";
import { makeOrbRow, makeProjectRow } from "../testkit/fixtures.ts";
import { LogCapture, runDst } from "../testkit/sim.ts";
import { InMemoryControlPlaneStore } from "../testkit/store.ts";

const ORB = "alert-orb";
const session = { id: "session", overflow: {} };
const alert = (id: string, parentId: string | null): HistoryRecord => ({
  id,
  parentId,
  timestamp: "2026-01-01T00:00:00.000Z",
  type: "event",
  eventType: "pi.custom",
  content: [{ type: "text", text: id }],
  alert: { message: id, requestId: id },
  overflow: {},
});

describe("orb alert store", () => {
  it("commit response loss keeps publication durable and replay cannot rearm a cleared alert", async () => {
    await runDst(
      {
        name: "alert-response-loss",
        iterations: 10,
        failpointProbabilities: { [FAILPOINTS.storeCommitAfter]: 1 },
      },
      async (sim) => {
        const store = new InMemoryControlPlaneStore();
        const result = await sim.runTasks([
          {
            name: "driver",
            f: async (task) => {
              store.seedProject(makeProjectRow("project"));
              store.seedOrb(makeOrbRow(ORB, "project", "running"));
              const a = alert("A", null);
              const committed = await store.commitPullBatch(task, {
                orbId: ORB,
                expectedCursor: null,
                session,
                records: [a],
                nextCursor: a.id,
                nextHeadId: a.id,
              });
              expect(committed.isErr()).toBe(true);
              expect((await store.getOrb(task, ORB))._unsafeUnwrap()?.unreadAlertId).toBe(a.id);
              expect((await store.ackOrbAlert(task, ORB, a.id))._unsafeUnwrap()).toBeNull();
              const replay = await store.commitPullBatch(task, {
                orbId: ORB,
                expectedCursor: null,
                session,
                records: [a],
                nextCursor: a.id,
                nextHeadId: a.id,
              });
              expect(replay._unsafeUnwrapErr().type).toBe("cursor_conflict");
              expect((await store.getOrb(task, ORB))._unsafeUnwrap()?.unreadAlertId).toBeNull();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      },
    );
  });
  it("publishes only new inserts, clears by comparison, and never rearms on replay", async () => {
    const logs = new LogCapture();
    await runDst({ name: "alert-store", iterations: 1, logCapture: logs }, async (sim) => {
      const store = new InMemoryControlPlaneStore();
      const result = await sim.runTasks([
        {
          name: "driver",
          f: async (task) => {
            store.seedProject(makeProjectRow("project"));
            store.seedOrb(makeOrbRow(ORB, "project", "running"));
            const commit = (expectedCursor: string | null, records: HistoryRecord[]) =>
              store.commitPullBatch(task, {
                orbId: ORB,
                expectedCursor,
                session,
                records,
                nextCursor: records[records.length - 1]?.id ?? "",
                nextHeadId: records[records.length - 1]?.id ?? "",
              });
            expect((await commit(null, [alert("A", null)]))._unsafeUnwrap().unreadAlertId).toBe(
              "A",
            );
            expect((await store.ackOrbAlert(task, ORB, "A"))._unsafeUnwrap()).toBeNull();
            expect(
              (await commit("A", [alert("A", null), alert("B", "A")]))._unsafeUnwrap()
                .unreadAlertId,
            ).toBe("B");
            expect((await store.ackOrbAlert(task, ORB, "A"))._unsafeUnwrap()).toBe("B");
            expect((await store.ackOrbAlert(task, ORB, "B"))._unsafeUnwrap()).toBeNull();
            expect((await store.ackOrbAlert(task, ORB, "B"))._unsafeUnwrap()).toBeNull();
            expect(logs.lines().filter((line) => line.includes("alert-published"))).toHaveLength(2);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });
});
