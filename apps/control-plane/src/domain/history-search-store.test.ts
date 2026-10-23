import type { HistoryRecord } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { describe, expect, it } from "vitest";
import { makeHarness, makeOrbRow, makeProjectRow } from "../testkit/fixtures.ts";

const task = new NoSimulationTask("search oracle", false);
const message = (id: string, text: string, parentId: string | null = null): HistoryRecord => ({
  id,
  parentId,
  timestamp: "2026-10-23",
  overflow: {},
  type: "message",
  role: "assistant",
  content: [{ type: "text", text }],
});
describe("memory history search oracle", () => {
  it("excludes deleting projects and returns an empty corpus for tokenless searches", async () => {
    const h = makeHarness();
    h.store.seedProject({ ...makeProjectRow("p"), ownerUserId: "owner" });
    h.store.seedOrb(makeOrbRow("orb", "p", "archived"));
    expect(
      (
        await h.store.commitPullBatch(task, {
          orbId: "orb",
          expectedCursor: null,
          session: { id: "s", overflow: {} },
          records: [message("r", "apple")],
          nextCursor: "r",
          nextHeadId: "r",
        })
      ).isOk(),
    ).toBe(true);
    expect(
      (
        await h.store.searchHistory(task, {
          ownerUserId: "owner",
          terms: [],
          limit: 10,
        })
      )._unsafeUnwrap(),
    ).toEqual({ hits: [], documentCount: 0, candidateCount: 0 });
    h.store.seedProject({ ...makeProjectRow("p"), ownerUserId: "owner", state: "deleting" });
    expect(
      (
        await h.store.searchHistory(task, {
          ownerUserId: "owner",
          terms: ["apple"],
          limit: 10,
        })
      )._unsafeUnwrap(),
    ).toEqual({ hits: [], documentCount: 0, candidateCount: 0 });
  });
  it("uses exact corpus BM25 before limit and deterministic ties, excluding foreign owners", async () => {
    const h = makeHarness();
    h.store.seedProject({ ...makeProjectRow("p"), ownerUserId: "owner" });
    h.store.seedProject({ ...makeProjectRow("foreign"), ownerUserId: "other" });
    for (const [id, project, text] of [
      ["b", "p", "apple"],
      ["a", "p", "apple"],
      ["c", "p", "apple apple pear"],
      ["d", "p", "pear pear pear pear pear"],
      ["e", "foreign", "apple"],
    ] as const) {
      h.store.seedOrb(makeOrbRow(id, project, "archived"));
      expect(
        (
          await h.store.commitPullBatch(task, {
            orbId: id,
            expectedCursor: null,
            session: { id: "s", overflow: {} },
            records: [message("r", text)],
            nextCursor: "r",
            nextHeadId: "r",
          })
        ).isOk(),
      ).toBe(true);
    }
    const result = (
      await h.store.searchHistory(task, {
        ownerUserId: "owner",
        terms: ["apple", "apple"],
        limit: 1,
      })
    )._unsafeUnwrap();
    expect(result).toMatchObject({ documentCount: 4, candidateCount: 3 });
    expect(result.hits.map((hit) => hit.orbId)).toEqual(["a"]);
    // N=4, df=3, avgdl=2.5, tf=1, dl=1.
    expect(result.hits[0]?.score).toBeCloseTo(
      (Math.log(1 + 1.5 / 3.5) * 2.2) / (1 + 1.2 * (0.25 + 0.75 / 2.5)),
      12,
    );
    expect(
      (
        await h.store.searchHistory(task, {
          ownerUserId: "owner",
          projectId: "foreign",
          terms: ["apple"],
          limit: 10,
        })
      )._unsafeUnwrap(),
    ).toEqual({ documentCount: 0, candidateCount: 0, hits: [] });
  });
  it.each(["pi", "claude"] as const)(
    "uses %s current transcript eligibility for statistics and candidates",
    async (harness) => {
      const h = makeHarness();
      h.store.seedProject({ ...makeProjectRow("p"), ownerUserId: "owner" });
      h.store.seedOrb(makeOrbRow("orb", "p", "stopped", { harness }));
      const records = [
        message("root", "common"),
        message("branch", "discarded", "root"),
        message("current", "current", "root"),
        { ...message("private", "secret", "current"), role: "system" as const },
      ];
      expect(
        (
          await h.store.commitPullBatch(task, {
            orbId: "orb",
            expectedCursor: null,
            session: { id: "s", overflow: {} },
            records,
            nextCursor: "private",
            nextHeadId: "private",
          })
        ).isOk(),
      ).toBe(true);
      const result = (
        await h.store.searchHistory(task, {
          ownerUserId: "owner",
          orbId: "orb",
          terms: ["discarded", "secret", "current"],
          limit: 10,
        })
      )._unsafeUnwrap();
      expect(result.documentCount).toBe(harness === "pi" ? 2 : 3);
      expect(result.hits.map((hit) => hit.recordId).sort()).toEqual(
        harness === "pi" ? ["current"] : ["branch", "current"],
      );
    },
  );
});
