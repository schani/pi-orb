import { err, ok } from "neverthrow";
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
    expect(resolveSubagentModel(selector, registry)).toEqual(ok(models.find((m) => m.id === id)));
  });
  it.each([
    ["", "not_found", 'Model not found: "".'],
    ["luna", "unavailable", 'Model unavailable: "luna" (openai-codex/gpt-6-luna).'],
    ["sol-new", "not_found", 'Model not found: "sol-new".'],
    ["gpt-6-sol", "not_found", 'Model not found: "gpt-6-sol".'],
    ["openai-codex/gpt-6.2-sol", "not_found", 'Model not found: "openai-codex/gpt-6.2-sol".'],
    ["other/gpt-6-sol", "not_found", 'Model not found: "other/gpt-6-sol".'],
    [
      "openai-codex/gpt-6-luna",
      "unavailable",
      'Model unavailable: "openai-codex/gpt-6-luna" (openai-codex/gpt-6-luna).',
    ],
  ])("rejects unavailable or unknown %s", (selector, type, message) => {
    expect(resolveSubagentModel(selector, registry)).toEqual(err({ type, message }));
  });
  it("rejects a pinned alias missing from the catalog", () => {
    expect(resolveSubagentModel("Sol", { getAll: () => [] })).toEqual(
      err({ type: "unavailable", message: 'Model unavailable: "Sol" (openai-codex/gpt-6.1-sol).' }),
    );
  });
  it("uses the catalog when availability is not provided", () => {
    expect(resolveSubagentModel("Sol", { getAll: () => models })).toEqual(ok(models[2]));
  });
});
