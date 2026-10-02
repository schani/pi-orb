import { ResultAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import { makeHarness, makeOrbRow, makeProjectRow } from "../testkit/fixtures.ts";
import { runDst } from "../testkit/sim.ts";
import { readDisplayDetail } from "./display-detail.ts";

it.each(["deleting", "new-session"] as const)(
  "fences a committed replica body when %s wins the read",
  async (change) => {
    await runDst({ name: `display-detail-${change}-read`, iterations: 20 }, async (sim) => {
      const harness = makeHarness();
      harness.store.seedProject(makeProjectRow("project"));
      harness.store.seedOrb(makeOrbRow("orb", "project", "stopped"));
      const record = {
        id: "r1",
        parentId: null,
        timestamp: "2026-10-02T00:00:00.000Z",
        type: "message" as const,
        role: "assistant" as const,
        content: [{ type: "reasoning" as const, text: "old session secret" }],
        overflow: {},
      };
      let captured!: () => void;
      let release!: () => void;
      const capturedRead = new Promise<void>((resolve) => {
        captured = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const host = vi.spyOn(harness.deps.hostProvider, "observe");
      const result = await sim.runTasks([
        {
          name: "reader",
          f: async (task) => {
            expect(
              (
                await harness.store.commitPullBatch(task, {
                  orbId: "orb",
                  expectedCursor: null,
                  session: { id: "session", overflow: {} },
                  records: [record],
                  nextCursor: "r1",
                  nextHeadId: "r1",
                })
              ).isOk(),
            ).toBe(true);
            const original = harness.store.readHistoryRecord.bind(harness.store);
            vi.spyOn(harness.store, "readHistoryRecord").mockImplementation(
              (...args) =>
                new ResultAsync(
                  (async () => {
                    const snapshot = await original(...args);
                    captured();
                    await gate;
                    return snapshot;
                  })(),
                ),
            );
            const detail = await readDisplayDetail(task, harness.deps, {
              orbId: "orb",
              sessionId: "session",
              recordId: "r1",
              detailKey: "r1:0",
            });
            expect(detail.isErr()).toBe(true);
            if (detail.isErr())
              expect(detail.error.type).toBe(
                change === "deleting" ? "orb_missing" : "invalid_session",
              );
            expect(JSON.stringify(detail)).not.toContain("old session secret");
          },
        },
        {
          name: "mutation",
          f: async (task) => {
            await capturedRead;
            await task.checkpoint("stop/delete or session replacement before record response");
            harness.store.seedOrb(
              makeOrbRow(
                "orb",
                "project",
                change === "deleting" ? "deleting" : "stopped",
                change === "deleting" ? {} : { harnessSessionId: "new-session" },
              ),
            );
            release();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(host).not.toHaveBeenCalled();
    });
  },
);
