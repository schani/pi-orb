import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import {
  createRegistry,
  defineTool,
  Harness,
  MemoryStorage,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { CallableCatalog } from "./catalog.ts";
import { codemodeTool } from "./codemode.ts";
import { createDurableTools } from "./index.ts";
import { createOrbTools } from "./orb-tools.ts";

it("advertises discovered resources-only instructions in ready and actual provider metadata", async () => {
  let connections = 0;
  const bundle = createDurableTools({
    mcp: [
      {
        name: "docs",
        connect: () => {
          const instructions =
            ++connections === 1
              ? "Resolve project before reading"
              : connections === 2
                ? "Use refreshed project guidance"
                : "Latest project guidance";
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
                      capabilities: { resources: {} },
                      serverInfo: { name: "docs", version: "1" },
                      instructions,
                    }
                  : { resources: [], resourceTemplates: [] },
            });
          });
          void server.start();
          return okAsync(client);
        },
      },
    ],
  });
  let harness: Harness | undefined;
  try {
    expect((await bundle.ready()).isOk()).toBe(true);
    expect(bundle.modelTools[0].description).toContain("docs");
    expect(bundle.modelTools[0].description).toContain("Resolve project before reading");
    const registry = createRegistry();
    registry.install(bundle.extension);
    const faux = fauxProvider();
    let metadata = "";
    faux.setResponses([
      async (request) => {
        metadata = JSON.stringify(request.messages.filter((m) => m.role === "system"));
        return fauxAssistantMessage("done");
      },
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
    const root = await harness.root(ctx, {
      agent: { model: { provider: "faux", modelId: "faux-1" }, tools: bundle.modelTools },
    });
    harness.resume();
    await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
    expect(metadata).toContain("Resolve project before reading");
    expect(bundle.catalog.definitions().some((t) => t.name === "subagent")).toBe(true);
    const resources = await bundle.catalog.invoke(
      "list_mcp_resources",
      {},
      {} as ToolExecutionApi,
      ctx,
    );
    expect(resources.isOk()).toBe(true);
    expect(bundle.catalog.describeNamespace("docs")?.instructions).toBe(
      "Use refreshed project guidance",
    );
    const refreshed = await bundle.modelTools[0].execute(
      { code: 'await tools.list_mcp_resources({}); text(await describeNamespace("docs"));' },
      {
        conversationId: root.id,
        commit: root.commit.bind(root),
        callId: "refresh",
        details: async () => {},
        diagnostic: () => {},
      } as unknown as ToolExecutionApi,
      ctx,
    );
    expect(JSON.stringify(refreshed.content)).toContain("Latest project guidance");
  } finally {
    await harness?.close(ctx);
    await bundle.close();
  }
});

it("preserves execution wait in UI details without exposing nested stdout to the model", async () => {
  const harness = await Harness.open(
    new MemoryStorage(),
    { models: createModels(), registry: createRegistry() },
    ctx,
  );
  const root = await harness.root(ctx);
  const updates: unknown[] = [];
  const stdout: unknown[] = [];
  const tool = codemodeTool(
    new CallableCatalog([
      defineTool({
        name: "wait",
        description: "wait",
        parameters: Type.Object({}),
        execute: async (_args, api) => {
          await api.details({ executionWait: true }, ctx);
          api.output("private nested stdout");
          await api.details({ executionWait: false }, ctx);
          return {};
        },
      }),
    ]),
    new Set(),
  );
  try {
    const result = await tool.execute(
      { code: 'await tools.wait({}); text("filtered");' },
      {
        conversationId: root.id,
        commit: root.commit.bind(root),
        callId: "outer",
        output: (s: string | Uint8Array) => stdout.push(s),
        details: async (d: JsonValue) => {
          updates.push(d);
        },
        diagnostic: () => {},
      } as unknown as ToolExecutionApi,
      ctx,
    );
    expect(updates).toContainEqual(
      expect.objectContaining({
        executionWait: true,
        calls: [expect.objectContaining({ executionWait: true })],
      }),
    );
    expect(updates.at(-1)).toMatchObject({ executionWait: false });
    expect(JSON.stringify(result.content)).not.toContain("private nested stdout");
    expect(stdout).toEqual([]);
  } finally {
    await harness.close(ctx);
  }
});

it("limits empty output items and cancels outstanding callbacks through the real public worker", async () => {
  let cancelled = false;
  const sandbox = new CodemodeSandbox({
    memoryLimitBytes: 16 * 1024 * 1024,
    workerUrl: new URL("./bounded-worker.js", import.meta.url),
    tools: [
      {
        name: "hold",
        execute: (_args, { signal }) =>
          new Promise((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                cancelled = true;
                resolve(undefined);
              },
              { once: true },
            );
          }),
      },
    ],
  });
  try {
    const result = await sandbox.execute(
      'tools.hold({}); image({type:"image",data:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jg9sAAAAASUVORK5CYII=",mimeType:"image/png"}); for(let i=0;i<4100;i++) text("");',
    );
    expect(result.ok).toBe(false);
    expect(result.output.length).toBe(4096);
    expect(result.output[0]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(cancelled).toBe(true);
  } finally {
    await sandbox.close();
  }
});

it("declares and returns native JSON text as strings, not object schemas", async () => {
  const harness = await Harness.open(
    new MemoryStorage(),
    { models: createModels(), registry: createRegistry() },
    ctx,
  );
  const root = await harness.root(ctx);
  const bundle = createDurableTools({
    additionalTools: createOrbTools({ invoke: () => okAsync({ id: "orb-id" }) }),
  });
  try {
    expect(bundle.catalog.describe("orb_self")).toContain("Promise<string>");
    expect(bundle.catalog.describe("subagent")).toContain("Promise<string>");
    const result = await bundle.modelTools[0].execute(
      {
        code: "const identity=await tools.orb_self({}); text(typeof identity); text(JSON.parse(identity).id);",
      },
      {
        conversationId: root.id,
        commit: root.commit.bind(root),
        callId: "shape",
        details: async () => {},
        diagnostic: () => {},
      } as unknown as ToolExecutionApi,
      ctx,
    );
    expect(result.content).toContainEqual({ type: "text", text: "string" });
    expect(result.content).toContainEqual({ type: "text", text: "orb-id" });
  } finally {
    await harness.close(ctx);
    await bundle.close();
  }
});

it("stops repeated worker output before aggregate host collection exceeds its bound", async () => {
  const harness = await Harness.open(
    new MemoryStorage(),
    { models: createModels(), registry: createRegistry() },
    ctx,
  );
  const root = await harness.root(ctx);
  let spilled = "";
  const tool = codemodeTool(new CallableCatalog([]), new Set(), {
    spill: (text) => {
      spilled = text;
      return okAsync("artifact:stress");
    },
  });
  try {
    const result = await tool.execute(
      {
        code: 'const chunk="x".repeat(16384); for(let i=0;i<128;i++) text(chunk); store("mustNotPersist",true);',
      },
      {
        conversationId: root.id,
        commit: root.commit.bind(root),
        callId: "stress",
        details: async () => {},
        diagnostic: () => {},
      } as unknown as ToolExecutionApi,
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("output limit");
    expect(spilled.length).toBeLessThan(1100000);
    const check = await tool.execute(
      { code: 'return load("mustNotPersist") ?? "absent";' },
      {
        conversationId: root.id,
        commit: root.commit.bind(root),
        callId: "check",
        details: async () => {},
        diagnostic: () => {},
      } as unknown as ToolExecutionApi,
      ctx,
    );
    expect(check.content).toContainEqual({ type: "text", text: "absent" });
  } finally {
    await harness.close(ctx);
  }
});
