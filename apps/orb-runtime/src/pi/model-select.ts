/**
 * Pinned-model selection for the hardcoded `openai-codex` provider
 * (DESIGN.md §15.1). The runtime advertises the `input.image` capability, so
 * the model must declare image input: pi-ai's request serializers include
 * image content only when `model.input` contains "image" and silently drop
 * it otherwise. Prefer the first image-capable model in Pi's catalog order;
 * fall back to the catalog head only when no model accepts images.
 */
export function pickCodexModel<Model extends { input: string[] }>(
  models: readonly Model[],
): Model | undefined {
  return models.find((model) => model.input.includes("image")) ?? models[0];
}
