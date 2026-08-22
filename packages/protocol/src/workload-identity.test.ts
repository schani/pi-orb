import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TTL_SECONDS,
  ID_TOKEN_PATH,
  IdTokenErrorSchema,
  IdTokenRequestSchema,
  IdTokenResponseSchema,
  MAX_AUDIENCE_BYTES,
  MAX_TTL_SECONDS,
  MIN_TTL_SECONDS,
  MintFailureCodeSchema,
} from "./workload-identity.ts";

describe("workload identity contract", () => {
  it("routes id-token minting beside the runtime token prefix", () => {
    expect(ID_TOKEN_PATH).toBe("/runtime/v1/id-token");
  });

  it("bounds the token lifetime with the default inside the range", () => {
    expect(MIN_TTL_SECONDS).toBe(60);
    expect(MAX_TTL_SECONDS).toBe(3600);
    expect(DEFAULT_TTL_SECONDS).toBe(600);
    expect(DEFAULT_TTL_SECONDS).toBeGreaterThanOrEqual(MIN_TTL_SECONDS);
    expect(DEFAULT_TTL_SECONDS).toBeLessThanOrEqual(MAX_TTL_SECONDS);
    expect(MAX_AUDIENCE_BYTES).toBe(512);
  });

  it("requires a non-empty audience and an in-range integer lifetime", () => {
    expect(Check(IdTokenRequestSchema, { audience: "urn:example:service" })).toBe(true);
    expect(Check(IdTokenRequestSchema, { audience: "a", ttlSeconds: MIN_TTL_SECONDS })).toBe(true);
    expect(Check(IdTokenRequestSchema, { audience: "a", ttlSeconds: MAX_TTL_SECONDS })).toBe(true);
    expect(Check(IdTokenRequestSchema, { audience: "" })).toBe(false);
    expect(Check(IdTokenRequestSchema, {})).toBe(false);
    expect(Check(IdTokenRequestSchema, { audience: "a", ttlSeconds: MIN_TTL_SECONDS - 1 })).toBe(
      false,
    );
    expect(Check(IdTokenRequestSchema, { audience: "a", ttlSeconds: MAX_TTL_SECONDS + 1 })).toBe(
      false,
    );
    expect(Check(IdTokenRequestSchema, { audience: "a", ttlSeconds: 90.5 })).toBe(false);
    // Identity is derived from the bearer alone: a caller-supplied claim is
    // not merely ignored, it is rejected.
    expect(Check(IdTokenRequestSchema, { audience: "a", orbId: "other-orb" })).toBe(false);
  });

  it("returns the token and nothing else", () => {
    expect(Check(IdTokenResponseSchema, { token: "header.payload.signature" })).toBe(true);
    expect(Check(IdTokenResponseSchema, {})).toBe(false);
    expect(Check(IdTokenResponseSchema, { token: "t", kid: "k" })).toBe(false);
  });

  it("covers the denial vocabulary and carries a delay only where one means something", () => {
    for (const error of ["invalid_request", "unauthorized", "not_mintable"]) {
      expect(Check(IdTokenErrorSchema, { error })).toBe(true);
      expect(Check(IdTokenErrorSchema, { error, message: "why" })).toBe(true);
      expect(Check(IdTokenErrorSchema, { error, retryAfterMs: 100 })).toBe(false);
    }
    expect(Check(IdTokenErrorSchema, { error: "rate_limited", retryAfterMs: 5_000 })).toBe(true);
    expect(Check(IdTokenErrorSchema, { error: "retryable", message: "signer unavailable" })).toBe(
      true,
    );
    expect(Check(IdTokenErrorSchema, { error: "unknown_token" })).toBe(false);
    // A denial never carries the token, the bearer, or the audience back.
    expect(Check(IdTokenErrorSchema, { error: "unauthorized", token: "t" })).toBe(false);
  });

  it("distinguishes a deterministic control-plane bug from a transient failure", () => {
    // Without its own code, an `invariant` store failure would have to be
    // reported as `retryable`, telling every caller to re-send a request that
    // can never succeed
    // (docs/postmortems/2026-08-11-orb-message-jsonb-param-encoding.md).
    expect(Check(IdTokenErrorSchema, { error: "internal" })).toBe(true);
    expect(Check(IdTokenErrorSchema, { error: "internal", message: "bad parameter" })).toBe(true);
    expect(Check(IdTokenErrorSchema, { error: "internal", retryAfterMs: 100 })).toBe(false);
  });

  it("names every durable mint failure without naming what the caller asked for", () => {
    for (const code of [
      "invalid_request",
      "not_mintable",
      "rate_limited",
      "signer_failure",
      "store_unavailable",
    ]) {
      expect(Check(MintFailureCodeSchema, code)).toBe(true);
    }
    // An unresolvable bearer has no orb row to record anything on.
    expect(Check(MintFailureCodeSchema, "unauthorized")).toBe(false);
    expect(Check(MintFailureCodeSchema, "urn:example:service")).toBe(false);
  });
});
