import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { CallableCatalog } from "./catalog.ts";

it("prepares then validates and authorizes the same nested arguments", async () => {
  let observed: unknown;
  const catalog = new CallableCatalog(
    [
      defineTool({
        name: "prepare",
        description: "prepare",
        parameters: Type.Object({ value: Type.String() }),
        prepareArguments: (args) =>
          typeof args === "string" ? { value: args } : (args as { value: string }),
        execute: async (args) => ({ content: [{ type: "text", text: args.value }] }),
      }),
    ],
    (_name, args) => {
      observed = args;
      return okAsync(undefined);
    },
  );
  const result = await catalog.invoke(
    "prepare",
    "value",
    {} as ToolExecutionApi,
    BACKGROUND_CONTEXT,
  );
  expect(result.isOk()).toBe(true);
  expect(observed).toEqual({ value: "value" });
  if (result.isOk()) expect(result.value.content).toEqual([{ type: "text", text: "value" }]);
});
