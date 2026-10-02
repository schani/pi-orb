import { err, ok, type Result } from "neverthrow";
import { SELECTABLE_CODEX_MODELS } from "./model-select.ts";

interface ModelRegistry<Model extends { provider: string; id: string }> {
  getAll(): Model[];
  getAvailable?(): Model[];
}

export type SubagentModelError =
  | { readonly type: "not_found"; readonly message: string }
  | { readonly type: "unavailable"; readonly message: string };

/** Explicit child selection uses the conversation picker's pinned product map. */
export function resolveSubagentModel<Model extends { provider: string; id: string }>(
  selector: string,
  registry: ModelRegistry<Model>,
): Result<Model, SubagentModelError> {
  const alias = SELECTABLE_CODEX_MODELS.find(
    (entry) => entry.name.toLowerCase() === selector.toLowerCase(),
  );
  const target = alias ? `openai-codex/${alias.id}` : selector;
  const all = registry
    .getAll()
    .find((model) => `${model.provider}/${model.id}`.toLowerCase() === target.toLowerCase());
  if (alias && !all)
    return err({ type: "unavailable", message: `Model unavailable: "${selector}" (${target}).` });
  if (!all || (!alias && !selector.includes("/")))
    return err({ type: "not_found", message: `Model not found: "${selector}".` });
  const available = registry.getAvailable?.() ?? registry.getAll();
  const model = available.find((model) => model.provider === all.provider && model.id === all.id);
  return model
    ? ok(model)
    : err({
        type: "unavailable",
        message: `Model unavailable: "${selector}" (${all.provider}/${all.id}).`,
      });
}
