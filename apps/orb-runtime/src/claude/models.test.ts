import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { expect, it } from "vitest";
import { latestClaudeModels } from "./models.ts";

it("uses advertised aliases, excluding default, version IDs, context variants and duplicates", () => {
  const models: ModelInfo[] = [
    { value: "default", displayName: "Default (Opus)", description: "" },
    { value: "opus[1m]", displayName: "Opus (1M context)", description: "" },
    { value: "claude-opus-version", displayName: "Opus", description: "" },
    ...["sonnet", "haiku", "opus", "fable", "opus"]
      .map((value) => ({
        value,
        displayName: `${value} latest`,
        description: "",
        supportedEffortLevels: ["high"] as const,
      }))
      .map((model) => ({ ...model, supportedEffortLevels: [...model.supportedEffortLevels] })),
  ];
  expect(latestClaudeModels(models)).toEqual([
    { provider: "claude", id: "fable", name: "Fable", thinkingLevels: ["high"] },
    { provider: "claude", id: "opus", name: "Opus", thinkingLevels: ["high"] },
    { provider: "claude", id: "sonnet", name: "Sonnet", thinkingLevels: ["high"] },
    { provider: "claude", id: "haiku", name: "Haiku", thinkingLevels: ["high"] },
  ]);
});
it("never fabricates missing family aliases", () => {
  expect(latestClaudeModels([{ value: "opus", displayName: "Opus", description: "" }])).toEqual([
    { provider: "claude", id: "opus", name: "Opus", thinkingLevels: [] },
  ]);
});
