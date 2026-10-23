import { Type } from "@earendil-works/pi-ai";
import { defineTool, hook, ToolTask } from "@earendil-works/pi-durable";
import { errAsync, okAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { CallableCatalog } from "./catalog.ts";
import { createDurableTools } from "./index.ts";
import { openCodemodeHarness } from "./testkit/codemode.ts";

describe("native Durable codemode integration", () => {
  it("registers the native replay-safe model tool, sections, and tools-only callables", async () => {
    const bundle = createDurableTools();
    try {
      expect(bundle.modelTools[0].replay).toBe("safe");
      expect(bundle.modelTools[0].callers).toEqual(["model"]);
      expect(bundle.extension.sections?.map((section) => section.key)).toContain("tool-catalogue");
      expect(bundle.extension.sections?.map((section) => section.key)).not.toContain("codemode");
      expect(
        bundle.extension.tools
          ?.filter((tool) => tool.name !== "codemode")
          .every((tool) => tool.callers?.join() === "tools"),
      ).toBe(true);
      const childNames = bundle.childExtension.tools?.map((tool) => tool.name) ?? [];
      expect(childNames).toContain("read");
      expect(childNames).not.toContain("subagent");
      expect(childNames).not.toContain("orb_spawn");
    } finally {
      await bundle.close();
    }
  });

  it("uses native nested task identities and never repeats completed calls on replay", async () => {
    const identities: string[] = [];
    const fixture = await openCodemodeHarness(
      new CallableCatalog([
        defineTool({
          name: "record",
          description: "record",
          parameters: Type.Object({ secret: Type.String() }),
          replay: "safe",
          execute: async (_args, api) => {
            identities.push(api.callId);
            return { output: [{ type: "text", text: "recorded" }] };
          },
        }),
      ]),
      { holdForReplay: true },
    );
    try {
      const result = await fixture.run('text(await tools.record({secret:"CANARY_SECRET"}));');
      expect(result.isError).toBe(false);
      expect(identities).toEqual([expect.stringMatching(/\/c1$/)]);
      expect(result.details).toMatchObject({ calls: [{ args: '["secret"]', status: "ok" }] });
      expect(JSON.stringify(result.details)).not.toContain("CANARY_SECRET");
      expect(await fixture.replay()).toEqual(result);
      expect(identities).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("routes authorization through actual Harness nested calls", async () => {
    let executed = false;
    const fixture = await openCodemodeHarness(
      new CallableCatalog(
        [
          defineTool({
            name: "blocked",
            description: "blocked",
            parameters: Type.Object({}),
            execute: async () => {
              executed = true;
              return { output: [] };
            },
          }),
        ],
        () => errAsync({ code: "forbidden", message: "Denied by policy" }),
      ),
    );
    try {
      const result = await fixture.run("await tools.blocked({});");
      expect(result.isError).toBe(true);
      expect(executed).toBe(false);
      expect(JSON.stringify(result.output)).toContain("Denied by policy");
    } finally {
      await fixture.close();
    }
  });

  it("projects metadata into native structured results, including MCP error envelopes", async () => {
    const catalog = new CallableCatalog([
      defineTool({
        name: "structured",
        description: "structured",
        parameters: Type.Object({}),
        structuredOutputSchema: Type.Object({ isError: Type.Boolean(), answer: Type.Number() }),
        execute: async () => ({
          isError: true,
          output: [{ type: "text", text: "private model output" }],
          structuredOutput: { isError: true, answer: 42 },
        }),
      }),
    ]);
    catalog.metadata("structured", { outputSchema: { type: "object" } });
    const fixture = await openCodemodeHarness(catalog);
    try {
      const result = await fixture.run("text(await tools.structured({}));");
      expect(result.isError).toBe(false);
      expect(JSON.stringify(result.output)).toContain("answer");
      expect(JSON.stringify(result.output)).not.toContain("private model output");
    } finally {
      await fixture.close();
    }
  });

  it("sanitizes native argument validation and throwing repair previews", async () => {
    let effects = 0;
    const fixture = await openCodemodeHarness(
      new CallableCatalog([
        defineTool({
          name: "invalid",
          description: "invalid",
          parameters: Type.Object({ count: Type.Number() }),
          execute: async () => {
            effects++;
            return { output: [] };
          },
        }),
        defineTool({
          name: "repair",
          description: "repair",
          parameters: Type.Object({}),
          prepareArguments: () => {
            throw new Error("REPAIR_CANARY_SECRET");
          },
          execute: async () => {
            effects++;
            return { output: [] };
          },
        }),
      ]),
    );
    try {
      for (const source of [
        'await tools.invalid({count:"ARG_CANARY_SECRET"});',
        "await tools.repair({});",
      ]) {
        const result = await fixture.run(source);
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).not.toContain("ARG_CANARY_SECRET");
        expect(JSON.stringify(result)).not.toContain("REPAIR_CANARY_SECRET");
        const caught = await fixture.run(`try {${source}} catch(error) {text(String(error));}`);
        expect(caught.isError).toBe(false);
        expect(JSON.stringify(caught.output)).toContain("Invalid arguments for");
        expect(JSON.stringify(caught)).not.toContain("ARG_CANARY_SECRET");
        expect(JSON.stringify(caught)).not.toContain("REPAIR_CANARY_SECRET");
      }
      expect(effects).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  it("bounds public nested summaries without dropping native calls", async () => {
    let effects = 0;
    const fixture = await openCodemodeHarness(
      new CallableCatalog([
        defineTool({
          name: "small",
          description: "small",
          parameters: Type.Object({}),
          execute: async () => {
            effects++;
            return { output: [] };
          },
        }),
      ]),
    );
    try {
      const result = await fixture.run("for(let i=0;i<70;i++) await tools.small({});");
      expect(result.isError).toBe(false);
      expect(effects).toBe(70);
      expect(result.details).toMatchObject({ omittedCalls: 6 });
      expect((result.details as { calls: unknown[] }).calls).toHaveLength(64);
    } finally {
      await fixture.close();
    }
  });

  it("runs native nested ToolTask hooks with parent ownership", async () => {
    const hooks: string[] = [];
    const fixture = await openCodemodeHarness(
      new CallableCatalog([
        defineTool({
          name: "hooked",
          description: "hooked",
          parameters: Type.Object({}),
          execute: async () => ({ output: [{ type: "text", text: "raw" }] }),
        }),
      ]),
      {
        hooks: [
          hook(ToolTask, {
            beforeTool: (call) => {
              if (call.name === "hooked") {
                expect(call.parent?.taskId).toBeDefined();
                hooks.push("before");
              }
            },
            afterTool: (call, result) => {
              if (call.name !== "hooked") return;
              hooks.push("after");
              return { ...result, structuredOutput: "hooked-value" };
            },
          }),
        ],
      },
    );
    try {
      const result = await fixture.run("text(await tools.hooked({}));");
      expect(result.isError).toBe(false);
      expect(result.output).toContainEqual({ type: "text", text: "hooked-value" });
      expect(hooks).toEqual(["before", "after"]);
    } finally {
      await fixture.close();
    }
  });

  it("uses private artifact storage rather than execution-environment temp files", async () => {
    const spills: string[] = [];
    const fixture = await openCodemodeHarness(new CallableCatalog([]), {
      files: {
        spill: (text) => {
          spills.push(text);
          return okAsync("/orb-artifacts/private-output");
        },
      },
    });
    try {
      const result = await fixture.run(
        '// @options: {"max_output_tokens": 20}\ntext("private".repeat(1000));',
      );
      expect(spills).toHaveLength(1);
      expect(result.details).toMatchObject({ fullOutputPath: "/orb-artifacts/private-output" });
      expect(JSON.stringify(result.output)).not.toContain("pi-codemode-");
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "codemode_output_truncated" })]),
      );
    } finally {
      await fixture.close();
    }
  });
});
