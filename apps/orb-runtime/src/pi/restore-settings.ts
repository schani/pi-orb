import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { type AgentSettings, ThinkingLevelSchema } from "@pi-orb/protocol";
import { Check } from "typebox/value";
import { pickCodexModel } from "./model-select.ts";

export function settingsFallbackMessage(
  savedModel: { provider: string; modelId: string } | null,
  savedThinking: string | null,
  actual: AgentSettings,
): string | null {
  const messages: string[] = [];
  if (
    savedModel &&
    (savedModel.provider !== actual.model.provider || savedModel.modelId !== actual.model.id)
  )
    messages.push(
      `Saved model ${savedModel.provider}/${savedModel.modelId} is unavailable; using ${actual.model.provider}/${actual.model.id}.`,
    );
  if (savedThinking !== null && savedThinking !== actual.thinkingLevel)
    messages.push(
      `Saved thinking ${savedThinking} adjusted to ${actual.thinkingLevel} for ${actual.model.provider}/${actual.model.id}.`,
    );
  return messages.length ? messages.join(" ") : null;
}

/** SDK auto-restore requires messages; orb settings must restore even before the first turn. */
export function restoreSessionSettings<M extends { provider: string; id: string; input: string[] }>(
  manager: Pick<SessionManager, "buildSessionContext" | "getEntries">,
  models: readonly M[],
) {
  const restored = manager.buildSessionContext();
  const model =
    models.find(
      (item) => item.provider === restored.model?.provider && item.id === restored.model.modelId,
    ) ?? pickCodexModel(models);
  if (!model) return undefined;
  const thinkingLevel =
    manager.getEntries().some((entry) => entry.type === "thinking_level_change") &&
    Check(ThinkingLevelSchema, restored.thinkingLevel)
      ? restored.thinkingLevel
      : ("high" as const);
  return { model, thinkingLevel };
}
