import { describe, expect, it } from "vitest";
import { codexModelDisplayName, eligibleCodexModels } from "./model-select.ts";

interface CatalogModel {
  id: string;
  input: string[];
}

const multimodal: CatalogModel = { id: "gpt-5.4", input: ["text", "image"] };
const astra: CatalogModel = { id: "gpt-6-astra", input: ["text", "image"] };

describe("eligibleCodexModels", () => {
  it("offers only Astra, Sol 6.1, Terra, and Luna in that order when image-capable", () => {
    const catalog = [
      { id: "gpt-6-luna", input: ["text", "image"] },
      { id: "gpt-6-sol", input: ["text", "image"] },
      { id: "gpt-6.1-sol", input: ["text", "image"] },
      { id: "gpt-5.6-terra", input: ["text", "image"] },
      astra,
      multimodal,
    ];

    expect(eligibleCodexModels(catalog).map((model) => model.id)).toEqual([
      "gpt-6-astra",
      "gpt-6.1-sol",
      "gpt-5.6-terra",
      "gpt-6-luna",
    ]);
    expect(codexModelDisplayName("gpt-6-luna")).toBe("Luna");
    expect(codexModelDisplayName("gpt-6-sol")).toBe("gpt-6-sol");
  });

  it("omits configured models without image input", () => {
    expect(
      eligibleCodexModels([astra, { id: "gpt-6.1-sol", input: ["text"] }]).map((model) => model.id),
    ).toEqual(["gpt-6-astra"]);
  });
});
