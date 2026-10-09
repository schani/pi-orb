import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  Harness,
  MemoryStorage,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { CallableCatalog } from "./catalog.ts";
import { codemodeTool } from "./codemode.ts";
import { subagentTools } from "./subagents.ts";

it("declares inherited subagent configuration without unsupported selectors", () => {
  const catalog = new CallableCatalog(subagentTools);
  const start = catalog.describe("subagent");
  if (!start) return expect.fail("subagent declaration missing");
  expect(start).toContain("Returns agent_id immediately");
  expect(start).toContain("Inherits parent model, instructions and authorized tools");
  expect(start).toContain("No profiles, kinds or model selectors");
  expect(JSON.parse(JSON.stringify(subagentTools[0]!.parameters))).toEqual({
    type: "object",
    properties: { prompt: { type: "string" }, description: { type: "string" } },
    required: ["prompt"],
    additionalProperties: false,
  });
});

it("documents the reserved tools binding and a working catalog discovery example", async () => {
  const ctx = BACKGROUND_CONTEXT;
  const harness = await Harness.open(
    new MemoryStorage(),
    { models: createModels(), registry: createRegistry() },
    ctx,
  );
  const tool = codemodeTool(new CallableCatalog(subagentTools), new Set());
  try {
    expect(tool.description).toContain("Do not redeclare tools");
    const example = tool.description.match(/`(text\(await searchTools\('subagent'\)\))`/)?.[1];
    expect(example).toBeDefined();
    const root = await harness.root(ctx);
    const api = {
      conversationId: root.id,
      commit: root.commit.bind(root),
      callId: "discovery",
    } as ToolExecutionApi;
    const result = await tool.execute({ code: example ?? "" }, api, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContainEqual({
      type: "text",
      text: JSON.stringify(new CallableCatalog(subagentTools).search("subagent")),
    });
  } finally {
    await harness.close(ctx);
  }
});
