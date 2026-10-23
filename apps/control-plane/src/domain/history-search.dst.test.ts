import type { HistoryRecord } from "@pi-orb/protocol";
import { NoSimulationTask, type SimulationTask } from "determined";
import { describe, expect, it } from "vitest";
import { FAILPOINTS } from "../testkit/failpoints.ts";
import { makeHarness, makeOrbRow, makeProjectRow } from "../testkit/fixtures.ts";
import { runDst } from "../testkit/sim.ts";
import type { HistorySearchResult } from "./history-search-types.ts";

const message = (id: string, parentId: string | null): HistoryRecord => ({
  id,
  parentId,
  timestamp: "2026-10-23",
  overflow: {},
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "common" }],
});
const params = { ownerUserId: "owner", terms: ["common"], limit: 10 };
async function setup() {
  const h = makeHarness();
  h.store.seedProject({ ...makeProjectRow("p"), ownerUserId: "owner" });
  h.store.seedOrb(makeOrbRow("orb", "p", "stopped"));
  expect(
    (
      await h.store.commitPullBatch(new NoSimulationTask("initial history", false), {
        orbId: "orb",
        expectedCursor: null,
        session: { id: "s", overflow: {} },
        records: [message("old", null)],
        nextCursor: "old",
        nextHeadId: "old",
      })
    ).isOk(),
  ).toBe(true);
  return h;
}
function assertSnapshot(result: HistorySearchResult, allowed: readonly number[]) {
  expect(allowed).toContain(result.documentCount);
  expect(result.candidateCount).toBe(result.documentCount);
  expect(result.hits).toHaveLength(result.documentCount);
  const expectedScore = Math.log(1 + 0.5 / (result.documentCount + 0.5));
  for (const hit of result.hits) expect(hit.score).toBeCloseTo(expectedScore, 12);
}
describe("history search atomic schedules", () => {
  it("sees whole commits under rollback, ambiguous outcomes and duplicate retries", async () => {
    await runDst(
      {
        name: "history-search-commit",
        iterations: 40,
        failpointProbabilities: {
          [FAILPOINTS.storeCommitBefore]: 0.3,
          [FAILPOINTS.storeCommitAfter]: 0.3,
        },
      },
      async (sim) => {
        const h = await setup();
        const outcome = await sim.runTasks([
          {
            name: "commit-and-retry",
            f: async (task) => {
              for (let retry = 0; retry < 2; retry++) {
                for (;;) {
                  const cursor = h.store.orbSnapshot("orb")?.replicationCursor ?? null;
                  const result = await h.store.commitPullBatch(task, {
                    orbId: "orb",
                    expectedCursor: cursor,
                    session: { id: "s", overflow: {} },
                    records: [message("new-a", "old"), message("new-b", "new-a")],
                    nextCursor: "new-b",
                    nextHeadId: "new-b",
                  });
                  if (result.isOk()) break;
                  expect(result.error.type).toBe("store_error");
                  await task.checkpoint("retry search projection");
                }
              }
            },
          },
          {
            name: "search",
            f: async (task) => {
              for (let i = 0; i < 5; i++)
                assertSnapshot((await h.store.searchHistory(task, params))._unsafeUnwrap(), [1, 3]);
            },
          },
        ]);
        expect(outcome.isOk(), outcome.isErr() ? outcome.error.message : "").toBe(true);
        expect(h.store.replicaRecords("orb")).toHaveLength(3);
      },
    );
  });
  it.each(["archive", "delete"] as const)(
    "search and %s expose only complete eligible corpora",
    async (kind) => {
      await runDst({ name: `history-search-${kind}`, iterations: 30 }, async (sim) => {
        const h = await setup();
        const outcome = await sim.runTasks([
          {
            name: kind,
            f: async (task: SimulationTask) => {
              const request = {
                orbId: "orb",
                expectedStateVersion: 0,
                now: task.wallNow(),
                cleanupAfter: task.wallNow(),
              };
              if (kind === "delete") {
                const deleting = (await h.store.requestOrbDeletion(task, request))._unsafeUnwrap();
                expect(
                  (
                    await h.store.finalizeOrbDeletion(task, {
                      orbId: "orb",
                      expectedStateVersion: deleting.stateVersion,
                    })
                  ).isOk(),
                ).toBe(true);
              } else {
                const archiving = (await h.store.requestOrbArchive(task, request))._unsafeUnwrap();
                expect(
                  (
                    await h.store.sealOrbArchive(task, {
                      orbId: "orb",
                      expectedStateVersion: archiving.stateVersion,
                      now: task.wallNow(),
                      cursor: "old",
                      headId: "old",
                    })
                  ).isOk(),
                ).toBe(true);
                expect(
                  (
                    await h.store.finalizeOrbArchive(task, {
                      orbId: "orb",
                      expectedStateVersion: archiving.stateVersion,
                      now: task.wallNow(),
                    })
                  ).isOk(),
                ).toBe(true);
              }
            },
          },
          {
            name: "search",
            f: async (task) => {
              for (let i = 0; i < 5; i++)
                assertSnapshot(
                  (await h.store.searchHistory(task, params))._unsafeUnwrap(),
                  kind === "delete" ? [0, 1] : [1],
                );
            },
          },
        ]);
        expect(outcome.isOk(), outcome.isErr() ? outcome.error.message : "").toBe(true);
        const final = (
          await h.store.searchHistory(new NoSimulationTask("final search", false), params)
        )._unsafeUnwrap();
        assertSnapshot(final, kind === "delete" ? [0] : [1]);
      });
    },
  );
});
