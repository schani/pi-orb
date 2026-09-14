import { expect, it } from "vitest";
import { settingsFallbackMessage } from "./restore-settings.ts";

const actual = { model: { provider: "openai-codex", id: "astra" }, thinkingLevel: "high" as const };
it("reports model fallback and restored thinking clamps, never healthy/fresh bindings", () => {
  expect(settingsFallbackMessage(null, null, actual)).toBeNull();
  expect(
    settingsFallbackMessage({ provider: "openai-codex", modelId: "astra" }, "high", actual),
  ).toBeNull();
  expect(
    settingsFallbackMessage({ provider: "openai-codex", modelId: "missing" }, "high", actual),
  ).toContain("Saved model openai-codex/missing is unavailable; using openai-codex/astra.");
  expect(
    settingsFallbackMessage({ provider: "openai-codex", modelId: "astra" }, "max", actual),
  ).toContain("Saved thinking max adjusted to high for openai-codex/astra.");
});
