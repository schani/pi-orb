import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  OWNER_SKILL_NAME_PATTERN,
  OwnerSkillListSchema,
  OwnerSkillsSnapshotSchema,
  ownerSecretPath,
  ownerSkillPath,
  WriteOwnerSkillRequestSchema,
} from "./owner-skills.ts";

describe("owner skills and secrets protocol", () => {
  it("encodes owner resource paths", () => {
    expect(ownerSkillPath("a b")).toBe("/api/v1/owner-skills/a%20b");
    expect(ownerSecretPath("NPM_TOKEN")).toBe("/api/v1/owner-secrets/NPM_TOKEN");
  });

  it("accepts lowercase hyphenated skill names only", () => {
    const pattern = new RegExp(OWNER_SKILL_NAME_PATTERN);
    for (const name of ["release-notes", "pg2", "a"]) expect(pattern.test(name)).toBe(true);
    for (const name of ["", "-a", "a-", "a--b", "A", "a_b", "a b"])
      expect(pattern.test(name)).toBe(false);
  });

  it("closes list, write and runtime snapshot shapes", () => {
    const item = {
      name: "release-notes",
      description: "Draft release notes.",
      content: "---\nname: release-notes\ndescription: Draft release notes.\n---\n",
      updatedAt: "2026-10-26T00:00:00.000Z",
    };
    expect(Check(OwnerSkillListSchema, { items: [item] })).toBe(true);
    expect(Check(OwnerSkillListSchema, { items: [{ ...item, extra: 1 }] })).toBe(false);
    expect(Check(WriteOwnerSkillRequestSchema, { content: item.content })).toBe(true);
    expect(Check(WriteOwnerSkillRequestSchema, { content: "a\0b" })).toBe(false);
    expect(
      Check(OwnerSkillsSnapshotSchema, { skills: [{ name: item.name, content: item.content }] }),
    ).toBe(true);
    expect(
      Check(OwnerSkillsSnapshotSchema, { skills: [{ name: "Bad", content: item.content }] }),
    ).toBe(false);
  });
});
