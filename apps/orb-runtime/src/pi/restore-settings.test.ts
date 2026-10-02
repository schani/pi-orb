import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { eligibleCodexModels } from "./model-select.ts";
import { restoreSessionSettings, settingsFallbackMessage } from "./restore-settings.ts";

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

it("defaults fresh sessions to Sol 6.1/high and preserves saved Astra settings", () => {
  const astra = { provider: "openai-codex", id: "gpt-6-astra", input: ["text", "image"] };
  const sol = { provider: "openai-codex", id: "gpt-6.1-sol", input: ["text", "image"] };
  const catalog = eligibleCodexModels([astra, sol]);
  const fresh = SessionManager.inMemory();
  expect(restoreSessionSettings(fresh, catalog)).toEqual({ model: sol, thinkingLevel: "high" });

  const saved = SessionManager.inMemory();
  saved.appendModelChange("openai-codex", "gpt-6-astra");
  saved.appendThinkingLevelChange("low");
  expect(restoreSessionSettings(saved, catalog)).toEqual({ model: astra, thinkingLevel: "low" });
});

it("restores exact Sol 6.1 IDs and reports older Sol as unavailable, without aliases", () => {
  const catalog = eligibleCodexModels([
    { provider: "openai-codex", id: "gpt-6-astra", input: ["text", "image"] },
    { provider: "openai-codex", id: "gpt-6.1-sol", input: ["text", "image"] },
  ]);
  const current = SessionManager.inMemory();
  current.appendModelChange("openai-codex", "gpt-6.1-sol");
  expect(restoreSessionSettings(current, catalog)?.model.id).toBe("gpt-6.1-sol");
  const old = SessionManager.inMemory();
  old.appendModelChange("openai-codex", "gpt-6-sol");
  const restored = restoreSessionSettings(old, catalog);
  expect(restored?.model.id).toBe("gpt-6.1-sol");
  expect(
    settingsFallbackMessage({ provider: "openai-codex", modelId: "gpt-6-sol" }, null, {
      model: { provider: "openai-codex", id: restored?.model.id ?? "" },
      thinkingLevel: "high",
    }),
  ).toContain("Saved model openai-codex/gpt-6-sol is unavailable");
});
