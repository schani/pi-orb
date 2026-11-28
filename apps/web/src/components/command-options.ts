import type { AgentSettingsEvent, ClientAction, OrbView, SettingsAction } from "@pi-orb/protocol";

export type ModelSelection = Pick<OrbView, "queueableModels" | "pendingModel">;
export type ComposerCommandAction = SettingsAction | Extract<ClientAction, { type: "compact" }>;
export interface CommandOption {
  label: string;
  text?: string;
  action?: ComposerCommandAction;
  current?: boolean;
  goal?: { objective: string | null };
}
export function commandOptions(
  text: string,
  view: AgentSettingsEvent | null,
  effortLabel: "thinking" | "effort" = "thinking",
  queueableModels?: ModelSelection["queueableModels"],
  queued?: AgentSettingsEvent["settings"]["model"],
  goalAvailable = false,
): CommandOption[] {
  const goal = goalAvailable ? /^goal(?:\s+(.*))?$/is.exec(text) : null;
  if (goal) return [{ label: "goal", goal: { objective: goal[1]?.trim() || null } }];
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
  if (!match) {
    const names = queueableModels === undefined ? ["model", effortLabel, "compact"] : ["model"];
    if (goalAvailable) names.push("goal");
    return names
      .filter((name) => name.startsWith(text.toLowerCase()))
      .map(
        (name): CommandOption =>
          name === "compact"
            ? { label: name, action: { type: "compact" } }
            : name === "goal"
              ? { label: name, goal: { objective: null } }
              : { label: name, text: `${name} ` },
      );
  }
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
