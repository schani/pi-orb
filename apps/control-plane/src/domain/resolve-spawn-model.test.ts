import { describe, expect, it } from "vitest";
import { resolveSpawnModel } from "./orb-spawn-model.ts";

const opus = {
  provider: "claude",
  id: "opus",
  name: "Opus",
  thinkingLevels: [],
  aliases: ["claude-opus-resolved"],
};
const sol = { provider: "openai-codex", id: "gpt-6.1-sol", name: "Sol", thinkingLevels: [] };
const catalog = { models: [opus, sol], disconnected: [] };
describe("canonical spawn model", () => {
  it.each([
    "Opus",
    "opus",
    "claude/opus",
    "claude-opus-resolved",
    "claude/claude-opus-resolved",
    { provider: "claude", id: "opus" },
    { provider: "claude", id: "claude-opus-resolved" },
  ])("canonicalizes %j to the advertised family", (selector) => {
    expect(resolveSpawnModel(selector, catalog)._unsafeUnwrap()).toEqual({
      model: { provider: "claude", id: "opus" },
      harness: "claude",
    });
  });
  it("does not guess unadvertised IDs from a family name", () => {
    expect(resolveSpawnModel("claude/claude-opus-retired", catalog).isErr()).toBe(true);
  });
  it("rejects ambiguous names with qualified suggestions", () => {
    const result = resolveSpawnModel("Sol", {
      models: [sol, { ...opus, name: "Sol" }],
      disconnected: [],
    });
    expect(result.isErr() && result.error.reason).toBe("ambiguous");
    expect(result.isErr() && result.error.message).toContain("openai-codex/gpt-6.1-sol");
    expect(result.isErr() && result.error.message).toContain("claude/opus");
  });
  it("never assigns an unsupported harness", () => {
    expect(
      resolveSpawnModel("Other", {
        models: [{ ...opus, provider: "other", name: "Other" }],
        disconnected: [],
      }).isErr(),
    ).toBe(true);
  });
});
