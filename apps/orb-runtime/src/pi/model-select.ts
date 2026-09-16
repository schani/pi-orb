/**
 * Pinned-model selection for the hardcoded `openai-codex` provider
 * (docs/credentials.md). The decided orb model is gpt-6-astra. If a future Pi
 * catalog drops that id, fall back to the first image-capable model — the
 * runtime advertises `input.image`, and pi-ai's request serializers include
 * image content only when `model.input` contains "image" — and only then to
 * the catalog head.
 */
export const PINNED_CODEX_MODEL_ID = "gpt-6-astra";

export const SELECTABLE_CODEX_MODELS = [
  { id: "gpt-6-astra", name: "Astra" },
  { id: "gpt-5.6-sol", name: "Sol" },
  { id: "gpt-5.6-terra", name: "Terra" },
  { id: "gpt-5.6-luna", name: "Luna" },
] as const;

export function eligibleCodexModels<Model extends { id: string; input: string[] }>(
  models: readonly Model[],
): Model[] {
  return SELECTABLE_CODEX_MODELS.flatMap(({ id }) => {
    const model = models.find((candidate) => candidate.id === id);
    return model?.input.includes("image") ? [model] : [];
  });
}

export function codexModelDisplayName(id: string): string {
  return SELECTABLE_CODEX_MODELS.find((model) => model.id === id)?.name ?? id;
}

export function pickCodexModel<Model extends { id: string; input: string[] }>(
  models: readonly Model[],
): Model | undefined {
  return (
    models.find((model) => model.id === PINNED_CODEX_MODEL_ID) ??
    models.find((model) => model.input.includes("image")) ??
    models[0]
  );
}
