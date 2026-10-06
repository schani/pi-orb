import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  defineTool,
  Harness,
  MemoryStorage,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { CallableCatalog } from "./catalog.ts";
import { codemodeTool } from "./codemode.ts";

const ctx = BACKGROUND_CONTEXT;
it("discovers normalized names, namespaces and ranked bounded declarations", () => {
  const catalog = new CallableCatalog([
    defineTool({
      name: "orb_self",
      description: "Current identity",
      parameters: Type.Object({}),
      execute: async () => ({}),
    }),
    defineTool({
      name: "mcp__dev-radius__search",
      description: "Find issues",
      parameters: Type.Object({ query: Type.String() }),
      execute: async () => ({}),
    }),
  ]);
  catalog.metadata("mcp__dev-radius__search", {
    namespace: { name: "mcp__dev-radius", instructions: "Search incidents" },
    deferred: true,
  });
  expect(catalog.describe("mcp__dev_radius__search")).toContain("Promise<string>");
  expect(catalog.search("incidents", { namespace: "dev_radius", limit: 1 })).toHaveLength(1);
  expect(catalog.describeNamespace("orb")?.tools).toContain("orb_self");
  expect(catalog.describeNamespace("dev_radius")?.instructions).toBe("Search incidents");
});
it("materializes nested streamed output without leaking it and formats string returns", async () => {
  const harness = await Harness.open(
    new MemoryStorage(),
    { models: createModels(), registry: createRegistry() },
    ctx,
  );
  const root = await harness.root(ctx);
  const output: string[] = [];
  const catalog = new CallableCatalog([
    defineTool({
      name: "stream",
      description: "stream",
      parameters: Type.Object({}),
      execute: async (_args, api) => {
        api.output("secret large output");
        api.diagnostic({ severity: "info", message: "done" });
        await api.details({ done: true }, ctx);
        return {};
      },
    }),
  ]);
  const tool = codemodeTool(catalog, new Set());
  try {
    const result = await tool.execute(
      { code: "const result=await tools.stream({}); return result.slice(0,6);" },
      {
        conversationId: root.id,
        commit: root.commit.bind(root),
        callId: "outer",
        taskId: 1,
        output: (s: string | Uint8Array) => output.push(String(s)),
        details: async () => {},
        diagnostic: () => {},
      } as unknown as ToolExecutionApi,
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContainEqual({ type: "text", text: "secret" });
    expect(output).toEqual([]);
    expect(JSON.stringify(result.details)).toContain('"status":"ok"');
  } finally {
    await harness.close(ctx);
  }
});
it("applies options and spills aggregate output through a scoped reader", async () => {
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
      return okAsync("artifact:private/1");
    },
  });
  try {
    const result = await tool.execute(
      { code: '// @options: {"max_output_tokens": 8}\ntext("a".repeat(200)); return "end";' },
      {
        conversationId: root.id,
        commit: root.commit.bind(root),
        callId: "out",
        details: async () => {},
        diagnostic: () => {},
      } as unknown as ToolExecutionApi,
      ctx,
    );
    expect(spilled).toContain("end");
    expect(JSON.stringify(result.content)).toContain("artifact:private/1");
    expect(JSON.stringify(result.content).length).toBeLessThan(600);
    const invalid = await tool.execute(
      { code: '// @options: {"timeout_ms": -1}\nreturn 1;' },
      { conversationId: root.id, commit: root.commit.bind(root) } as ToolExecutionApi,
      ctx,
    );
    expect(invalid.isError).toBe(true);
  } finally {
    await harness.close(ctx);
  }
});
