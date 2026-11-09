import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { CallableCatalog } from "./catalog.ts";
import { McpTools } from "./mcp.ts";

const definition = {
  name: "conversation",
  inputSchema: {
    type: "object" as const,
    properties: { message: { type: "string" }, conversation_id: { type: "string" } },
    required: ["message"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object" as const,
    properties: { conversation_id: { type: "string" } },
    required: ["conversation_id"],
  },
};

function provider(era: "modern" | "legacy", failure?: "404" | "header" | "input" | "delete404") {
  let connections = 0,
    closed = 0;
  const requests: string[] = [];
  const httpMethods: string[] = [];
  const calls: unknown[] = [];
  const catalog = new CallableCatalog([]);
  const mcp = new McpTools(
    [
      {
        name: "fixture",
        connect: () => {
          const connection = ++connections;
          const transport = new StreamableHTTPClientTransport(
            new URL("https://fixture.invalid/mcp"),
            {
              requestInit: { redirect: "error" },
              fetch: async (_url, init) => {
                httpMethods.push(init?.method ?? "GET");
                if (init?.method === "DELETE") {
                  expect(new Headers(init.headers).get("mcp-session-id")).toBe("legacy-session");
                  return new Response(null, {
                    status: failure === "delete404" && connection > 1 ? 404 : 204,
                  });
                }
                if (init?.method === "GET") return new Response(null, { status: 405 });
                const request = JSON.parse(String(init?.body));
                const { id, method, params } = request;
                requests.push(method);
                const reply = (result: unknown, headers?: Record<string, string>) =>
                  Response.json({ jsonrpc: "2.0", id, result }, headers ? { headers } : {});
                if (method === "server/discover") {
                  if (era === "legacy")
                    return Response.json({
                      jsonrpc: "2.0",
                      id,
                      error: { code: -32601, message: "Unsupported" },
                    });
                  return reply({
                    resultType: "complete",
                    supportedVersions: ["2026-07-28"],
                    capabilities: { tools: {} },
                  });
                }
                if (method === "initialize")
                  return reply(
                    {
                      protocolVersion: "2025-11-25",
                      capabilities: { tools: {} },
                      serverInfo: { name: "fixture", version: "1" },
                    },
                    { "mcp-session-id": "legacy-session" },
                  );
                if (method === "notifications/initialized")
                  return new Response(null, { status: 202 });
                if (method === "tools/list")
                  return reply({
                    ...(era === "modern"
                      ? { resultType: "complete", ttlMs: 0, cacheScope: "private" }
                      : {}),
                    tools: [definition],
                  });
                expect(method).toBe("tools/call");
                calls.push(params.arguments);
                if (failure === "404") return new Response("gone", { status: 404 });
                if (failure === "header")
                  return Response.json(
                    {
                      jsonrpc: "2.0",
                      id,
                      error: { code: -32020, message: "HEADER_MISMATCH SECRET" },
                    },
                    { status: 400 },
                  );
                if (failure === "input")
                  return reply({ resultType: "input_required", requestState: "SECRET" });
                return reply({
                  ...(era === "modern" ? { resultType: "complete" } : {}),
                  content: [],
                  structuredContent: { conversation_id: "provider-handle" },
                });
              },
            },
          );
          const close = transport.close.bind(transport);
          transport.close = async () => {
            closed++;
            await close();
          };
          return okAsync(transport);
        },
      },
    ],
    catalog,
  );
  return { mcp, catalog, requests, calls, httpMethods, counts: () => ({ connections, closed }) };
}

it("preserves a successful mutation acknowledgment and availability when session DELETE returns 404", async () => {
  const f = provider("legacy", "delete404");
  try {
    (await f.mcp.discover(BACKGROUND_CONTEXT))._unsafeUnwrap();
    const result = (
      await f.catalog.invoke(
        "mcp__fixture__conversation",
        { message: "effect" },
        {} as ToolExecutionApi,
        BACKGROUND_CONTEXT,
      )
    )._unsafeUnwrap();
    expect(result.isError).not.toBe(true);
    expect(result.structuredOutput).toEqual({
      content: [],
      structuredContent: { conversation_id: "provider-handle" },
    });
    expect(f.calls).toEqual([{ message: "effect" }]);
    expect(f.mcp.status()).toEqual([{ name: "fixture", status: "available" }]);
    expect(f.httpMethods.filter((method) => method === "DELETE")).toHaveLength(2);
    expect(f.counts()).toEqual({ connections: 2, closed: 2 });
  } finally {
    await f.mcp.close();
  }
});

it.each(["modern", "legacy"] as const)(
  "does not replay %s business calls after 404",
  async (era) => {
    const f = provider(era, "404");
    try {
      (await f.mcp.discover(BACKGROUND_CONTEXT))._unsafeUnwrap();
      const result = (
        await f.catalog.invoke(
          "mcp__fixture__conversation",
          { message: "effect" },
          {} as ToolExecutionApi,
          BACKGROUND_CONTEXT,
        )
      )._unsafeUnwrap();
      expect(result.isError).toBe(true);
      expect(f.calls).toEqual([{ message: "effect" }]);
      expect(f.counts()).toEqual({ connections: 2, closed: 2 });
      expect(f.requests.filter((method) => method === "tools/call")).toHaveLength(1);
      if (era === "legacy") {
        expect(f.httpMethods.filter((method) => method === "DELETE")).toHaveLength(2);
        expect(f.requests.filter((method) => method === "initialize")).toHaveLength(2);
      }
    } finally {
      await f.mcp.close();
    }
  },
);

it.each(["header", "input"] as const)(
  "fails modern %s responses without business replay or application-state handling",
  async (failure) => {
    const f = provider("modern", failure);
    try {
      (await f.mcp.discover(BACKGROUND_CONTEXT))._unsafeUnwrap();
      const tool = f.catalog
        .definitions()
        .find((tool) => tool.name === "mcp__fixture__conversation")!;
      const result = await tool.execute(
        { message: "effect" },
        {} as ToolExecutionApi,
        BACKGROUND_CONTEXT,
      );
      expect(result.isError).toBe(true);
      expect(result.structuredOutput).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain("SECRET");
      expect(f.calls).toEqual([{ message: "effect" }]);
      expect(f.requests).toEqual([
        "server/discover",
        "tools/list",
        "server/discover",
        "tools/call",
      ]);
      expect(f.counts()).toEqual({ connections: 2, closed: 2 });
    } finally {
      await f.mcp.close();
    }
  },
);
