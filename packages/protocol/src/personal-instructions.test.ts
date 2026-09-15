import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  PERSONAL_INSTRUCTIONS_MAX_BYTES,
  PersonalInstructionsSchema,
  validatePersonalInstructions,
} from "./personal-instructions.ts";

describe("personal instruction contract", () => {
  it("preserves Markdown bytes, including empty and whitespace documents", () => {
    for (const content of [
      "",
      " \n\t",
      "# Me\r\n\nKeep é / 🪐 exactly.\n",
      "x".repeat(PERSONAL_INSTRUCTIONS_MAX_BYTES),
    ]) {
      expect(validatePersonalInstructions({ content })._unsafeUnwrap()).toBe(content);
    }
  });
  it("rejects malformed bodies, non-roundtrippable text and oversized UTF-8", () => {
    for (const body of [
      null,
      {},
      { content: 7 },
      { content: "ok", projectId: "wrong-scope" },
      { content: "a\0b" },
      { content: "\ud800" },
      { content: "\udc00" },
      { content: "é".repeat(PERSONAL_INSTRUCTIONS_MAX_BYTES / 2 + 1) },
    ]) {
      expect(validatePersonalInstructions(body).isErr()).toBe(true);
    }
  });
  it("validates coherent snapshots and safe revision numbers", () => {
    expect(Check(PersonalInstructionsSchema, { content: "", revision: 0 })).toBe(true);
    for (const revision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(Check(PersonalInstructionsSchema, { content: "", revision })).toBe(false);
    }
  });
});
