import { describe, expect, it } from "vitest";
import { codexModelDisplayName, eligibleCodexModels, pickCodexModel } from "./model-select.ts";

/**
 * The runtime advertises `input.image`, so the pinned Codex model must be
 * able to receive images: pi-ai serializes image content only when
 * `model.input` includes "image" and silently drops it otherwise — which is
 * exactly how a pasted screenshot reached the session but never the model
 * (2026-08-01 incident, text-only gpt-5.3-codex-spark was first in the
 * catalog).
 */

interface CatalogModel {
  id: string;
  input: string[];
}

const spark: CatalogModel = { id: "gpt-5.3-codex-spark", input: ["text"] };
const multimodal: CatalogModel = { id: "gpt-5.4", input: ["text", "image"] };
const astra: CatalogModel = { id: "gpt-6-astra", input: ["text", "image"] };

describe("eligibleCodexModels", () => {
  it("offers only Astra, Sol, Terra, and Luna in that order when image-capable", () => {
    const catalog = [
      { id: "gpt-6-luna", input: ["text", "image"] },
      { id: "gpt-6-sol", input: ["text", "image"] },
      { id: "gpt-5.6-terra", input: ["text", "image"] },
      astra,
      multimodal,
    ];

    expect(eligibleCodexModels(catalog).map((model) => model.id)).toEqual([
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-5.6-terra",
      "gpt-6-luna",
    ]);
    expect(codexModelDisplayName("gpt-6-luna")).toBe("Luna");
  });

  it("omits configured models without image input", () => {
    expect(
      eligibleCodexModels([astra, { id: "gpt-6-sol", input: ["text"] }]).map((model) => model.id),
    ).toEqual(["gpt-6-astra"]);
  });
});

describe("pickCodexModel", () => {
  it("pins gpt-6-astra when the catalog has it (decided model)", () => {
    expect(pickCodexModel([spark, multimodal, astra])).toBe(astra);
  });

  it("falls back to the first image-capable model when the pinned id is absent", () => {
    expect(pickCodexModel([spark, multimodal])).toBe(multimodal);
  });

  it("falls back to the first model when none accepts images", () => {
    const textOnly: CatalogModel = { id: "other", input: ["text"] };
    expect(pickCodexModel([spark, textOnly])).toBe(spark);
  });

  it("returns undefined for an empty catalog", () => {
    expect(pickCodexModel([])).toBeUndefined();
  });
});
