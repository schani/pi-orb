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

it("drops constraint tags when the untagged type fits the cap", () => {
  expect(
    schemaToType(
      {
        type: "object",
        properties: { count: { type: "integer", minimum: 1 } },
        required: ["count"],
      },
      { maxChars: 18 },
    ),
  ).toBe("{ count: number; }");
});

it("renders inputs with oversized descriptions as unknown without changing the schema", () => {
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
  expect
    .soft(renderToolSignature({ name: "exec", inputSchema: schema }))
    .toBe("exec(args: unknown): Promise<unknown>;");
  expect(schema).toEqual(original);
  const compact = structuredClone(schema);
  delete (compact.properties.command as { description?: string }).description;
  expect(renderToolSignature({ name: "exec", inputSchema: compact })).toBe(
    "exec(args: { command: string; context: string; conversation_id?: string; llm_model: string; }): Promise<unknown>;",
  );
});

it("keeps structurally oversized schemas bounded", () => {
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
