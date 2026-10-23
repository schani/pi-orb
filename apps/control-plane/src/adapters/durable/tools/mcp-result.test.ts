import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { createDurableTools } from "./index.ts";
import { openCodemodeHarness } from "./testkit/codemode.ts";

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
  let fixture: Awaited<ReturnType<typeof openCodemodeHarness>> | undefined;
  try {
    await bundle.discover(BACKGROUND_CONTEXT, "case");
    fixture = await openCodemodeHarness(bundle.catalog);
    const declaration = await fixture.run('return await describeTool("mcp__case__value");');
    expect(declaration.isError).toBe(false);
    expect(JSON.stringify(declaration.output)).toContain("structuredContent");
    const result = await fixture.run(
      "const r=await tools.mcp__case__value({}); text({n:r.structuredContent.n,error:r.isError,trace:r._meta.trace});",
    );
    expect(result.isError).toBe(false);
    expect(result.output).toContainEqual({
      type: "text",
      text: '{"n":7,"error":true,"trace":"kept"}',
    });
    expect(JSON.stringify(result.details)).toContain('"status":"error"');
  } finally {
    await fixture?.close();
    await bundle.close();
  }
});
