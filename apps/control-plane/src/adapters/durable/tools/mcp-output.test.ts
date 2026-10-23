import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { okAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import { CallableCatalog } from "./catalog.ts";
import { McpTools } from "./mcp.ts";

function fixture(response: unknown) {
  const connect = vi.fn(() => {
    const { client, server } = createInMemoryTransportPair();
    server.onMessage((message) => {
      if (!("method" in message) || !("id" in message)) return;
      void server.send({
        jsonrpc: "2.0",
        id: message.id,
        result:
          message.method === "initialize"
            ? {
                protocolVersion: "2025-11-25",
                capabilities: { tools: {} },
                serverInfo: { name: "fixture", version: "1" },
              }
            : message.method === "tools/list"
              ? { tools: [{ name: "value", inputSchema: { type: "object" } }] }
              : response,
      });
    });
    void server.start();
    return okAsync(client);
  });
  const catalog = new CallableCatalog([]);
  const mcp = new McpTools([{ name: "fixture", connect }], catalog);
  return { mcp, catalog, connect };
}

it.each([{ n: 7 }, [1, null, "value"], null])(
  "returns native structured MCP results including %j",
  async (structuredContent) => {
    const response = {
      content: [{ type: "text", text: "reported failure" }],
      structuredContent,
      isError: true,
      _meta: { trace: "kept" },
    };
    const { mcp, catalog } = fixture(response);
    try {
      await mcp.discover(BACKGROUND_CONTEXT, "fixture");
      const tool = catalog.definitions().find((entry) => entry.name === "mcp__fixture__value")!;
      expect(tool).toHaveProperty("structuredOutputSchema");
      const result = await tool.execute({}, {} as ToolExecutionApi, BACKGROUND_CONTEXT);
      expect(result).toMatchObject({
        isError: true,
        output: response.content,
        structuredOutput: response,
      });
      expect(result).not.toHaveProperty("content");
      expect(result.details).toBeUndefined();
    } finally {
      await mcp.close();
    }
  },
);

it("rejects non-JSON MCP structured output at the adapter boundary", async () => {
  const { mcp, catalog } = fixture({
    content: [{ type: "text", text: "SECRET" }],
    structuredContent: { value: Number.NaN },
  });
  try {
    await mcp.discover(BACKGROUND_CONTEXT, "fixture");
    const tool = catalog.definitions().find((entry) => entry.name === "mcp__fixture__value")!;
    const result = await tool.execute({}, {} as ToolExecutionApi, BACKGROUND_CONTEXT);
    expect(result).toMatchObject({
      isError: true,
      diagnostics: [{ severity: "error", code: "invalid_response" }],
    });
    expect(result.structuredOutput).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("SECRET");
  } finally {
    await mcp.close();
  }
});

it("does not connect or change server availability for a cancelled MCP call", async () => {
  const { mcp, catalog, connect } = fixture({ content: [] });
  try {
    await mcp.discover(BACKGROUND_CONTEXT, "fixture");
    const tool = catalog.definitions().find((entry) => entry.name === "mcp__fixture__value")!;
    const scope = withCancel(BACKGROUND_CONTEXT);
    scope.cancel();
    const diagnostic = vi.fn();
    const result = await tool.execute(
      {},
      { diagnostic } as unknown as ToolExecutionApi,
      scope.context,
    );
    expect(result.isError).toBe(true);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(mcp.status()).toEqual([{ name: "fixture", status: "available" }]);
    expect(diagnostic).not.toHaveBeenCalled();
  } finally {
    await mcp.close();
  }
});

it("cancels before deferred broker acquisition without starting another connection", async () => {
  const { mcp, catalog, connect } = fixture({ content: [] });
  try {
    await mcp.discover(BACKGROUND_CONTEXT, "fixture");
    const tool = catalog.definitions().find((entry) => entry.name === "mcp__fixture__value")!;
    const scope = withCancel(BACKGROUND_CONTEXT);
    const pending = tool.execute({}, {} as ToolExecutionApi, scope.context);
    scope.cancel();
    expect((await pending).isError).toBe(true);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(mcp.status()).toEqual([{ name: "fixture", status: "available" }]);
  } finally {
    await mcp.close();
  }
});
