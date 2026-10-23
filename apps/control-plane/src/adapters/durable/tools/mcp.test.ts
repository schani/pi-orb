import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  defineTool,
  Harness,
  hook,
  MemoryStorage,
  type ToolExecutionApi,
  type ToolExecutionResult,
  ToolTask,
} from "@earendil-works/pi-durable";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { errAsync, okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { CallableCatalog } from "./catalog.ts";
import { createDurableTools } from "./index.ts";
import { McpTools } from "./mcp.ts";
import { openCodemodeHarness } from "./testkit/codemode.ts";

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
    await tools.discover(BACKGROUND_CONTEXT, "broken");
    const ready = await tools.discover(BACKGROUND_CONTEXT, "healthy");
    expect(ready.isOk()).toBe(true);
    expect(JSON.stringify(ready)).not.toContain("secret-token");
    const fixture = await openCodemodeHarness(tools.catalog);
    try {
      const discovery = await fixture.run(
        'return typeof await describeTool("mcp__healthy__ping");',
      );
      expect(discovery.isError).toBe(false);
      expect(discovery.output).toContainEqual({ type: "text", text: "string" });
    } finally {
      await fixture.close();
    }
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
  const stages: { connection: number; method: string; arguments?: unknown }[] = [];
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
          const connection = ++auth;
          stages.push({ connection, method: "connect" });
          const { client, server } = createInMemoryTransportPair();
          server.onMessage((message) => {
            if (!("method" in message) || !("id" in message)) return;
            stages.push({
              connection,
              method: message.method,
              ...(message.method === "tools/call"
                ? { arguments: (message.params as { arguments?: unknown })?.arguments }
                : {}),
            });
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
  expect((await tools.discover(BACKGROUND_CONTEXT, "mock")).isOk()).toBe(true);
  expect(auth).toBe(1);
  expect(effects).toBe(0);
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("codemode", {
        code: 'try {await tools.mcp__mock__echo({value:42});} catch(e) {text("validated");} const r = await tools.mcp__mock__echo({value:"error"}); text(r.isError); text(r.content[0].text); text(await describeTool("mcp__mock__echo"));',
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("done"),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  let result: ToolExecutionResult | undefined;
  registry.install({
    ...tools.extension,
    tools: tools.extension.tools!.map((tool) =>
      tool.name !== "codemode"
        ? tool
        : defineTool({
            ...tool,
            execute: async (args, api, context) => {
              result = await tool.execute(args, api, context);
              return result;
            },
          }),
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
    expect(JSON.stringify(records.items)).toContain("validated");
    expect(JSON.stringify(records.items)).toContain("error");
    expect(auth, JSON.stringify(stages.slice(0, 16))).toBe(2);
    expect(result?.isError).toBe(false);
    expect(JSON.stringify(result?.output)).toContain("validated");
    expect(JSON.stringify(result?.output)).toContain("error");
    expect(effects).toBe(1);
    expect(stages.filter((stage) => stage.method === "tools/call")).toEqual([
      { connection: 2, method: "tools/call", arguments: { value: "error" } },
    ]);
    expect(permits).toContain("mcp__mock__echo");
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
    expect((await tools.close()).isOk()).toBe(true);
  }
});

it("rejects explicit null for parameterless MCP tools before hooks, authorization and credentials", async () => {
  const canary = "NULL_MCP_ARGUMENT_CANARY_SECRET";
  let credentials = 0,
    authorizations = 0,
    hooks = 0;
  const calls: unknown[] = [];
  const inputSchema = { type: "object", properties: {}, additionalProperties: false };
  const catalog = new CallableCatalog([], () => {
    authorizations++;
    return okAsync(undefined);
  });
  const mcp = new McpTools(
    [
      {
        name: "fixture",
        connect: () => {
          credentials++;
          const { client, server } = createInMemoryTransportPair();
          server.onMessage((message) => {
            if (!("method" in message) || !("id" in message)) return;
            const respond = (result: unknown) =>
              server.send({ jsonrpc: "2.0", id: message.id, result });
            if (message.method === "initialize")
              void respond({
                protocolVersion: "2025-11-25",
                capabilities: { tools: {} },
                serverInfo: { name: "fixture", version: "1" },
              });
            if (message.method === "tools/list")
              void respond({ tools: [{ name: "ping", inputSchema }] });
            if (message.method === "tools/call") {
              calls.push((message.params as { arguments: unknown }).arguments);
              void respond({ content: [{ type: "text", text: "pong" }] });
            }
          });
          void server.start();
          return okAsync(client);
        },
      },
    ],
    catalog,
  );
  try {
    expect((await mcp.discover(BACKGROUND_CONTEXT, "fixture")).isOk()).toBe(true);
    expect(credentials).toBe(1);
    expect(
      catalog.definitions().find((tool) => tool.name === "mcp__fixture__ping")?.parameters,
    ).toEqual(inputSchema);
    const fixture = await openCodemodeHarness(catalog, {
      hooks: [
        hook(ToolTask, {
          beforeTool: (call) => {
            if (call.name === "mcp__fixture__ping") hooks++;
          },
        }),
      ],
    });
    try {
      for (const caught of [false, true]) {
        const source = "await tools.mcp__fixture__ping(null);";
        const result = await fixture.run(
          `const privateCanary = ${JSON.stringify(canary)}; ` +
            (caught ? `try { ${source} } catch (error) { text(String(error)); }` : source),
        );
        expect(result.isError).toBe(!caught);
        expect(JSON.stringify(result.output)).toContain("Invalid arguments for mcp__fixture__ping");
        for (const visible of [result.output, result.details, result.diagnostics])
          expect(JSON.stringify(visible) ?? "").not.toContain(canary);
        expect(authorizations).toBe(0);
        expect(credentials).toBe(1);
        expect(calls).toEqual([]);
        expect(hooks).toBe(0);
      }
      for (const [index, args] of ["{}", "", "undefined"].entries()) {
        const result = await fixture.run(`text(await tools.mcp__fixture__ping(${args}));`);
        expect(result.isError).toBe(false);
        expect(JSON.stringify(result.output)).toContain("pong");
        expect(authorizations).toBe(index + 1);
        expect(credentials).toBe(index + 2);
        expect(calls).toEqual(Array.from({ length: index + 1 }, () => ({})));
        expect(hooks).toBe(index + 1);
      }
    } finally {
      await fixture.close();
    }
  } finally {
    await mcp.close();
  }
});

it("rejects raw MCP arguments before native coercion, hooks, authorization and credentials", async () => {
  const canary = "RAW_MCP_ARGUMENT_CANARY_SECRET";
  let credentials = 0,
    authorizations = 0,
    hooks = 0;
  const calls: unknown[] = [];
  const inputSchema = {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  };
  const catalog = new CallableCatalog([], () => {
    authorizations++;
    return okAsync(undefined);
  });
  const mcp = new McpTools(
    [
      {
        name: "strict",
        connect: () => {
          credentials++;
          const { client, server } = createInMemoryTransportPair();
          server.onMessage((message) => {
            if (!("method" in message) || !("id" in message)) return;
            const respond = (result: unknown) =>
              server.send({ jsonrpc: "2.0", id: message.id, result });
            if (message.method === "initialize")
              void respond({
                protocolVersion: "2025-11-25",
                capabilities: { tools: {} },
                serverInfo: { name: "strict", version: "1" },
              });
            if (message.method === "tools/list")
              void respond({ tools: [{ name: "echo", inputSchema }] });
            if (message.method === "tools/call") {
              const args = (message.params as { arguments: unknown }).arguments;
              calls.push(args);
              void respond({ content: [{ type: "text", text: "accepted" }] });
            }
          });
          void server.start();
          return okAsync(client);
        },
      },
    ],
    catalog,
  );
  try {
    expect((await mcp.discover(BACKGROUND_CONTEXT, "strict")).isOk()).toBe(true);
    expect(credentials).toBe(1);
    expect(
      catalog.definitions().find((tool) => tool.name === "mcp__strict__echo")?.parameters,
    ).toEqual(inputSchema);
    const fixture = await openCodemodeHarness(catalog, {
      hooks: [
        hook(ToolTask, {
          beforeTool: (call) => {
            if (call.name === "mcp__strict__echo") hooks++;
          },
        }),
      ],
    });
    try {
      const invalid = [
        { value: 42 },
        { value: [canary] },
        { value: "ok", extra: canary },
        [canary],
        null,
      ];
      for (const args of invalid) {
        const source = `await tools.mcp__strict__echo(${JSON.stringify(args)});`;
        for (const caught of [false, true]) {
          const result = await fixture.run(
            caught ? `try { ${source} } catch (error) { text(String(error)); }` : source,
          );
          expect(result.isError).toBe(!caught);
          expect(JSON.stringify(result.output)).toContain(
            "Invalid arguments for mcp__strict__echo",
          );
          for (const visible of [result.output, result.details, result.diagnostics])
            expect(JSON.stringify(visible) ?? "").not.toContain(canary);
          expect(authorizations).toBe(0);
          expect(credentials).toBe(1);
          expect(calls).toEqual([]);
          expect(hooks).toBe(0);
        }
      }
      const valid = await fixture.run('text(await tools.mcp__strict__echo({value:"exact"}));');
      expect(valid.isError).toBe(false);
      expect(JSON.stringify(valid.output)).toContain("accepted");
      expect(authorizations).toBe(1);
      expect(credentials).toBe(2);
      expect(calls).toEqual([{ value: "exact" }]);
      expect(hooks).toBe(1);
    } finally {
      await fixture.close();
    }
  } finally {
    await mcp.close();
  }
});

it("discovers oversized MCP arguments and safely explains missing required fields", async () => {
  let effects = 0;
  const tools = createDurableTools({
    mcp: [
      {
        name: "posthog",
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
                serverInfo: { name: "fixture", version: "1" },
              });
            if (message.method === "tools/list")
              void respond({
                tools: [
                  {
                    name: "exec",
                    inputSchema: {
                      type: "object",
                      properties: {
                        command: { type: "string", description: "x".repeat(40_000) },
                        context: { type: "string" },
                        llm_model: { type: "string" },
                        conversation_id: { type: "string" },
                      },
                      required: ["command", "context", "llm_model"],
                    },
                  },
                ],
              });
            if (message.method === "tools/call") {
              effects++;
              void respond({ content: [{ type: "text", text: "ok" }] });
            }
          });
          void server.start();
          return okAsync(client);
        },
      },
    ],
  });
  try {
    expect((await tools.discover(BACKGROUND_CONTEXT, "posthog")).isOk()).toBe(true);
    const fixture = await openCodemodeHarness(tools.catalog);
    try {
      const invalid = await fixture.run(
        'try { await tools.mcp__posthog__exec({command:"secret-command-value"}); } catch(e) { text(e.message); }',
      );
      expect(invalid.isError).toBe(false);
      expect(invalid.output).toContainEqual({
        type: "text",
        text: 'Invalid arguments for mcp__posthog__exec. Missing required fields: "context", "llm_model"',
      });
      expect(JSON.stringify(invalid.output)).not.toContain("secret-command-value");
      expect(effects).toBe(0);
      const declaration = await fixture.run('return await describeTool("mcp__posthog__exec");');
      const rendered = JSON.stringify(declaration.output);
      for (const field of [
        "command: string",
        "context: string",
        "llm_model: string",
        "conversation_id?: string",
      ])
        expect(rendered).toContain(field);
      const valid = await fixture.run(
        'const r = await tools.mcp__posthog__exec({command:"help",context:"diagnosing invocation",llm_model:"unknown"}); text(r.content[0].text);',
      );
      expect(valid.isError).toBe(false);
      expect(valid.output).toContainEqual({ type: "text", text: "ok" });
      expect(effects).toBe(1);
    } finally {
      await fixture.close();
    }
  } finally {
    await tools.close();
  }
});
