import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { okAsync } from "neverthrow";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { CallableCatalog } from "./catalog.ts";
import { openCodemodeHarness } from "./testkit/codemode.ts";

it("validates tool schemas without coercing direct arguments or inserting native defaults", async () => {
  const authorized: unknown[] = [];
  const executed: unknown[] = [];
  const catalog = new CallableCatalog(
    [
      defineTool({
        name: "native_schema",
        description: "native schema",
        parameters: Type.Object(
          {
            value: Type.String({ default: "must-not-repair-required" }),
            count: Type.Optional(Type.Integer({ default: 7 })),
            email: Type.Optional(Type.String({ format: "email" })),
          },
          { additionalProperties: false },
        ),
        execute: async (args) => {
          executed.push(args);
          return { output: [{ type: "text", text: args.value }] };
        },
      }),
    ],
    (_name, args) => {
      authorized.push(args);
      return okAsync(undefined);
    },
  );
  for (const args of [
    {},
    null,
    { value: 42 },
    { value: "ok", count: "2" },
    { value: "ok", count: null },
    { value: "ok", email: "INVALID_SCHEMA_CANARY_SECRET" },
    { value: "ok", extra: true },
  ]) {
    const result = await catalog.invoke(
      "native_schema",
      args,
      {} as ToolExecutionApi,
      BACKGROUND_CONTEXT,
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error).toEqual({
        code: "invalid_arguments",
        message: "Invalid arguments for native_schema",
      });
  }
  expect(authorized).toEqual([]);
  expect(executed).toEqual([]);
  const fixture = await openCodemodeHarness(catalog);
  try {
    const result = await fixture.run('text(await tools.native_schema({value:"exact"}));');
    expect(result.isError, JSON.stringify(result)).toBe(false);
    expect(result.output).toContainEqual({ type: "text", text: "exact" });
    expect(authorized).toEqual([{ value: "exact" }]);
    expect(executed).toEqual([{ value: "exact" }]);
  } finally {
    await fixture.close();
  }
});

it("accepts native coding-tool schemas at both catalog and harness boundaries", async () => {
  const native = CodingTools.tools?.find((tool) => tool.name === "bash");
  if (!native) return expect.fail("Native bash tool missing");
  const observed: unknown[] = [];
  const catalog = new CallableCatalog([
    defineTool({
      name: "native_coding_schema",
      description: "native coding schema",
      parameters: native.parameters,
      structuredOutputSchema: Type.String(),
      execute: async (args) => {
        observed.push(args);
        return { output: [{ type: "text", text: "accepted" }] };
      },
    }),
  ]);
  const invalid = await catalog.invoke(
    "native_coding_schema",
    { command: 42 },
    {} as ToolExecutionApi,
    BACKGROUND_CONTEXT,
  );
  expect(invalid.isErr()).toBe(true);
  expect(observed).toEqual([]);
  const valid = await catalog.invoke(
    "native_coding_schema",
    { command: "exact", timeout: 2 },
    {} as ToolExecutionApi,
    BACKGROUND_CONTEXT,
  );
  expect(valid.isOk()).toBe(true);
  const fixture = await openCodemodeHarness(catalog);
  try {
    const result = await fixture.run(
      'text(await tools.native_coding_schema({command:"exact",timeout:"2"}));',
    );
    expect(result.isError, JSON.stringify(result)).toBe(false);
    expect(observed).toEqual([
      { command: "exact", timeout: 2 },
      { command: "exact", timeout: 2 },
    ]);
  } finally {
    await fixture.close();
  }
});
