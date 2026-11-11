import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { OrbDeleteRequestSchema } from "./orb-delete.ts";

const orbId = "abcdef00-0000-4000-abcd-000000000003";
it.each([{ self: true }, { orbId }, { orbId: orbId.toUpperCase() }])(
  "accepts explicit delete intent %j",
  (request) => {
    expect(Check(OrbDeleteRequestSchema, request)).toBe(true);
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
])("rejects ambiguous delete intent %j", (request) => {
  expect(Check(OrbDeleteRequestSchema, request)).toBe(false);
});
