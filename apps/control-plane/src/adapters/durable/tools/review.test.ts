import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import {
  createRegistry,
  defineTool,
  Harness,
  LiveDoc,
  MemoryStorage,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { CallableCatalog } from "./catalog.ts";
import { createDurableTools } from "./index.ts";
import { createOrbTools } from "./orb-tools.ts";
import { openCodemodeHarness } from "./testkit/codemode.ts";

it("keeps resources-only instructions in namespace discovery, not initial provider metadata", async () => {
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
      agent: {
        model: { provider: "faux", modelId: "faux-1" },
        tools: null,
        modelTools: bundle.modelTools,
      },
    });
    harness.resume();
    await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
    expect(metadata).toContain("<tool-catalogue>");
    expect(metadata).not.toContain("Resolve project before reading");
    expect(metadata).not.toContain("Use server names from MCP namespaces");
    expect(metadata).not.toContain("Namespace mcp");
    const initialFixture = await openCodemodeHarness(bundle.catalog);
    try {
      const initial = await initialFixture.run(
        'text(await describeNamespace("mcp__docs")); text(await describeNamespace("mcp"));',
      );
      expect(initial.isError).toBe(false);
      expect(JSON.stringify(initial.output)).toContain("Resolve project before reading");
      expect(JSON.stringify(initial.output)).toContain(
        "Use server names from MCP namespaces; list resources/templates before reading unfamiliar URIs.",
      );
    } finally {
      await initialFixture.close();
    }
    expect(bundle.catalog.definitions().some((t) => t.name === "subagent")).toBe(true);
    const resources = await bundle.catalog.invoke(
      "list_mcp_resources",
      {},
      {} as ToolExecutionApi,
      ctx,
    );
    expect(resources.isOk()).toBe(true);
    const fixture = await openCodemodeHarness(bundle.catalog);
    try {
      const discovery = await fixture.run(
        'return (await describeNamespace("mcp__docs")).instructions;',
      );
      expect(discovery.isError).toBe(false);
      expect(discovery.output).toContainEqual({
        type: "text",
        text: "Use refreshed project guidance",
      });
      const refreshed = await fixture.run(
        'await tools.list_mcp_resources({}); text(await describeNamespace("mcp__docs"));',
      );
      expect(JSON.stringify(refreshed.output)).toContain("Use refreshed project guidance");
      const next = await fixture.run('text(await describeNamespace("mcp__docs"));');
      expect(JSON.stringify(next.output)).toContain("Latest project guidance");
    } finally {
      await fixture.close();
    }
  } finally {
    await harness?.close(ctx);
    await bundle.close();
  }
});

it("preserves native execution wait details without exposing nested stdout to the model", async () => {
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = await openCodemodeHarness(
    new CallableCatalog([
      defineTool({
        name: "wait",
        description: "wait",
        parameters: Type.Object({}),
        execute: async (_args, api) => {
          await api.details({ executionWait: true }, ctx);
          entered();
          await released;
          api.output("private nested stdout");
          await api.details({ executionWait: false }, ctx);
          return {};
        },
      }),
    ]),
  );
  const pending = fixture.run('await tools.wait({}); text("filtered");');
  try {
    await waiting;
    const live = await fixture.harness.snapshot(LiveDoc, fixture.root.id, ctx);
    expect(live?.nestedTools).toContainEqual(
      expect.objectContaining({ name: "wait", details: { executionWait: true } }),
    );
    release();
    const result = await pending;
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result.output)).not.toContain("private nested stdout");
    const completed = await fixture.harness.snapshot(LiveDoc, fixture.root.id, ctx);
    expect(completed).toBeDefined();
    expect(completed?.nestedTools ?? []).toEqual([]);
    expect(result.details).toMatchObject({ executionWait: false });
    expect(completed?.tools?.[0]?.output ?? "").not.toContain("private nested stdout");
  } finally {
    release();
    await fixture.close();
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

it("declares and returns orb objects without changing subagent text contracts", async () => {
  const bundle = createDurableTools({
    additionalTools: createOrbTools({
      invoke: () =>
        okAsync({
          orb: { id: "orb-id", name: null, url: "url", createdAt: "now" },
          project: { id: "project", name: "Project", repositoryUrl: null },
          spawnedByOrb: null,
          children: [],
          previewHost: null,
        }),
    }),
  });
  const fixture = await openCodemodeHarness(bundle.catalog);
  try {
    const result = await fixture.run(
      'const identity=await tools.orb_self({}); text({type:typeof identity,id:identity.orb.id,orb:(await describeTool("orb_self")).includes("Promise<string>"),subagent:(await describeTool("subagent")).includes("Promise<string>")});',
    );
    expect(result.isError).toBe(false);
    expect(result.output).toContainEqual({
      type: "text",
      text: '{"type":"object","id":"orb-id","orb":false,"subagent":true}',
    });
  } finally {
    await fixture.close();
    await bundle.close();
  }
});

it("stops repeated worker output before aggregate host collection exceeds its bound", async () => {
  let spilled = "";
  const fixture = await openCodemodeHarness(new CallableCatalog([]), {
    files: {
      spill: (text) => {
        spilled = text;
        return okAsync("artifact:stress");
      },
    },
  });
  try {
    const result = await fixture.run(
      'const chunk="x".repeat(16384); for(let i=0;i<128;i++) text(chunk); store("mustNotPersist",true);',
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.output)).toContain("output limit");
    expect(spilled.length).toBeLessThan(1100000);
    const check = await fixture.run('return load("mustNotPersist") ?? "absent";');
    expect(check.output).toContainEqual({ type: "text", text: "absent" });
  } finally {
    await fixture.close();
  }
});
