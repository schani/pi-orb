import { NoSimulationTask } from "determined";
import { errAsync, okAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { makeHarness, makeOrbRow, makeProjectRow } from "../testkit/fixtures.ts";
import { searchGuestOrbHistory, searchOrbHistory } from "./history-search.ts";

const identity = { ownerUserId: "owner", projectId: "project", orbId: "self" };
function setup() {
  const h = makeHarness();
  h.store.seedProject({ ...makeProjectRow("project"), ownerUserId: "owner" });
  h.store.seedOrb(makeOrbRow("self", "project", "stopped"));
  const task = new NoSimulationTask("search", false);
  const log = vi.spyOn(task, "log");
  const hit = {
    orbId: "self",
    sessionId: "s",
    recordId: "r",
    name: null,
    projectName: "Project",
    snippet: "public needle",
    score: 0.3,
  };
  const search = vi
    .spyOn(h.store, "searchHistory")
    .mockReturnValue(okAsync({ hits: [hit], documentCount: 7, candidateCount: 3 }));
  return {
    h,
    task,
    log,
    hit,
    search,
    invoke: (request: Parameters<typeof searchOrbHistory>[3]) =>
      searchOrbHistory(task, h.store, identity, request, "https://app"),
  };
}
describe("history search service", () => {
  it.each([
    [
      { query: " Needle NEEDLE " },
      { ownerUserId: "owner", orbId: "self", query: "Needle NEEDLE", limit: 10 },
    ],
    [
      { query: "needle", scope: "project" as const, limit: 50 },
      { ownerUserId: "owner", projectId: "project", query: "needle", limit: 50 },
    ],
    [
      { query: "needle", scope: "user" as const },
      { ownerUserId: "owner", query: "needle", limit: 10 },
    ],
  ])("binds scope and passes text to SQL without tokenizing", async (request, params) => {
    const s = setup();
    const pull = vi.spyOn(s.h.deps.runtimeClient, "pullHistory");
    expect((await s.invoke(request))._unsafeUnwrap()).toEqual({
      hits: [{ ...s.hit, orbUrl: "https://app/orbs/self" }],
    });
    expect(s.search).toHaveBeenCalledWith(s.task, params);
    expect(pull).not.toHaveBeenCalled();
    const log = s.log.mock.calls.flat().join(" ");
    expect(log).toMatch(/scope=.*documents=7.*candidates=3.*hits=1.*durationMs=/);
    expect(log).not.toMatch(/needle|public/i);
  });
  it.each([
    { query: "" },
    { query: "x".repeat(4097) },
    { query: "x", scope: "project", orbId: "self" },
    { query: "x", scope: "user", orbId: "self" },
    { query: "x", orbId: "  " },
    ...[0, 51, 1.5].map((limit) => ({ query: "x", limit })),
  ])("rejects invalid input %j", async (request) => {
    const s = setup();
    expect(
      (await s.invoke(request as Parameters<typeof s.invoke>[0]))._unsafeUnwrapErr().code,
    ).toBe("invalid_request");
    expect(s.search).not.toHaveBeenCalled();
  });
  it("delegates punctuation queries to SQL", async () => {
    const s = setup();
    await s.invoke({ query: "!?" });
    expect(s.search).toHaveBeenCalledWith(s.task, expect.objectContaining({ query: "!?" }));
  });
  it.each(["foreign", "missing", "deleting", "archived"])(
    "checks explicit %s targets",
    async (state) => {
      const s = setup();
      s.h.store.seedProject({ ...makeProjectRow("foreign"), ownerUserId: "another" });
      if (state !== "missing")
        s.h.store.seedOrb(
          makeOrbRow(
            "target",
            state === "foreign" ? "foreign" : "project",
            state === "deleting" ? "deleting" : "archived",
          ),
        );
      const result = await s.invoke({ query: "needle", orbId: "target" });
      if (state === "archived") expect(result.isOk()).toBe(true);
      else {
        expect(result._unsafeUnwrapErr().code).toBe(
          state === "deleting" ? "conflict" : "not_found",
        );
        expect(s.search).not.toHaveBeenCalled();
      }
    },
  );
  it("sanitizes database failure and telemetry", async () => {
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
    const log = s.log.mock.calls.flat().join(" ");
    expect(log).toContain("error=unavailable");
    expect(log).not.toMatch(/private|needle/);
  });
  it("derives guest owner and fences rotated credentials", async () => {
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
      query: "needle",
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
});
