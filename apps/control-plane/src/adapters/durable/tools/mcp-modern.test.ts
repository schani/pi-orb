import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  SERVER_INFO_META_KEY,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { CallableCatalog } from "./catalog.ts";
import { McpTools } from "./mcp.ts";
import { openCodemodeHarness } from "./testkit/codemode.ts";

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

function provider(
  era: "modern" | "legacy",
  failure?: "404" | "lost" | "header" | "conflict" | "input" | "invalid",
) {
  let connections = 0,
    closed = 0;
  const requests: {
    connection: number;
    method: string;
    params?: Record<string, unknown>;
    headers: Headers;
  }[] = [];
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
                  return new Response(null, { status: 204 });
                }
                if (init?.method === "GET") return new Response(null, { status: 405 });
                const request = JSON.parse(String(init?.body));
                const { id, method, params } = request;
                requests.push({ connection, method, params, headers: new Headers(init?.headers) });
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
                    instructions: "Pass conversation_id explicitly to continue.",
                    _meta: { [SERVER_INFO_META_KEY]: { name: "fixture", version: "1" } },
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
                if (failure === "lost") throw new TypeError("accepted but response lost SECRET");
                if (failure === "header" || failure === "conflict")
                  return Response.json(
                    {
                      jsonrpc: "2.0",
                      id,
                      error: { code: -32020, message: "HEADER_MISMATCH SECRET" },
                    },
                    { status: failure === "header" ? 400 : 409 },
                  );
                if (failure === "input")
                  return reply({ resultType: "input_required", requestState: "SECRET" });
                return reply({
                  ...(era === "modern" ? { resultType: "complete" } : {}),
                  content: [],
                  structuredContent: {
                    conversation_id: failure === "invalid" ? 7 : "provider-handle",
                  },
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

it("discovers 2026-07-28 sessionlessly and passes provider conversation handles explicitly across fresh clients", async () => {
  const f = provider("modern");
  let harness: Awaited<ReturnType<typeof openCodemodeHarness>> | undefined;
  try {
    (await f.mcp.discover(BACKGROUND_CONTEXT))._unsafeUnwrap();
    expect(f.mcp.status()).toEqual([{ name: "fixture", status: "available" }]);
    harness = await openCodemodeHarness(f.catalog);
    const discovery = await harness.run(
      'text(await describeNamespace("mcp__fixture")); text(await describeTool("mcp__fixture__conversation"));',
    );
    expect(JSON.stringify(discovery.output)).toContain("Pass conversation_id explicitly");
    const result = await harness.run(
      'const first = await tools.mcp__fixture__conversation({message:"first"}); text(await tools.mcp__fixture__conversation({message:"next",conversation_id:first.structuredContent.conversation_id})); text(await tools.mcp__fixture__conversation({message:"independent"}));',
    );
    expect(result.isError).toBe(false);
    expect(f.calls).toEqual([
      { message: "first" },
      { message: "next", conversation_id: "provider-handle" },
      { message: "independent" },
    ]);
    expect(f.counts()).toEqual({ connections: 4, closed: 4 });
    expect(f.httpMethods).not.toContain("DELETE");
    expect(f.httpMethods).not.toContain("GET");
    expect(f.requests.map((r) => r.method)).toEqual([
      "server/discover",
      "tools/list",
      "server/discover",
      "tools/call",
      "server/discover",
      "tools/call",
      "server/discover",
      "tools/call",
    ]);
    for (const request of f.requests) {
      expect(request.params?._meta).toMatchObject({
        [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
        [CLIENT_INFO_META_KEY]: { name: "pi-orb", version: "1" },
        [CLIENT_CAPABILITIES_META_KEY]: {},
      });
      expect(request.headers.has("mcp-session-id")).toBe(false);
    }
  } finally {
    await harness?.close();
    await f.mcp.close();
  }
});

it.each(["modern", "legacy"] as const)(
  "does not replay %s business calls after 404 or an accepted call with a lost response",
  async (era) => {
    for (const failure of ["404", "lost"] as const) {
      const f = provider(era, failure);
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
        expect(JSON.stringify(result)).not.toContain("SECRET");
        expect(f.calls).toEqual([{ message: "effect" }]);
        expect(f.counts()).toEqual({ connections: 2, closed: 2 });
        expect(f.requests.filter((r) => r.method === "tools/call")).toHaveLength(1);
        if (era === "legacy") {
          expect(f.httpMethods.filter((method) => method === "DELETE")).toHaveLength(2);
          expect(f.requests.filter((r) => r.method === "initialize")).toHaveLength(2);
        }
      } finally {
        await f.mcp.close();
      }
    }
  },
);

it.each(["header", "conflict", "input", "invalid"] as const)(
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
      expect(f.requests.map((request) => request.method)).toEqual([
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
