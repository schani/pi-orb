import type { AgentSettingsEvent, SettingsAction } from "@pi-orb/protocol";
export interface CommandOption {
  label: string;
  text?: string;
  action?: SettingsAction;
  current?: boolean;
}
export function commandOptions(
  text: string,
  view: AgentSettingsEvent | null,
  effortLabel: "thinking" | "effort" = "thinking",
): CommandOption[] {
  const match = /^(model|thinking|effort)\s+(.*)$/is.exec(text);
  if (match && match[1]?.toLowerCase() !== "model" && match[1]?.toLowerCase() !== effortLabel)
    return [];
  if (!match)
    return ["model", effortLabel]
      .filter((name) => name.startsWith(text.toLowerCase()))
      .map((name) => ({ label: name, text: `${name} ` }));
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
