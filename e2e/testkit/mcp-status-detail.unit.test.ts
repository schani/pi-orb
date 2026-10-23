import type { DisplayHistoryView } from "@pi-orb/protocol";
import { expect, it, vi } from "vitest";
import { hasCommittedMcpStatus } from "./mcp-status-detail.ts";

const history: DisplayHistoryView = {
  orbId: "orb",
  session: { id: "session" },
  cursor: "tool",
  headId: "tool",
  records: [
    {
      id: "tool",
      parentId: null,
      timestamp: "now",
      type: "message",
      role: "tool",
      content: [{ type: "tool_result", callId: "call", hasImages: false, detailKey: "tool:0" }],
    },
  ],
};
const committed = {
  v: 1,
  sessionId: "session",
  recordId: "tool",
  detailKey: "tool:0",
  state: "committed",
  body: { type: "tool_result", content: [{ type: "text", text: "MCP fixture: connected." }] },
};

it("retains inline guest status without fetching details", async () => {
  const request = vi.fn();
  const guest: DisplayHistoryView = {
    ...history,
    records: [
      {
        id: "status",
        parentId: null,
        timestamp: "now",
        type: "event",
        eventType: "custom",
        custom: { customType: "mcp-status", display: true },
        content: [{ type: "text", text: "MCP fixture: needs-auth." }],
      },
    ],
  };
  expect((await hasCommittedMcpStatus(guest, "needs-auth", request))._unsafeUnwrap()).toBe(true);
  expect(request).not.toHaveBeenCalled();
});

it("does not cache a missing detail and retries the same committed reference", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({
      status: 404,
      body: { error: { code: "not_found", retryable: false } },
    })
    .mockResolvedValueOnce({ status: 200, body: committed });
  expect(await hasCommittedMcpStatus(history, "connected", request)).toMatchObject({
    error: { type: "detail_missing", status: 404 },
  });
  expect((await hasCommittedMcpStatus(history, "connected", request))._unsafeUnwrap()).toBe(true);
  expect(request.mock.calls[0]).toEqual(request.mock.calls[1]);
});

it.each([
  { ...committed, state: "running" },
  { ...committed, sessionId: "stale" },
  { ...committed, recordId: "other" },
  { ...committed, detailKey: "tool:9" },
  { ...committed, body: { type: "tool_call", arguments: "MCP fixture: connected." } },
])("rejects noncommitted or mismatched detail %#", async (body) => {
  expect(
    await hasCommittedMcpStatus(history, "connected", async () => ({ status: 200, body })),
  ).toMatchObject({ error: { type: "invalid_detail", status: 200 } });
});

it("maps rejected detail transport to a typed, payload-free error", async () => {
  expect(
    await hasCommittedMcpStatus(history, "connected", () => Promise.reject(new Error("PRIVATE"))),
  ).toMatchObject({ error: { type: "detail_unavailable", status: 0 } });
});
