import { NoSimulationTask } from "determined";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseInspectionArgs } from "./command.ts";
import { HttpOrbInspectionEndpoint } from "./endpoint.ts";

describe("history search CLI arguments", () => {
  it.each([
    [["search", "a phrase"], { query: "a phrase" }, false],
    [
      ["search", "x", "--orb", "other", "--json", "--limit", "50"],
      { query: "x", orbId: "other", limit: 50 },
      true,
    ],
    [["search", "--project", "x"], { query: "x", scope: "project" }, false],
    [["search", "x", "--all"], { query: "x", scope: "user" }, false],
  ])("parses %j", (args, request, json) => {
    expect(parseInspectionArgs(args)._unsafeUnwrap()).toEqual({ type: "search", request, json });
  });
  it.each([
    ["search"],
    ["search", ""],
    ["search", "  "],
    ["search", "x", "y"],
    ["search", "x", "--orb"],
    ["search", "x", "--orb", ""],
    ["search", "x", "--project", "--all"],
    ["search", "x", "--orb", "o", "--project"],
    ["search", "x", "--all", "--all"],
    ["search", "x", "--orb", "o", "--orb", "o"],
    ["search", "x", "--wat"],
    ["search", "x", "--json", "--json"],
    ...["0", "51", "-1", "1.5", "1x", "NaN", ""].map((n) => ["search", "x", "--limit", n]),
    ["search", "x", "--limit"],
    ["search", "x", "--limit", "1", "--limit", "2"],
  ])("rejects malformed arguments %j", (...args) => {
    expect(parseInspectionArgs(args).isErr()).toBe(true);
  });
});

describe("history search HTTP transport", () => {
  const task = new NoSimulationTask("search endpoint", false);
  const endpoint = new HttpOrbInspectionEndpoint({
    controlPlaneUrl: "https://app",
    runtimeToken: "secret",
  });
  afterEach(() => vi.unstubAllGlobals());
  function respond(status: number, body: unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body), { status })),
    );
  }
  it("posts an authenticated body without putting the query in a URL", async () => {
    respond(200, { v: 1, hits: [] });
    expect(
      await endpoint.search(task, { query: "sensitive needle", scope: "project", limit: 10 }),
    ).toEqual({ kind: "search", value: { v: 1, hits: [] } });
    expect(fetch).toHaveBeenCalledWith(
      "https://app/runtime/v1/history/search",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ query: "sensitive needle", scope: "project", limit: 10 }),
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
      }),
    );
  });
  it.each([
    [400, "invalid_request"],
    [404, "not_found"],
    [409, "conflict"],
    [503, "unavailable"],
    [500, "internal"],
  ])("preserves typed HTTP %i failure", async (status, code) => {
    respond(status, {
      v: 1,
      error: { code, message: "search failed", retryable: code === "unavailable" },
    });
    expect(await endpoint.search(task, { query: "x" })).toEqual({
      kind: code,
      message: "search failed",
    });
  });
  it("does not confuse malformed success with no matches", async () => {
    respond(200, { v: 1, hits: [{}] });
    expect(await endpoint.search(task, { query: "x" })).toMatchObject({ kind: "internal" });
  });
  it("classifies connection failures without echoing private request details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("sensitive needle network details")),
    );
    expect(await endpoint.search(task, { query: "sensitive needle" })).toEqual({
      kind: "unavailable",
      message: "history search unavailable",
    });
  });
});
