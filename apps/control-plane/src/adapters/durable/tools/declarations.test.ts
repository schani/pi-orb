import { renderToolSignature, schemaToType } from "@earendil-works/pi-codemode";
import { expect, it } from "vitest";

it("keeps normal descriptions and constraint tags", () => {
  expect(
    schemaToType(
      {
        type: "object",
        properties: { count: { type: "integer", description: "Number of items", minimum: 1 } },
        required: ["count"],
      },
      { maxChars: 16_000 },
    ),
  ).toBe("{\n  // Number of items\n  // @integer @minimum 1\n  count: number;\n}");
});

it("drops oversized descriptions without losing references, types or requiredness", () => {
  const schema = {
    type: "object",
    $defs: { context: { type: "string" } },
    properties: {
      command: { type: "string", description: "x".repeat(40_000) },
      context: { $ref: "#/$defs/context" },
      llm_model: { type: "string" },
      conversation_id: { type: "string" },
    },
    required: ["command", "context", "llm_model"],
  };
  const original = structuredClone(schema);
  expect(renderToolSignature({ name: "exec", inputSchema: schema })).toBe(
    "exec(args: { command: string; context: string; conversation_id?: string; llm_model: string; }): Promise<unknown>;",
  );
  expect(schema).toEqual(original);
});

it("keeps structurally oversized schemas bounded after removing comments", () => {
  const schema = {
    type: "object",
    properties: Object.fromEntries(
      Array.from({ length: 2_000 }, (_, i) => [
        `field${i}`,
        { type: "string", description: "x".repeat(20) },
      ]),
    ),
  };
  expect(schemaToType(schema, { maxChars: 16_000 })).toBe("unknown");
});
