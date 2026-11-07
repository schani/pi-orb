import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { InMemoryTransport } from "@modelcontextprotocol/client";
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
          const [client, server] = InMemoryTransport.createLinkedPair();
          server.onmessage = (m) => {
            if (!("method" in m) || !("id" in m)) return;
            if (m.method === "server/discover") {
              void server.send({
                jsonrpc: "2.0",
                id: m.id,
                error: { code: -32601, message: "Unsupported" },
              });
              return;
            }
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
          };
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
      const discovery = await fixture.run(
        'const ns = await describeNamespace("mcp__docs"); return JSON.stringify([ns.name, ns.instructions, ns.tools]);',
      );
      expect(discovery.isError).toBe(false);
      expect(discovery.output).toContainEqual({
        type: "text",
        text: JSON.stringify(["mcp__docs", "Resolve project before reading", []]),
      });
      const short = await fixture.run('return typeof await describeNamespace("docs");');
      expect(short.isError).toBe(false);
      expect.soft(short.output).toContainEqual({ type: "text", text: "undefined" });
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

it.each(["list_mcp_resources", "list_mcp_resource_templates"] as const)(
  "%s preserves explicit-server first pages and aggregates only unscoped requests",
  async (name) => {
    const key = name === "list_mcp_resources" ? "resources" : "resourceTemplates";
    const method = key === "resources" ? "resources/list" : "resources/templates/list";
    const pages: (string | undefined)[] = [];
    const item = (page: number) =>
      key === "resources"
        ? { uri: `doc:${page}`, name: String(page) }
        : { uriTemplate: `doc:${page}/{id}`, name: String(page) };
    const bundle = createDurableTools({
      mcp: [
        {
          name: "docs",
          connect: () => {
            const [client, server] = InMemoryTransport.createLinkedPair();
            server.onmessage = (message) => {
              if (!("method" in message) || !("id" in message)) return;
              if (message.method === "server/discover") {
                void server.send({
                  jsonrpc: "2.0",
                  id: message.id,
                  error: { code: -32601, message: "Unsupported" },
                });
                return;
              }
              if (message.method === "initialize") {
                void server.send({
                  jsonrpc: "2.0",
                  id: message.id,
                  result: {
                    protocolVersion: "2025-11-25",
                    capabilities: { resources: {} },
                    serverInfo: { name: "docs", version: "1" },
                  },
                });
                return;
              }
              expect(message.method).toBe(method);
              const cursor = (message.params as { cursor?: string } | undefined)?.cursor;
              pages.push(cursor);
              void server.send({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  [key]: [item(cursor ? 2 : 1)],
                  ...(cursor ? {} : { nextCursor: "next" }),
                },
              });
            };
            void server.start();
            return okAsync(client);
          },
        },
      ],
    });
    const invoke = async (args: unknown) =>
      (
        await bundle.catalog.invoke(name, args, {} as ToolExecutionApi, BACKGROUND_CONTEXT)
      )._unsafeUnwrap();
    try {
      (await bundle.ready())._unsafeUnwrap();
      expect((await invoke({ server: "docs" })).structuredOutput).toEqual({
        server: "docs",
        [key]: [{ server: "docs", ...item(1) }],
        nextCursor: "next",
      });
      expect(pages).toEqual([undefined]);
      expect((await invoke({ server: "docs", cursor: "next" })).structuredOutput).toEqual({
        server: "docs",
        [key]: [{ server: "docs", ...item(2) }],
      });
      expect(pages).toEqual([undefined, "next"]);
      expect((await invoke({})).structuredOutput).toEqual({
        [key]: [
          { server: "docs", ...item(1) },
          { server: "docs", ...item(2) },
        ],
      });
      expect(pages).toEqual([undefined, "next", undefined, "next"]);
      expect((await invoke({ cursor: "next" })).isError).toBe(true);
      expect(pages).toHaveLength(4);
    } finally {
      await bundle.close();
    }
  },
);
