import { ClientActionSchema } from "@pi-orb/protocol";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { ClaudeOrbAgent } from "./agent.ts";

it("accepts messages but rejects composer shell actions at the protocol boundary", () => {
  expect(
    Check(ClientActionSchema, {
      type: "message",
      content: [{ type: "text", text: "!pwd" }],
      expectedHeadId: null,
    }),
  ).toBe(true);
  expect(
    Check(ClientActionSchema, {
      type: "shell",
      command: "pwd",
      excludeFromContext: false,
      expectedHeadId: null,
    }),
  ).toBe(false);
  expect(ClaudeOrbAgent.prototype).not.toHaveProperty("submitShell");
});
