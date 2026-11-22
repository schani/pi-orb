import type { AgentSettingsEvent, ClientAction, OrbView, SettingsAction } from "@pi-orb/protocol";

export type ModelSelection = Pick<OrbView, "queueableModels" | "pendingModel">;
export type ComposerCommandAction = SettingsAction | Extract<ClientAction, { type: "compact" }>;
export interface CommandOption {
  label: string;
  text?: string;
  action?: ComposerCommandAction;
  current?: boolean;
}
export function commandOptions(
  text: string,
  view: AgentSettingsEvent | null,
  effortLabel: "thinking" | "effort" = "thinking",
  queueableModels?: ModelSelection["queueableModels"],
  queued?: AgentSettingsEvent["settings"]["model"],
): CommandOption[] {
  const compact = queueableModels === undefined ? /^compact(?:\s+(.*))?$/is.exec(text) : null;
  if (compact) {
    const customInstructions = compact[1]?.trim();
    return [
      {
        label: "compact",
        action: { type: "compact", ...(customInstructions ? { customInstructions } : {}) },
      },
    ];
  }
  const match = /^(model|thinking|effort)\s+(.*)$/is.exec(text);
  if (!match)
    return (queueableModels === undefined ? ["model", effortLabel, "compact"] : ["model"])
      .filter((name) => name.startsWith(text.toLowerCase()))
      .map(
        (name): CommandOption =>
          name === "compact"
            ? { label: name, action: { type: "compact" } }
            : { label: name, text: `${name} ` },
      );
  const query = (match[2] ?? "").toLowerCase();
  if (match[1]?.toLowerCase() === "model") {
    const current = view?.settings.model;
    return (queueableModels ?? view?.models ?? [])
      .filter(({ provider, id, name }) => `${provider}/${id} ${name}`.toLowerCase().includes(query))
      .map(({ provider, id, name }) => ({
        label: queued?.provider === provider && queued.id === id ? `${name} (queued)` : name,
        action: { type: "set_model", model: { provider, id } },
        current:
          queueableModels === undefined && current?.provider === provider && current.id === id,
      }));
  }
  if (!view || queueableModels !== undefined || match[1]?.toLowerCase() !== effortLabel) return [];
  return (
    view.models.find(
      (model) =>
        model.provider === view.settings.model.provider && model.id === view.settings.model.id,
    )?.thinkingLevels ?? []
  )
    .filter((level) => level.includes(query))
    .map((level) => ({
      label: level,
      action: { type: "set_thinking", thinkingLevel: level },
      current: level === view.settings.thinkingLevel,
    }));
}
