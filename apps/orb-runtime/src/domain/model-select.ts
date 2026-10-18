export const PINNED_CODEX_MODEL_ID = "gpt-6.1-sol";

export const SELECTABLE_CODEX_MODELS = [
  { id: "gpt-6-astra", name: "Astra" },
  { id: "gpt-6.1-sol", name: "Sol" },
  { id: "gpt-5.6-terra", name: "Terra" },
  { id: "gpt-6-luna", name: "Luna" },
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
