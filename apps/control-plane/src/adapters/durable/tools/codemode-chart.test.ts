import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { CHART_MAX_PER_SCRIPT } from "@pi-orb/protocol";
import { describe, expect, it } from "vitest";
import { CallableCatalog } from "./catalog.ts";
import { codemodeTool } from "./codemode.ts";

const ctx = BACKGROUND_CONTEXT;

async function run(code: string) {
  const { MemoryStorage } = await import("@earendil-works/pi-durable");
  const harness = await Harness.open(
    new MemoryStorage(),
    { models: createModels(), registry: createRegistry() },
    ctx,
  );
  try {
    const root = await harness.root(ctx);
    const api = {
      conversationId: root.id,
      commit: root.commit.bind(root),
      callId: "call",
    } as ToolExecutionApi;
    return await codemodeTool(new CallableCatalog([]), new Set()).execute({ code }, api, ctx);
  } finally {
    await harness.close(ctx);
  }
}

const textOf = (result: Awaited<ReturnType<typeof run>>) =>
  (result.content ?? []).map((item) => (item.type === "text" ? item.text : "")).join("\n");

const latency = `{
  kind: "line",
  title: "checkout-api p95",
  unit: "ms",
  series: [{ name: "p95", points: [["2026-10-13T18:00:00Z", 180], [1792001100000, 410]] }],
}`;

describe("code-mode chart()", () => {
  it("records normalized charts in result details without sending the data to the model", async () => {
    const result = await run(`await chart(${latency}); text("done");`);
    expect(result.isError).toBe(false);
    expect((result.details as { charts?: unknown }).charts).toEqual([
      {
        kind: "line",
        title: "checkout-api p95",
        unit: "ms",
        series: [
          {
            name: "p95",
            points: [
              [Date.parse("2026-10-13T18:00:00Z"), 180],
              [1792001100000, 410],
            ],
          },
        ],
      },
    ]);
    expect(textOf(result)).toContain("done");
    expect(textOf(result)).not.toContain("1792001100000");
  });

  it("rejects an invalid spec inside the script with the validation message", async () => {
    const series = Array.from({ length: 7 }, (_, i) => `{ name: "s${i}", points: [[1, ${i}]] }`);
    const result = await run(`await chart({ kind: "line", title: "t", series: [${series}] });`);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/at most 6 series/);
    expect(result.details).not.toHaveProperty("charts");
  });

  it("keeps charts shown before a later script failure", async () => {
    const result = await run(`await chart(${latency}); throw new Error("later");`);
    expect(result.isError).toBe(true);
    expect((result.details as { charts?: unknown[] }).charts).toHaveLength(1);
  });

  it(`allows at most ${CHART_MAX_PER_SCRIPT} charts per script`, async () => {
    const result = await run(
      `for (let i = 0; i <= ${CHART_MAX_PER_SCRIPT}; i++) await chart(${latency});`,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(new RegExp(`at most ${CHART_MAX_PER_SCRIPT} charts`));
    expect((result.details as { charts?: unknown[] }).charts).toHaveLength(CHART_MAX_PER_SCRIPT);
  });

  it("documents chart() for the model", () => {
    expect(codemodeTool(new CallableCatalog([]), new Set()).description).toMatch(/chart\(/);
  });
});
