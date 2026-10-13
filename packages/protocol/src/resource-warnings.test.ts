import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { OrbViewSchema, ResourceWarningSchema } from "./index.ts";

const orb = {
  id: "orb",
  projectId: "project",
  harness: "pi",
  name: null,
  state: "running",
  stateVersion: 1,
  stateChangedAt: "2026-10-09T00:00:00Z",
  createdAt: "2026-10-09T00:00:00Z",
  updatedAt: "2026-10-09T00:00:00Z",
};

describe("public repository resource warnings", () => {
  it.each(["invalid_utf8", "invalid_yaml", "invalid_metadata", "duplicate_name"])(
    "accepts %s without exposing parser output",
    (code) => {
      const warning = { path: ".agents/skills/example/SKILL.md", code };
      expect(Check(ResourceWarningSchema, warning)).toBe(true);
      expect(Check(OrbViewSchema, { ...orb, resourceWarnings: [warning] })).toBe(true);
    },
  );
  it("keeps the field optional and allows an empty list", () => {
    expect(Check(OrbViewSchema, orb)).toBe(true);
    expect(Check(OrbViewSchema, { ...orb, resourceWarnings: [] })).toBe(true);
  });
  it.each([
    { path: 1, code: "invalid_yaml" },
    { path: "SKILL.md", code: "unknown" },
    { path: "SKILL.md" },
    { path: "SKILL.md", code: "invalid_yaml", yaml: "secret: token" },
  ])("rejects malformed warnings: %j", (warning) => {
    expect(Check(ResourceWarningSchema, warning)).toBe(false);
    expect(Check(OrbViewSchema, { ...orb, resourceWarnings: [warning] })).toBe(false);
  });
});
