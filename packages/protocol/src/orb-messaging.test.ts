import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { OrbSendRequestSchema } from "./orb-messaging.ts";

it("accepts only target, content and retry identity, never sender provenance", () => {
  const request = {
    v: 1,
    orbId: "00000000-0000-4000-8000-000000000001",
    message: "hi",
    requestId: "fixed",
  };
  expect(Check(OrbSendRequestSchema, request)).toBe(true);
  for (const invalid of [
    { ...request, senderOrbId: request.orbId },
    { ...request, system: { kind: "orb_message" } },
    { ...request, requestId: "" },
    { ...request, orbId: "bad" },
    { ...request, message: "" },
  ])
    expect(Check(OrbSendRequestSchema, invalid)).toBe(false);
});
