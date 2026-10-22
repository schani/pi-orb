import { NoSimulationTask } from "determined";
import { ok } from "neverthrow";
import { expect, it, vi } from "vitest";
import { McpOAuth } from "./mcp-oauth.ts";

it("does not admit OAuth work after caller cancellation", async () => {
  const read = vi.fn(async () => ok(null));
  const oauth = new McpOAuth({ read } as never, {} as never, {} as never);
  const controller = new AbortController();
  controller.abort();
  const result = await oauth.token(
    new NoSimulationTask("mcp-cancelled-token", false),
    { projectId: "project", id: "server", url: "https://mcp.invalid" },
    { reason: "startup" },
    { signal: controller.signal },
  );
  expect(result.isErr()).toBe(true);
  expect(read).not.toHaveBeenCalled();
});

it("preserves an earlier caller deadline before admitting OAuth work", async () => {
  const read = vi.fn(async () => ok(null));
  const oauth = new McpOAuth({ read } as never, {} as never, {} as never);
  const task = new NoSimulationTask("mcp-expired-token", false);
  const context = { signal: new AbortController().signal, deadlineAt: task.monotonicNow() - 1 };
  const result = await oauth.token(
    task,
    { projectId: "project", id: "server", url: "https://mcp.invalid" },
    { reason: "startup" },
    context,
  );
  expect(result.isErr()).toBe(true);
  expect(read).not.toHaveBeenCalled();
});
