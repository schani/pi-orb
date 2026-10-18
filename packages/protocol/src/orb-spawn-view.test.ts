import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { OrbViewSchema } from "./index.ts";

const orb = {
  id: "child",
  projectId: "project",
  harness: "pi",
  name: null,
  state: "creating",
  stateVersion: 0,
  stateChangedAt: "2026-10-14T00:00:00Z",
  createdAt: "2026-10-14T00:00:00Z",
  updatedAt: "2026-10-14T00:00:00Z",
};

describe("browser spawn provenance", () => {
  it("accepts an optional caller ID", () => {
    expect(Check(OrbViewSchema, orb)).toBe(true);
    expect(Check(OrbViewSchema, { ...orb, spawnedByOrb: "parent" })).toBe(true);
  });

  it("rejects the old provenance field", () => {
    expect(Check(OrbViewSchema, { ...orb, spawnedBy: "parent" })).toBe(false);
    expect(Check(OrbViewSchema, { ...orb, spawnedByOrb: "parent", spawnedBy: "parent" })).toBe(
      false,
    );
  });

  it.each([null, 42, { id: "parent", url: "https://app.test/orbs/parent" }])(
    "rejects non-string provenance: %j",
    (spawnedByOrb) => {
      expect(Check(OrbViewSchema, { ...orb, spawnedByOrb })).toBe(false);
    },
  );
});
