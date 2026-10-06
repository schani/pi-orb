import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { createDurableTools } from "./index.ts";

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

it("cancels in-flight MCP requests and closes their scoped transports", async () => {
  const entered = barrier();
  let closed = 0;
  const progress: unknown[] = [];
  const stdout: string[] = [];
  const diagnostics: unknown[] = [];
  const tools = createDurableTools({
    mcp: [
      {
        name: "mock",
        connect: () => {
          const { client, server } = createInMemoryTransportPair();
          server.onClose(() => closed++);
          server.onMessage((message) => {
            if (!("method" in message) || !("id" in message)) return;
            if (message.method === "initialize")
              void server.send({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  protocolVersion: "2025-11-25",
                  capabilities: { tools: {} },
                  serverInfo: { name: "mock", version: "1" },
                },
              });
            if (message.method === "tools/list")
              void server.send({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  tools: [
                    {
                      name: "wait",
                      inputSchema: { type: "object", properties: {}, additionalProperties: false },
                    },
                  ],
                },
              });
            if (message.method === "tools/call") {
              const params = message.params as { _meta?: { progressToken?: string | number } };
              void server.send({
                jsonrpc: "2.0",
                method: "notifications/progress",
                params: { progressToken: params._meta?.progressToken, progress: 1, total: 2 },
              });
              entered.resolve();
            }
          });
          void server.start();
          return okAsync(client);
        },
      },
    ],
  });
  await tools.ready();
  expect(tools.catalog.describe("mcp__mock__wait")).not.toBeNull();
  expect(tools.catalog.describe("mock_wait")).toBeUndefined();
  expect(closed).toBe(1);
  const scope = withCancel(BACKGROUND_CONTEXT);
  const api = {
    output: (s: string) => {
      stdout.push(s);
    },
    details: async (value: unknown) => {
      progress.push(value);
    },
    diagnostic: (diagnostic: unknown) => diagnostics.push(diagnostic),
  } as unknown as ToolExecutionApi;
  const call = tools.catalog.invoke("mcp__mock__wait", {}, api, scope.context);
  await entered.promise;
  scope.cancel();
  const result = await call;
  expect(result.isOk() && result.value.isError).toBe(true);
  expect(JSON.stringify(result)).toContain("cancelled");
  expect(closed).toBe(2);
  expect(progress).toContainEqual({ progress: 1, total: 2 });
  expect(stdout).toEqual([]);
  expect(diagnostics).toEqual([
    { severity: "info", code: "mcp_status", message: "MCP mock: unavailable." },
  ]);
  expect((await tools.close()).isOk()).toBe(true);
});

it("QuickJS completion cancels unawaited callbacks and cleanup joins them", async () => {
  const entered = barrier(),
    cancelled = barrier();
  const sandbox = new CodemodeSandbox({
    tools: [
      {
        name: "wait",
        execute: async (_args, { signal }) => {
          entered.resolve();
          await new Promise<void>((resolve) => {
            const done = () => {
              cancelled.resolve();
              resolve();
            };
            if (signal.aborted) done();
            else signal.addEventListener("abort", done, { once: true });
          });
          return null;
        },
      },
    ],
  });
  try {
    const result = await sandbox.execute('tools.wait({}); return "finished";');
    await entered.promise;
    await cancelled.promise;
    expect(result.ok).toBe(true);
  } finally {
    await sandbox.close();
  }
});
