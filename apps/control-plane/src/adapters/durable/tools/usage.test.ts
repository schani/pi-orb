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
import { expect, it } from "vitest";
import { CallableCatalog } from "./catalog.ts";
import { codemodeTool } from "./codemode.ts";

it("aggregates nested usage once even when the script fails after real calls", async () => {
  const usage = {
    input: 1,
    output: 2,
    cacheRead: 3,
    cacheWrite: 4,
    reasoning: 1,
    totalTokens: 10,
    cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
  };
  const tool = codemodeTool(
    new CallableCatalog([
      defineTool({
        name: "cost",
        description: "cost",
        parameters: Type.Object({}),
        execute: async () => ({ usage, content: [{ type: "text", text: "done" }] }),
      }),
    ]),
    new Set(),
  );
  const harness = await Harness.open(
    new MemoryStorage(),
    { models: createModels(), registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  try {
    const root = await harness.root(BACKGROUND_CONTEXT);
    const result = await tool.execute(
      { code: 'await Promise.all([tools.cost({}),tools.cost({})]); throw new Error("partial");' },
      {
        conversationId: root.id,
        commit: root.commit.bind(root),
        callId: "call",
        details: async () => {},
        diagnostic: () => {},
      } as unknown as ToolExecutionApi,
      BACKGROUND_CONTEXT,
    );
    expect(result.isError).toBe(true);
    expect(result.usage?.totalTokens).toBe(20);
    expect(result.usage?.cost.total).toBe(20);
    expect(result.usage?.reasoning).toBe(2);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
});
