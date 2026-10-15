import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { OrbSpawnRequestSchema } from "./orb-spawn.ts";

describe("spawn model selector", () => {
  it.each([{ provider: "claude", id: "opus" }])("accepts %j", (model) => {
    expect(Check(OrbSpawnRequestSchema, { prompt: "work", model })).toBe(true);
  });
  it.each([
    "",
    "Sol",
    "claude/opus",
    null,
    {},
    { provider: "claude" },
    { provider: "claude", id: "opus", effort: "high" },
  ])("rejects %j", (model) => {
    expect(Check(OrbSpawnRequestSchema, { prompt: "work", model })).toBe(false);
  });
  it("keeps omission valid and rejects a harness override", () => {
    expect(Check(OrbSpawnRequestSchema, { prompt: "work" })).toBe(true);
    expect(Check(OrbSpawnRequestSchema, { prompt: "work", harness: "claude" })).toBe(false);
  });
});
