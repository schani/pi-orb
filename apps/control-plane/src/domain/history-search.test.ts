import type { HistoryRecord } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { errAsync, okAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { makeHarness, makeOrbRow, makeProjectRow } from "../testkit/fixtures.ts";
import { searchGuestOrbHistory, searchOrbHistory } from "./history-search.ts";

const identity = { ownerUserId: "owner", projectId: "project", orbId: "self" };
const record: HistoryRecord = {
  id: "r",
  parentId: null,
  timestamp: "2026-10-23",
  overflow: {},
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "public needle" }],
};
function setup() {
  const h = makeHarness();
  h.store.seedProject({ ...makeProjectRow("project"), ownerUserId: "owner" });
  h.store.seedOrb(makeOrbRow("self", "project", "stopped"));
  const task = new NoSimulationTask("search", false);
  const log = vi.spyOn(task, "log");
  const search = vi.spyOn(h.store, "searchHistory").mockReturnValue(
    okAsync({
      hits: [
        {
          orbId: "self",
          sessionId: "s",
          recordId: "r",
          name: null,
          projectName: "Project",
          record,
          score: 0.3,
        },
      ],
      documentCount: 7,
      candidateCount: 3,
    }),
  );
  return {
    h,
    task,
    log,
    search,
    invoke: (request: Parameters<typeof searchOrbHistory>[3]) =>
      searchOrbHistory(task, h.store, identity, request, "https://app"),
  };
}
describe("history search service", () => {
  it("binds guest scope from admitted source and rejects rotated credentials", async () => {
    const s = setup();
    const source = makeOrbRow("self", "project", "running", {
      runtimeTokenHash: "token",
      hostIncarnation: 1,
    });
    s.h.store.seedOrb(source);
    expect(
      (
        await searchGuestOrbHistory(
          s.task,
          s.h.deps,
          source,
          { query: "needle", scope: "user" },
          "https://app",
        )
      ).isOk(),
    ).toBe(true);
    expect(s.search).toHaveBeenCalledWith(s.task, {
      ownerUserId: "owner",
      terms: ["needle"],
      limit: 10,
    });
    s.h.store.seedOrb({ ...source, runtimeTokenHash: "rotated" });
    s.search.mockClear();
    expect(
      (
        await searchGuestOrbHistory(s.task, s.h.deps, source, { query: "needle" }, "https://app")
      )._unsafeUnwrapErr().code,
    ).toBe("unauthorized");
    expect(s.search).not.toHaveBeenCalled();
  });
  it.each([
    [
      { query: "Needle NEEDLE" },
      { ownerUserId: "owner", orbId: "self", terms: ["needle"], limit: 10 },
    ],
    [
      { query: "needle", scope: "project" as const, limit: 50 },
      { ownerUserId: "owner", projectId: "project", terms: ["needle"], limit: 50 },
    ],
    [
      { query: "needle", scope: "user" as const },
      { ownerUserId: "owner", terms: ["needle"], limit: 10 },
    ],
  ])("binds scope to identity and returns public DTOs", async (request, params) => {
    const s = setup();
    expect((await s.invoke(request))._unsafeUnwrap()).toEqual({
      hits: [
        {
          orbId: "self",
          sessionId: "s",
          recordId: "r",
          name: null,
          projectName: "Project",
          score: 0.3,
          snippet: "public needle",
          orbUrl: "https://app/orbs/self",
        },
      ],
    });
    expect(s.search).toHaveBeenCalledWith(s.task, params);
    expect(s.log.mock.calls.flat().join(" ")).toMatch(
      /scope=.*documents=7.*candidates=3.*hits=1.*durationMs=/,
    );
    expect(s.log.mock.calls.flat().join(" ")).not.toMatch(/needle|public/i);
  });
  it.each([
    { query: "" },
    { query: "   " },
    { query: 2 },
    { query: null },
    { query: "x", scope: "bad" },
    { query: "x", scope: null },
    { query: "x", scope: "project", orbId: "self" },
    { query: "x", scope: "user", orbId: "self" },
    { query: "x", orbId: "" },
    { query: "x", orbId: 1 },
    ...[0, -1, 51, 1.5, NaN, Infinity, "10", null].map((limit) => ({ query: "x", limit })),
  ])("rejects malformed runtime input %j", async (request) => {
    const s = setup();
    expect(
      (await s.invoke(request as Parameters<typeof s.invoke>[0]))._unsafeUnwrapErr().code,
    ).toBe("invalid_request");
    expect(s.search).not.toHaveBeenCalled();
    expect(s.log.mock.calls.flat().join(" ")).toContain("error=invalid_request");
  });
  it("returns no matches for tokenless queries", async () => {
    const s = setup();
    expect((await s.invoke({ query: "!?" }))._unsafeUnwrap()).toEqual({ hits: [] });
    expect(s.search).not.toHaveBeenCalled();
  });
  it("does not expose another owner's explicit target", async () => {
    const s = setup();
    s.h.store.seedProject({ ...makeProjectRow("other"), ownerUserId: "another" });
    s.h.store.seedOrb(makeOrbRow("target", "other", "archived"));
    expect((await s.invoke({ query: "needle", orbId: "target" }))._unsafeUnwrapErr().code).toBe(
      "not_found",
    );
    expect(s.search).not.toHaveBeenCalled();
  });
  it.each(["missing", "deleting"] as const)("reports %s targets visibly", async (state) => {
    const s = setup();
    if (state === "deleting") s.h.store.seedOrb(makeOrbRow("target", "project", state));
    expect((await s.invoke({ query: "needle", orbId: "target" }))._unsafeUnwrapErr().code).toBe(
      state === "deleting" ? "conflict" : "not_found",
    );
    expect(s.search).not.toHaveBeenCalled();
  });
  it("sanitizes store failures and telemetry", async () => {
    const s = setup();
    s.search.mockReturnValue(
      errAsync({
        type: "store_error",
        code: "unavailable",
        retryable: true,
        message: "private database details",
      }),
    );
    expect((await s.invoke({ query: "needle" }))._unsafeUnwrapErr()).toEqual({
      code: "unavailable",
      message: "history search unavailable",
    });
    expect(s.log.mock.calls.flat().join(" ")).toContain("error=unavailable");
    expect(s.log.mock.calls.flat().join(" ")).not.toMatch(/private|needle/);
  });
});
