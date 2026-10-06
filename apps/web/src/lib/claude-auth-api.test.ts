import { afterEach, expect, it, vi } from "vitest";
import { claudeAuthAction, getClaudeAuth } from "./api.ts";

afterEach(() => vi.unstubAllGlobals());
it("uses current-user endpoints without owner/orb selectors", async () => {
  const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) =>
    Response.json({ status: "connected", generation: 1 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const signal = new AbortController().signal;
  expect((await getClaudeAuth(signal)).isOk()).toBe(true);
  for (const action of ["connect", "code", "cancel", "disconnect"] as const)
    expect(
      (
        await claudeAuthAction(action, action === "code" ? "returned-code" : undefined, signal)
      ).isOk(),
    ).toBe(true);
  expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
    "/api/v1/claude/auth",
    "/api/v1/claude/auth/connect",
    "/api/v1/claude/auth/code",
    "/api/v1/claude/auth/cancel",
    "/api/v1/claude/auth/disconnect",
  ]);
  expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({ code: "returned-code" });
  expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({});
});
it("rejects credentials in auth-status responses", async () => {
  vi.stubGlobal("fetch", async () => Response.json({ status: "connected", token: "secret" }));
  expect((await getClaudeAuth(new AbortController().signal)).isErr()).toBe(true);
});
