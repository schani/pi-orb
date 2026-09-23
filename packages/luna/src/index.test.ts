import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { describe, expect, it } from "vitest";
import { LUNA_MODEL_ID, lunaRequestOptions, resolveLunaModel } from "./index.ts";

describe("shared Luna request policy", () => {
  it("resolves the real GPT-6 Luna catalog entry without rewriting another model", () => {
    const catalog = openaiCodexProvider().getModels();
    const conversationModel = catalog.find((model) => model.id === "gpt-6-astra");
    expect(conversationModel).toBeDefined();
    if (conversationModel === undefined) throw new Error("catalog is missing gpt-6-astra");

    const model = resolveLunaModel({
      ...conversationModel,
      baseUrl: "https://inference.example.test",
    });

    expect(LUNA_MODEL_ID).toBe("gpt-6-luna");
    expect(model).toMatchObject({
      id: "gpt-6-luna",
      name: "GPT-6 Luna",
      provider: "openai-codex",
      api: "openai-codex-responses",
      baseUrl: "https://inference.example.test",
    });
    expect(model?.input).toContain("image");
    expect(model?.name).not.toBe("Luna");
  });

  it("uses minimal no-tool inference without the unsupported reasoning summary value", () => {
    const options = lunaRequestOptions({
      maxTokens: 64,
      sessionPrefix: "test",
      signal: new AbortController().signal,
    });
    expect(options.reasoningEffort).toBe("minimal");
    expect(options.textVerbosity).toBe("low");
    expect(options.toolChoice).toBe("none");
    expect("reasoningSummary" in options).toBe(false);
    expect(options.sessionId).toMatch(/^test-/);
  });
});
