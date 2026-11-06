import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { okAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import { CallableCatalog } from "./catalog.ts";
import { McpTools } from "./mcp.ts";

function fixture(
  response: unknown,
  era: "modern" | "legacy" = "modern",
  outputSchema?: Record<string, unknown>,
) {
  const connect = vi.fn(() => {
    const [client, server] = InMemoryTransport.createLinkedPair();
    server.onmessage = (message) => {
      if (!("method" in message) || !("id" in message)) return;
      if (message.method === "server/discover" && era === "legacy") {
        void server.send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Unsupported" },
        });
        return;
      }
      void server.send({
        jsonrpc: "2.0",
        id: message.id,
        result:
          message.method === "server/discover"
            ? {
                resultType: "complete",
                supportedVersions: ["2026-07-28"],
                capabilities: { tools: {} },
              }
            : message.method === "initialize"
              ? {
                  protocolVersion: "2025-11-25",
                  capabilities: { tools: {} },
                  serverInfo: { name: "fixture", version: "1" },
                }
              : message.method === "tools/list"
                ? {
                    ...(era === "modern"
                      ? { resultType: "complete", ttlMs: 0, cacheScope: "private" }
                      : {}),
                    tools: [
                      {
                        name: "value",
                        inputSchema: { type: "object" },
                        ...(outputSchema ? { outputSchema } : {}),
                      },
                    ],
                  }
                : {
                    ...(era === "modern" ? { resultType: "complete" } : {}),
                    ...(response as Record<string, unknown>),
                  },
      });
    };
    void server.start();
    return okAsync(client);
  });
  const catalog = new CallableCatalog([]);
  const mcp = new McpTools([{ name: "fixture", connect }], catalog);
  return { mcp, catalog, connect };
}

it.each([{ n: 7 }, [1, null, "value"], null].map((structuredContent) => ({ structuredContent })))(
  "returns native structured MCP results including %j",
  async ({ structuredContent }) => {
    const response = {
      content: [{ type: "text", text: "reported failure" }],
      structuredContent,
      isError: true,
      _meta: { trace: "kept" },
    };
    const { mcp, catalog } = fixture(response);
    try {
      await mcp.discover(BACKGROUND_CONTEXT);
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
    await mcp.discover(BACKGROUND_CONTEXT);
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
    await mcp.discover(BACKGROUND_CONTEXT);
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
    await mcp.discover(BACKGROUND_CONTEXT);
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

it.each([[1, null, "value"], null].map((structuredContent) => ({ structuredContent })))(
  "rejects malformed legacy structuredContent %j without wrapping or leaking it",
  async ({ structuredContent }) => {
    const { mcp, catalog } = fixture(
      { content: [{ type: "text", text: "SECRET" }], structuredContent },
      "legacy",
    );
    try {
      (await mcp.discover(BACKGROUND_CONTEXT))._unsafeUnwrap();
      const result = (
        await catalog.invoke("mcp__fixture__value", {}, {} as ToolExecutionApi, BACKGROUND_CONTEXT)
      )._unsafeUnwrap();
      expect(result.isError).toBe(true);
      expect(result.structuredOutput).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain("SECRET");
    } finally {
      await mcp.close();
    }
  },
);

it.each([
  {
    structuredContent: [1, null, "value"],
    outputSchema: {
      type: "array",
      items: { anyOf: [{ type: "number" }, { type: "null" }, { type: "string" }] },
    },
  },
  { structuredContent: null, outputSchema: { type: "null" } },
])(
  "validates successful modern structured output against its non-object schema: $outputSchema.type",
  async ({ structuredContent, outputSchema }) => {
    const response = { content: [], structuredContent, isError: false };
    const { mcp, catalog } = fixture(response, "modern", outputSchema);
    try {
      (await mcp.discover(BACKGROUND_CONTEXT))._unsafeUnwrap();
      const result = (
        await catalog.invoke("mcp__fixture__value", {}, {} as ToolExecutionApi, BACKGROUND_CONTEXT)
      )._unsafeUnwrap();
      expect(result.isError).toBe(false);
      expect(result.structuredOutput).toEqual(response);
      expect(result.output).toEqual([
        { type: "text", text: JSON.stringify(structuredContent, null, 2) },
      ]);
    } finally {
      await mcp.close();
    }
  },
);
