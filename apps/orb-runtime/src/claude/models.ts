import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type { ModelOption } from "@pi-orb/protocol";

export const DEFAULT_CLAUDE_MODEL = "opus";

export function latestClaudeModels(models: readonly ModelInfo[]): ModelOption[] {
  return ["fable", "opus", "sonnet", "haiku"].flatMap((family) => {
    const model = models.find((model) => model.value === family);
    return model === undefined
      ? []
      : [
          {
            provider: "claude",
            id: model.value,
            name: family.charAt(0).toUpperCase() + family.slice(1),
            thinkingLevels: model.supportedEffortLevels ?? [],
          },
        ];
  });
}

export function findClaudeModel(models: readonly ModelInfo[], id: string): ModelInfo | undefined {
  return (
    models.find((model) => model.value === id) ?? models.find((model) => model.resolvedModel === id)
  );
}
