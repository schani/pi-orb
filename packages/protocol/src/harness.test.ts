import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { CreateOrbRequestSchema, UpdateOrbRequestSchema } from "./control-plane-api.ts";
import { HarnessKindSchema } from "./harness.ts";

describe("harness contracts", () => {
  it("accepts only Pi and Claude and allows omitted creation selection", () => {
    for (const harness of ["pi", "claude"]) {
      expect(Check(HarnessKindSchema, harness)).toBe(true);
      expect(Check(CreateOrbRequestSchema, { id: "orb", harness })).toBe(true);
    }
    expect(Check(CreateOrbRequestSchema, { id: "orb" })).toBe(true);
    for (const harness of ["other", "", null])
      expect(Check(CreateOrbRequestSchema, { id: "orb", harness })).toBe(false);
    expect(Check(UpdateOrbRequestSchema, { name: "Name", harness: "claude" })).toBe(false);
  });
});
