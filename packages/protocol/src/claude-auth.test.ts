import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { ClaudeAuthViewSchema, runtimeClaudeSubscriptionPath } from "./claude-auth.ts";

describe("Claude subscription auth protocol", () => {
  it("uses the incarnation-bearer runtime surface", () => {
    expect(runtimeClaudeSubscriptionPath).toBe("/runtime/v1/claude-subscription");
  });

  it("accepts public connection states", () => {
    for (const value of [
      { status: "disconnected" },
      {
        status: "connecting",
        challenge: { url: "https://claude.com/cai/oauth/authorize", needsCode: true },
      },
      { status: "connected", generation: 2 },
      { status: "failed", error: "Claude sign-in failed; reconnect" },
    ])
      expect(Check(ClaudeAuthViewSchema, value)).toBe(true);
  });

  it("rejects credential material in public responses", () => {
    for (const key of ["token", "access", "refresh", "code"]) {
      expect(Check(ClaudeAuthViewSchema, { status: "connected", [key]: "secret" })).toBe(false);
      expect(
        Check(ClaudeAuthViewSchema, { status: "connecting", challenge: { [key]: "secret" } }),
      ).toBe(false);
    }
  });

  it("rejects invalid states and credential generations", () => {
    expect(Check(ClaudeAuthViewSchema, { status: "other" })).toBe(false);
    for (const generation of [0, -1, 1.5]) {
      expect(Check(ClaudeAuthViewSchema, { status: "connected", generation })).toBe(false);
    }
  });
});
