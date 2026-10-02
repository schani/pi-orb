import { describe, expect, it } from "vitest";
import { resolveSubagentModel } from "./subagent-model.ts";

const models = [
  { provider: "openai-codex", id: "gpt-6-astra" },
  { provider: "openai-codex", id: "gpt-6-sol" },
  { provider: "openai-codex", id: "gpt-6.1-sol" },
  { provider: "openai-codex", id: "gpt-5.6-terra" },
  { provider: "openai-codex", id: "gpt-6-luna" },
];
const registry = {
  getAll: () => models,
  getAvailable: () => models.filter((m) => m.id !== "gpt-6-luna"),
  find: (provider: string, id: string) =>
    models.find((m) => m.provider === provider && m.id === id),
};

describe("subagent model selector", () => {
  it.each([
    ["Sol", "gpt-6.1-sol"],
    ["ASTRA", "gpt-6-astra"],
    ["terra", "gpt-5.6-terra"],
    ["OPENAI-CODEX/GPT-6-SOL", "gpt-6-sol"],
  ])("resolves %s exactly to %s", (selector, id) => {
    expect(resolveSubagentModel(selector, registry)).toEqual(models.find((m) => m.id === id));
  });
  it.each(["luna", "sol-new", "gpt-6-sol", "openai-codex/gpt-6.2-sol", "other/gpt-6-sol"])(
    "rejects unavailable or unknown %s",
    (selector) =>
      expect(resolveSubagentModel(selector, registry)).toMatch(/^Model (unavailable|not found):/),
  );
});
