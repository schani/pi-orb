import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  runtimeTokenPath,
  TOKEN_NAMES,
  TokenErrorSchema,
  TokenGrantSchema,
  TokenNameSchema,
  TokenRequestSchema,
} from "./broker.ts";

describe("runtime token contract", () => {
  it("builds the parameterized token path per name", () => {
    expect(runtimeTokenPath("model")).toBe("/runtime/v1/tokens/model");
    expect(runtimeTokenPath("github")).toBe("/runtime/v1/tokens/github");
  });

  it("names exactly the model and github tokens", () => {
    expect(TOKEN_NAMES).toEqual(["model", "github"]);
    for (const name of TOKEN_NAMES) {
      expect(Check(TokenNameSchema, name)).toBe(true);
    }
    expect(Check(TokenNameSchema, "model-token")).toBe(false);
    expect(Check(TokenNameSchema, "")).toBe(false);
    expect(Check(TokenNameSchema, 7)).toBe(false);
  });

  it("accepts requests with and without staleGeneration", () => {
    expect(Check(TokenRequestSchema, { reason: "startup" })).toBe(true);
    expect(Check(TokenRequestSchema, { reason: "expiring", staleGeneration: 3 })).toBe(true);
    expect(Check(TokenRequestSchema, { reason: "sideways" })).toBe(false);
    expect(Check(TokenRequestSchema, { reason: "startup", extra: true })).toBe(false);
  });

  it("accepts grants with and without accountId", () => {
    const base = { accessToken: "t", expiresAt: 1, generation: 1 };
    expect(Check(TokenGrantSchema, { ...base, accountId: "acct" })).toBe(true);
    expect(Check(TokenGrantSchema, base)).toBe(true);
    expect(Check(TokenGrantSchema, { ...base, accessToken: 1 })).toBe(false);
    expect(Check(TokenGrantSchema, { ...base, refresh: "nope" })).toBe(false);
  });

  it("covers the error vocabulary including unknown_token", () => {
    expect(Check(TokenErrorSchema, { error: "unauthorized" })).toBe(true);
    expect(Check(TokenErrorSchema, { error: "auth_required" })).toBe(true);
    expect(Check(TokenErrorSchema, { error: "unknown_token" })).toBe(true);
    expect(Check(TokenErrorSchema, { error: "retryable", message: "m", retryAfterMs: 5 })).toBe(
      true,
    );
    expect(Check(TokenErrorSchema, { error: "retryable" })).toBe(false);
    expect(Check(TokenErrorSchema, { error: "teapot" })).toBe(false);
  });
});
