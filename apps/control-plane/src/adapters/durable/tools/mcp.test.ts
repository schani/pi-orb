import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  Harness,
  MemoryStorage,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { errAsync, okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { refreshProcessMcpTool } from "../../../process-agent-composition.ts";
import { projectHistory } from "../projection.ts";
import { createDurableTools } from "./index.ts";

it("projects authorization-required diagnostics into durable user-visible history", async () => {
  const tools = createDurableTools();
  await tools.ready();
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("codemode", { code: 'text("not authorized")' }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("done"),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install({
    ...tools.extension,
    tools: (tools.extension.tools ?? []).map((tool) =>
      tool.name === "codemode"
        ? refreshProcessMcpTool(tool, () =>
            okAsync([
              {
                name: "fixture",
                status: "needs-auth",
                error: { code: "forbidden", message: "secret" },
              },
            ]),
          )
        : tool,
    ),
  });
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
  try {
    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: "faux", modelId: "faux-1" } },
    });
    harness.resume();
    await (await root.submit({ type: "input", content: "go" }, BACKGROUND_CONTEXT)).wait(
      BACKGROUND_CONTEXT,
    );
    const records = await root.entries({}, 100, undefined, BACKGROUND_CONTEXT);
    const history = projectHistory(records.items, "session");
    expect(history.isOk()).toBe(true);
    expect(JSON.stringify(history)).toContain("MCP fixture: needs-auth.");
    expect(JSON.stringify(history)).not.toContain("secret");
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
    await tools.close();
  }
});

it("retries authorization-required discovery after consent and exposes sanitized status", async () => {
  let authorized = false;
  let connections = 0;
  const tools = createDurableTools({
    mcp: [
      {
        name: "fixture",
        unavailableState: () => (authorized ? "unavailable" : "needs-auth"),
        connect: () => {
          connections++;
          if (!authorized) return errAsync({ code: "forbidden", message: "secret credential" });
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
                  : { tools: [{ name: "read", inputSchema: { type: "object" } }] },
            });
          });
          void server.start();
          return okAsync(client);
        },
      },
    ],
  });
  try {
    await tools.ready();
    expect(tools.mcpStatus()).toEqual([
      {
        name: "fixture",
        status: "needs-auth",
        error: { code: "forbidden", message: "MCP server unavailable" },
      },
    ]);
    authorized = true;
    await tools.ready();
    expect(tools.mcpStatus()).toEqual([{ name: "fixture", status: "available" }]);
    expect(tools.catalog.describe("mcp__fixture__read")).not.toBeNull();
    await tools.ready();
    expect(connections).toBe(2);
  } finally {
    await tools.close();
  }
});

it("reports a failed MCP server without blocking healthy discovery and calls", async () => {
  let healthyCalls = 0;
  const tools = createDurableTools({
    mcp: [
      {
        name: "broken",
        connect: () => errAsync({ code: "forbidden", message: "secret-token=unsafe" }),
      },
      {
        name: "healthy",
        connect: () => {
          const { client, server } = createInMemoryTransportPair();
          server.onMessage((message) => {
            if (!("method" in message) || !("id" in message)) return;
            const respond = (result: unknown) =>
              server.send({ jsonrpc: "2.0", id: message.id, result });
            if (message.method === "initialize")
              void respond({
                protocolVersion: "2025-11-25",
                capabilities: { tools: {} },
                serverInfo: { name: "healthy", version: "1" },
              });
            if (message.method === "tools/list")
              void respond({
                tools: [
                  {
                    name: "ping",
                    inputSchema: { type: "object", additionalProperties: false },
                  },
                ],
              });
            if (message.method === "tools/call") {
              healthyCalls++;
              void respond({ content: [{ type: "text", text: "pong" }] });
            }
          });
          void server.start();
          return okAsync(client);
        },
      },
    ],
  });
  try {
    const ready = await tools.ready();
    expect(ready.isOk()).toBe(true);
    expect(JSON.stringify(ready)).not.toContain("secret-token");
    expect(tools.catalog.describe("mcp__healthy__ping")).not.toBeNull();
    const api = {} as ToolExecutionApi;
    const status = await tools.catalog.invoke("mcp_status", {}, api, BACKGROUND_CONTEXT);
    expect(status.isOk()).toBe(true);
    if (status.isOk()) {
      const text = JSON.stringify(status.value);
      expect(text).toContain("broken");
      expect(text).toContain("unavailable");
      expect(text).toContain("healthy");
      expect(text).toContain("available");
      expect(text).not.toContain("secret-token");
    }
    const call = await tools.catalog.invoke("mcp__healthy__ping", {}, api, BACKGROUND_CONTEXT);
    expect(call.isOk()).toBe(true);
    expect(healthyCalls).toBe(1);
  } finally {
    await tools.close();
  }
});

it("discovers MCP, executes validated QuickJS calls with fresh scoped connections, forwards progress and errors", async () => {
  let auth = 0;
  let effects = 0;
  const permits: string[] = [];
  const tools = createDurableTools({
    authorize: (name) => {
      permits.push(name);
      return okAsync(undefined);
    },
    mcp: [
      {
        name: "mock",
        connect: () => {
          auth++;
          const { client, server } = createInMemoryTransportPair();
          server.onMessage((message) => {
            if (!("method" in message) || !("id" in message)) return;
            const respond = (result: unknown) =>
              server.send({ jsonrpc: "2.0", id: message.id, result });
            if (message.method === "initialize")
              void respond({
                protocolVersion: "2025-11-25",
                capabilities: { tools: {} },
                serverInfo: { name: "mock", version: "1" },
              });
            if (message.method === "tools/list")
              void respond({
                tools: [
                  {
                    name: "echo",
                    description: "echo",
                    inputSchema: {
                      type: "object",
                      properties: { value: { type: "string" } },
                      required: ["value"],
                      additionalProperties: false,
                    },
                  },
                ],
              });
            if (message.method === "tools/call") {
              effects++;
              const params = message.params as {
                arguments: { value: string };
                _meta?: { progressToken?: string | number };
              };
              if (params._meta?.progressToken !== undefined)
                void server.send({
                  jsonrpc: "2.0",
                  method: "notifications/progress",
                  params: { progressToken: params._meta.progressToken, progress: 1, total: 1 },
                });
              void respond({
                isError: params.arguments.value === "error",
                content: [{ type: "text", text: params.arguments.value }],
              });
            }
          });
          void server.start();
          return okAsync(client);
        },
      },
    ],
  });
  expect((await tools.ready()).isOk()).toBe(true);
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("codemode", {
        code: 'try {await tools.mcp__mock__echo({value:42});} catch(e) {text("validated");} const r = await tools.mcp__mock__echo({value:"error"}); text(r.isError); text(r.content[0].text); text(describeTool("mcp__mock__echo"));',
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("done"),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(tools.extension);
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
  try {
    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: "faux", modelId: "faux-1" } },
    });
    harness.resume();
    await (await root.submit({ type: "input", content: "go" }, BACKGROUND_CONTEXT)).wait(
      BACKGROUND_CONTEXT,
    );
    const records = await root.entries({}, 100, undefined, BACKGROUND_CONTEXT);
    expect(JSON.stringify(records.items)).toContain("validated");
    expect(JSON.stringify(records.items)).toContain("error");
    expect(auth).toBe(2);
    expect(effects).toBe(1);
    expect(permits).toContain("mcp__mock__echo");
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
    expect((await tools.close()).isOk()).toBe(true);
  }
});
