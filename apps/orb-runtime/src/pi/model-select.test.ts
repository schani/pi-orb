import { describe, expect, it } from "vitest";
import { pickCodexModel } from "./model-select.ts";

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
const laterMultimodal: CatalogModel = { id: "gpt-5.5", input: ["text", "image"] };

describe("pickCodexModel", () => {
  it("prefers the first image-capable model over an earlier text-only one", () => {
    expect(pickCodexModel([spark, multimodal, laterMultimodal])).toBe(multimodal);
  });

  it("keeps catalog order among image-capable models", () => {
    expect(pickCodexModel([multimodal, laterMultimodal])).toBe(multimodal);
  });

  it("falls back to the first model when none accepts images", () => {
    const textOnly: CatalogModel = { id: "other", input: ["text"] };
    expect(pickCodexModel([spark, textOnly])).toBe(spark);
  });

  it("returns undefined for an empty catalog", () => {
    expect(pickCodexModel([])).toBeUndefined();
  });
});
