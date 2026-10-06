import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  Harness,
  MemoryStorage,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { createDurableTools } from "./index.ts";

it("preserves MCP structuredContent/isError/metadata in script results and declared output types", async () => {
  const bundle = createDurableTools({
    mcp: [
      {
        name: "case",
        connect: () => {
          const { client, server } = createInMemoryTransportPair();
          server.onMessage((m) => {
            if (!("method" in m) || !("id" in m)) return;
            void server.send({
              jsonrpc: "2.0",
              id: m.id,
              result:
                m.method === "initialize"
                  ? {
                      protocolVersion: "2025-11-25",
                      capabilities: { tools: {} },
                      serverInfo: { name: "case", version: "1" },
                    }
                  : m.method === "tools/list"
                    ? {
                        tools: [
                          {
                            name: "value",
                            inputSchema: { type: "object" },
                            outputSchema: {
                              type: "object",
                              properties: { n: { type: "number" } },
                              required: ["n"],
                            },
                          },
                        ],
                      }
                    : {
                        content: [{ type: "text", text: "reported failure" }],
                        structuredContent: { n: 7 },
                        isError: true,
                        _meta: { trace: "kept" },
                      },
            });
          });
          void server.start();
          return okAsync(client);
        },
      },
    ],
  });
  const harness = await Harness.open(
    new MemoryStorage(),
    { models: createModels(), registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  try {
    await bundle.ready();
    expect(bundle.catalog.describe("mcp__case__value")).toContain("CallToolResult");
    const root = await harness.root(BACKGROUND_CONTEXT);
    const result = await bundle.modelTools[0].execute(
      {
        code: "const r=await tools.mcp__case__value({}); text({n:r.structuredContent.n,error:r.isError,trace:r._meta.trace});",
      },
      {
        conversationId: root.id,
        commit: root.commit.bind(root),
        callId: "call",
        details: async () => {},
        diagnostic: () => {},
      } as unknown as ToolExecutionApi,
      BACKGROUND_CONTEXT,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContainEqual({
      type: "text",
      text: '{"n":7,"error":true,"trace":"kept"}',
    });
    expect(JSON.stringify(result.details)).toContain('"status":"error"');
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
    await bundle.close();
  }
});
