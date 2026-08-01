/**
 * Pinned-model selection for the hardcoded `openai-codex` provider
 * (DESIGN.md §15.1). The decided orb model is gpt-5.6-sol. If a future Pi
 * catalog drops that id, fall back to the first image-capable model — the
 * runtime advertises `input.image`, and pi-ai's request serializers include
 * image content only when `model.input` contains "image" — and only then to
 * the catalog head.
 */
export const PINNED_CODEX_MODEL_ID = "gpt-5.6-sol";

export function pickCodexModel<Model extends { id: string; input: string[] }>(
  models: readonly Model[],
): Model | undefined {
  return (
    models.find((model) => model.id === PINNED_CODEX_MODEL_ID) ??
    models.find((model) => model.input.includes("image")) ??
    models[0]
  );
}
