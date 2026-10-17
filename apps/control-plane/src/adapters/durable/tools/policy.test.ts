import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, LiveDoc } from "@earendil-works/pi-durable";
import { okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { CallableCatalog } from "./catalog.ts";
import { openCodemodeHarness } from "./testkit/codemode.ts";

const ctx = BACKGROUND_CONTEXT;
it("discovers normalized names, namespaces and ranked bounded declarations", async () => {
  const catalog = new CallableCatalog([
    defineTool({
      name: "orb_self",
      description: "Current identity",
      parameters: Type.Object({}),
      execute: async () => ({}),
    }),
    defineTool({
      name: "mcp__dev-radius__search",
      description: "Find issues",
      parameters: Type.Object({ query: Type.String() }),
      execute: async () => ({}),
    }),
  ]);
  catalog.metadata("mcp__dev-radius__search", {
    namespace: { name: "mcp__dev-radius", instructions: "Search incidents" },
    deferred: true,
  });
  const fixture = await openCodemodeHarness(catalog);
  try {
    const result = await fixture.run(`text({
      declaration: (await describeTool("mcp__dev_radius__search")).includes("Promise<string | Array<"),
      matches: (await searchTools("issues", { namespace: "dev_radius", limit: 1 })).map((tool) => tool.name),
      orb: (await describeNamespace("orb")).tools,
      instructions: (await describeNamespace("dev_radius")).instructions
    });`);
    expect(result.isError).toBe(false);
    expect(result.output).toContainEqual({
      type: "text",
      text: JSON.stringify({
        declaration: true,
        matches: ["mcp__dev_radius__search"],
        orb: ["orb_self"],
        instructions: "Search incidents",
      }),
    });
  } finally {
    await fixture.close();
  }
});
it("materializes nested streamed output without leaking it and formats string returns", async () => {
  const catalog = new CallableCatalog([
    defineTool({
      name: "stream",
      description: "stream",
      parameters: Type.Object({}),
      execute: async (_args, api) => {
        api.output("secret large output");
        api.diagnostic({ severity: "info", message: "done" });
        await api.details({ done: true }, ctx);
        return {};
      },
    }),
  ]);
  const fixture = await openCodemodeHarness(catalog);
  try {
    const result = await fixture.run(
      "const result=await tools.stream({}); return result.slice(0,6);",
    );
    expect(result.isError).toBe(false);
    expect(result.output).toContainEqual({ type: "text", text: "secret" });
    const live = await fixture.harness.snapshot(LiveDoc, fixture.root.id, ctx);
    expect(live?.tools?.[0]?.output ?? "").not.toContain("secret large output");
    expect(JSON.stringify(result.details)).toContain('"status":"ok"');
  } finally {
    await fixture.close();
  }
});
it("applies options and spills aggregate output through a scoped reader", async () => {
  let spilled = "";
  const fixture = await openCodemodeHarness(new CallableCatalog([]), {
    files: {
      spill: (text) => {
        spilled = text;
        return okAsync("artifact:private/1");
      },
    },
  });
  try {
    const result = await fixture.run(
      '// @options: {"max_output_tokens": 8}\ntext("a".repeat(200)); return "end";',
    );
    expect(spilled).toContain("end");
    expect(JSON.stringify(result.output)).toContain("artifact:private/1");
    expect(JSON.stringify(result.output).length).toBeLessThan(600);
    const invalid = await fixture.run('// @options: {"timeout_ms": -1}\nreturn 1;');
    expect(invalid.isError).toBe(true);
  } finally {
    await fixture.close();
  }
});
