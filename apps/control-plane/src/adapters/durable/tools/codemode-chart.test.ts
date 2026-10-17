import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { CHART_MAX_PER_SCRIPT } from "@pi-orb/protocol";
import { describe, expect, it } from "vitest";
import { CallableCatalog } from "./catalog.ts";
import { codemodeTool } from "./codemode.ts";
import { openCodemodeHarness } from "./testkit/codemode.ts";

const ctx = BACKGROUND_CONTEXT;

async function run(code: string) {
  const fixture = await openCodemodeHarness(new CallableCatalog([]));
  try {
    return await fixture.run(code);
  } finally {
    await fixture.close();
  }
}

const textOf = (result: Awaited<ReturnType<typeof run>>) =>
  (result.output ?? []).map((item) => (item.type === "text" ? item.text : "")).join("\n");

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

  it("reprojects journaled charts exactly once on a cached native replay", async () => {
    const fixture = await openCodemodeHarness(new CallableCatalog([]), { holdForReplay: true });
    try {
      const result = await fixture.run(`await chart(${latency}); text("done");`);
      expect((await fixture.replay()).details).toEqual(result.details);
      expect((result.details as { charts: unknown[] }).charts).toHaveLength(1);
    } finally {
      await fixture.close();
    }
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

  it("keeps acknowledged charts in the persisted aborted tool result", async () => {
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const fixture = await openCodemodeHarness(
      new CallableCatalog([
        defineTool({
          name: "hold",
          description: "hold",
          parameters: Type.Object({}),
          execute: async (_args, _api, context) => {
            entered();
            await new Promise<void>((resolve) => {
              if (context.abortSignal?.aborted) resolve();
              else context.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
            });
            return { output: [] };
          },
        }),
      ]),
    );
    try {
      const pending = fixture.run(`await chart(${latency}); await tools.hold({});`);
      await waiting;
      await fixture.root.abort(ctx, { background: true });
      await pending;
      const entries = await fixture.storage.scanEntries(
        { conversationId: fixture.root.id },
        1000,
        undefined,
        ctx,
      );
      const result = entries.items
        .flatMap((entry) => entry.model ?? [])
        .find((message) => message.role === "toolResult" && message.toolName === "codemode");
      expect(result).toMatchObject({
        isError: true,
        details: { charts: [{ title: "checkout-api p95" }] },
      });
      expect(result && JSON.stringify(result.content)).not.toContain("1792001100000");
    } finally {
      await fixture.close();
    }
  });

  it("documents chart() for the model", () => {
    expect(codemodeTool(new CallableCatalog([]), new Set()).description).toMatch(/chart\(/);
  });
});
