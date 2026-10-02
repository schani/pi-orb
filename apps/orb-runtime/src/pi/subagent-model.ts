import { SELECTABLE_CODEX_MODELS } from "./model-select.ts";

interface ModelRegistry<Model extends { provider: string; id: string }> {
  getAll(): Model[];
  getAvailable?(): Model[];
}

/** Explicit child selection uses the conversation picker's pinned product map. */
export function resolveSubagentModel<Model extends { provider: string; id: string }>(
  selector: string,
  registry: ModelRegistry<Model>,
): Model | string {
  const alias = SELECTABLE_CODEX_MODELS.find(
    (entry) => entry.name.toLowerCase() === selector.toLowerCase(),
  );
  const target = alias ? `openai-codex/${alias.id}` : selector;
  const all = registry
    .getAll()
    .find((model) => `${model.provider}/${model.id}`.toLowerCase() === target.toLowerCase());
  if (alias && !all) return `Model unavailable: "${selector}" (${target}).`;
  if (!all || (!alias && !selector.includes("/"))) return `Model not found: "${selector}".`;
  const available = registry.getAvailable?.() ?? registry.getAll();
  return (
    available.find((model) => model.provider === all.provider && model.id === all.id) ??
    `Model unavailable: "${selector}" (${all.provider}/${all.id}).`
  );
}
