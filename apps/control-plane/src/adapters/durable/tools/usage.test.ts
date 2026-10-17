import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, UsageDoc } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { CallableCatalog } from "./catalog.ts";
import { openCodemodeHarness } from "./testkit/codemode.ts";

it("aggregates nested usage once even when the script fails after real calls", async () => {
  const usage = {
    input: 1,
    output: 2,
    cacheRead: 3,
    cacheWrite: 4,
    reasoning: 1,
    totalTokens: 10,
    cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
  };
  const fixture = await openCodemodeHarness(
    new CallableCatalog([
      defineTool({
        name: "cost",
        description: "cost",
        parameters: Type.Object({}),
        execute: async () => ({ usage, output: [{ type: "text", text: "done" }] }),
      }),
    ]),
  );
  try {
    const result = await fixture.run(
      'await Promise.all([tools.cost({}),tools.cost({})]); throw new Error("partial");',
    );
    expect(result.isError).toBe(true);
    expect(result.usage).toBeUndefined();
    const ledger = await fixture.harness.snapshot(UsageDoc, fixture.root.id, BACKGROUND_CONTEXT);
    expect(ledger?.tools.cost?.totalTokens).toBe(20);
    expect(ledger?.tools.cost?.cost.total).toBe(20);
    expect(ledger?.tools.cost?.reasoning).toBe(2);
    expect(ledger?.tools).not.toHaveProperty("codemode");
  } finally {
    await fixture.close();
  }
});
