import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { recordMcpStatus } from "./mcp-status.ts";

it("returns a typed failure when status persistence throws", () => {
  const manager = {
    getSessionId: () => "root-session",
    appendCustomEntry: () => {
      throw new Error("storage unavailable");
    },
  } as unknown as Pick<SessionManager, "appendCustomEntry" | "getSessionId">;
  expect(
    recordMcpStatus(manager, { server: "posthog", state: "failed" })._unsafeUnwrapErr(),
  ).toEqual({
    type: "mcp_status_record_error",
    message: "Cannot record MCP connection status",
  });
});

it("attributes root and child statuses to their session without persisting raw messages", () => {
  const manager = SessionManager.inMemory();
  const rootId = manager.getSessionId();
  expect(
    recordMcpStatus(manager, { server: "posthog", state: "connected", sessionId: rootId }).isOk(),
  ).toBe(true);
  expect(
    recordMcpStatus(manager, {
      server: "posthog",
      state: "failed",
      sessionId: "child-session",
      message: "RAW_SERVER_SECRET",
    }).isOk(),
  ).toBe(true);
  expect(
    manager.getEntries().map((entry) => (entry.type === "custom" ? entry.data : null)),
  ).toMatchObject([
    { server: "posthog", sessionId: rootId, source: "root" },
    { server: "posthog", sessionId: "child-session", source: "child" },
  ]);
  expect(JSON.stringify(manager.getEntries())).not.toContain("RAW_SERVER_SECRET");
});

it("records sanitized, non-model MCP failure and recovery edges", () => {
  const manager = SessionManager.inMemory();
  expect(
    recordMcpStatus(manager, {
      server: "posthog",
      state: "failed",
      diagnostic: { code: "upstream_http", httpStatus: 503 },
      message: "RAW_SERVER_SECRET",
    }).isOk(),
  ).toBe(true);
  expect(recordMcpStatus(manager, { server: "posthog", state: "connected" }).isOk()).toBe(true);
  expect(manager.getEntries().map((entry) => entry.type)).toEqual(["custom", "custom"]);
  const [failed, recovered] = manager.getEntries();
  expect(failed).toMatchObject({
    customType: "pi-orb:mcp-status",
    data: {
      server: "posthog",
      state: "failed",
      diagnostic: { code: "upstream_http", httpStatus: 503 },
    },
  });
  expect(recovered).toMatchObject({
    customType: "pi-orb:mcp-status",
    data: { server: "posthog", state: "connected", source: "root" },
  });
  if (recovered?.type === "custom") expect(recovered.data).not.toHaveProperty("sessionId");
  expect(JSON.stringify(manager.getEntries())).not.toContain("custom_message");
  expect(JSON.stringify(manager.getEntries())).not.toContain("RAW_SERVER_SECRET");
});
