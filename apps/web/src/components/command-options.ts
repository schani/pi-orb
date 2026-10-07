import type { AgentSettingsEvent, ClientAction, SettingsAction } from "@pi-orb/protocol";
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
): CommandOption[] {
  const compact = /^compact(?:\s+(.*))?$/is.exec(text);
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
  if (match && match[1]?.toLowerCase() !== "model" && match[1]?.toLowerCase() !== effortLabel)
    return [];
  if (!match)
    return ["model", effortLabel, "compact"]
      .filter((name) => name.startsWith(text.toLowerCase()))
      .map(
        (name): CommandOption =>
          name === "compact"
            ? { label: name, action: { type: "compact" } }
            : { label: name, text: `${name} ` },
      );
  if (!view) return [];
  const query = (match[2] ?? "").toLowerCase();
  if (match[1]?.toLowerCase() === "model")
    return view.models
      .filter((model) =>
        `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(query),
      )
      .map((model) => ({
        label: model.name,
        action: { type: "set_model", model: { provider: model.provider, id: model.id } },
        current:
          model.provider === view.settings.model.provider && model.id === view.settings.model.id,
      }));
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
