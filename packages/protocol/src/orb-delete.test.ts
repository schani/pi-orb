import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  OrbArchiveErrorSchema,
  OrbArchiveRequestSchema,
  OrbArchiveResponseSchema,
} from "./orb-archive.ts";
import {
  OrbDeleteErrorSchema,
  OrbDeleteRequestSchema,
  OrbDeleteResponseSchema,
} from "./orb-delete.ts";

const orbId = "abcdef00-0000-4000-abcd-000000000003";
describe.each([
  [
    "archive",
    OrbArchiveRequestSchema,
    OrbArchiveErrorSchema,
    OrbArchiveResponseSchema,
    "archiving",
  ],
  ["delete", OrbDeleteRequestSchema, OrbDeleteErrorSchema, OrbDeleteResponseSchema, "deleting"],
] as const)("%s cleanup schema", (_operation, schema, errorSchema, responseSchema, state) => {
  it.each([{ self: true }, { orbId }, { orbId: orbId.toUpperCase() }])(
    "accepts explicit cleanup intent %j",
    (request) => {
      expect(Check(schema, request)).toBe(true);
    },
  );
  it.each([
    undefined,
    null,
    {},
    { self: false },
    { self: true, orbId },
    { orbId: "short" },
    { orbId: "" },
    { self: true, force: true },
    { orbId, yes: true },
  ])("rejects ambiguous cleanup intent %j", (request) => {
    expect(Check(schema, request)).toBe(false);
  });

  it("accepts only the operation's response state and closed error shape", () => {
    expect(Check(responseSchema, { orbId, state })).toBe(true);
    expect(
      Check(responseSchema, { orbId, state: state === "archiving" ? "deleting" : "archiving" }),
    ).toBe(false);
    const error = { code: "conflict", message: "fenced", retryable: false };
    expect(Check(errorSchema, { error })).toBe(true);
    expect(Check(errorSchema, { error: { ...error, private: true } })).toBe(false);
  });
});
