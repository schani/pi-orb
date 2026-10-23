import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { createDurableTools } from "./index.ts";
import { openCodemodeHarness } from "./testkit/codemode.ts";

it("discovers resources-only servers without tools/list and preserves namespace guidance", async () => {
  const methods: string[] = [];
  const bundle = createDurableTools({
    mcp: [
      {
        name: "docs",
        connect: () => {
          const { client, server } = createInMemoryTransportPair();
          server.onMessage((m) => {
            if (!("method" in m) || !("id" in m)) return;
            methods.push(m.method);
            void server.send({
              jsonrpc: "2.0",
              id: m.id,
              result:
                m.method === "initialize"
                  ? {
                      protocolVersion: "2025-11-25",
                      capabilities: { resources: {} },
                      serverInfo: { name: "docs", version: "1" },
                      instructions: "Resolve project before reading",
                    }
                  : m.method === "resources/list"
                    ? { resources: [{ uri: "doc:a", name: "a" }] }
                    : m.method === "resources/templates/list"
                      ? { resourceTemplates: [] }
                      : { contents: [{ uri: "doc:a", text: "body" }] },
            });
          });
          void server.start();
          return okAsync(client);
        },
      },
    ],
  });
  try {
    expect((await bundle.ready()).isOk()).toBe(true);
    expect(methods).not.toContain("tools/list");
    const fixture = await openCodemodeHarness(bundle.catalog);
    try {
      const discovery = await fixture.run('return (await describeNamespace("docs")).instructions;');
      expect(discovery.isError).toBe(false);
      expect(discovery.output).toContainEqual({
        type: "text",
        text: "Resolve project before reading",
      });
    } finally {
      await fixture.close();
    }
    const listed = await bundle.catalog.invoke(
      "list_mcp_resources",
      {},
      {} as ToolExecutionApi,
      BACKGROUND_CONTEXT,
    );
    expect(listed.isOk()).toBe(true);
    if (listed.isOk())
      expect(listed.value.structuredOutput).toEqual({
        resources: [{ server: "docs", uri: "doc:a", name: "a" }],
      });
    const read = await bundle.catalog.invoke(
      "read_mcp_resource",
      { server: "docs", uri: "doc:a" },
      {} as ToolExecutionApi,
      BACKGROUND_CONTEXT,
    );
    expect(read.isOk()).toBe(true);
    if (read.isOk())
      expect(read.value.structuredOutput).toEqual({
        server: "docs",
        uri: "doc:a",
        contents: [{ uri: "doc:a", text: "body" }],
      });
  } finally {
    await bundle.close();
  }
});
