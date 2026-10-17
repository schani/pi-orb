import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { CallableCatalog } from "./catalog.ts";
import { openCodemodeHarness } from "./testkit/codemode.ts";

const fixture = openCodemodeHarness;
function expectLimit(result: ToolExecutionResult) {
  expect(result.isError).toBe(true);
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "resource_limit" }));
  expect(JSON.stringify(result.output)).toContain("Reduce batch size or callback output");
}

it("rejects excessive concurrent callbacks, cancels admitted I/O and does not commit writes", async () => {
  let active = 0;
  let peak = 0;
  let cancelled = 0;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const f = await fixture(
    new CallableCatalog([
      defineTool({
        name: "hold",
        description: "hold",
        parameters: Type.Object({}),
        execute: async (_args, _api, context) =>
          new Promise((resolve) => {
            active++;
            peak = Math.max(peak, active);
            if (active === 7) entered();
            context.abortSignal?.addEventListener(
              "abort",
              () => {
                active--;
                cancelled++;
                resolve({ output: [] });
              },
              { once: true },
            );
          }),
      }),
      defineTool({
        name: "gate",
        description: "gate",
        parameters: Type.Object({}),
        execute: async () => {
          await ready;
          return { output: [] };
        },
      }),
    ]),
  );
  try {
    await f.run('store("key", "original");');
    const result = await f.run(
      'store("key", "bad"); const held=Array.from({length:7},()=>tools.hold({})); await tools.gate({}); await Promise.all([...held,tools.hold({}),tools.hold({})]);',
    );
    expectLimit(result);
    expect(peak).toBeLessThanOrEqual(8);
    expect(active).toBe(0);
    expect(cancelled).toBeGreaterThanOrEqual(7);
    expect((await f.run('text(load("key"));')).output).toContainEqual({
      type: "text",
      text: "original",
    });
  } finally {
    await f.close();
  }
});

it("settles an outstanding callback on caller abort without merging store writes", async () => {
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let cancelled = false;
  const f = await fixture(
    new CallableCatalog([
      defineTool({
        name: "hold",
        description: "hold",
        parameters: Type.Object({}),
        execute: async (_args, _api, context) =>
          new Promise((resolve) => {
            context.abortSignal?.addEventListener(
              "abort",
              () => {
                cancelled = true;
                resolve({ output: [] });
              },
              { once: true },
            );
            entered();
          }),
      }),
    ]),
  );
  try {
    await f.run('store("key", "original");');
    const pending = f.run('store("key", "bad"); await tools.hold({});');
    await ready;
    await f.abort();
    expect((await pending).isError).toBe(true);
    expect(cancelled).toBe(true);
    expect((await f.run('text(load("key"));')).output).toContainEqual({
      type: "text",
      text: "original",
    });
  } finally {
    await f.close();
  }
});

it("bounds cumulative calls including discovery and preserves completed summaries", async () => {
  const f = await fixture(
    new CallableCatalog([
      defineTool({
        name: "small",
        description: "small",
        parameters: Type.Object({}),
        execute: async () => ({ output: [{ type: "text", text: "ok" }] }),
      }),
    ]),
  );
  try {
    const result = await f.run(
      'await tools.small({}); for(let i=0;i<256;i++) await describeTool("small");',
    );
    expectLimit(result);
    expect(result.details).toMatchObject({
      calls: [expect.objectContaining({ name: "small", status: "ok" })],
    });
  } finally {
    await f.close();
  }
});

it("rejects serialized arguments before invoking a host callback", async () => {
  let calls = 0;
  const f = await fixture(
    new CallableCatalog([
      defineTool({
        name: "arg",
        description: "arg",
        parameters: Type.Object({ data: Type.String() }),
        execute: async () => {
          calls++;
          return { output: [] };
        },
      }),
    ]),
  );
  try {
    expectLimit(await f.run('await tools.arg({data:"é".repeat(4*1024*1024)});'));
    expect(calls).toBe(0);
  } finally {
    await f.close();
  }
});

it("bounds cumulative argument traffic across individually admissible calls", async () => {
  let calls = 0;
  const f = await fixture(
    new CallableCatalog([
      defineTool({
        name: "arg",
        description: "arg",
        parameters: Type.Object({ data: Type.String() }),
        execute: async () => {
          calls++;
          return { output: [] };
        },
      }),
    ]),
  );
  try {
    expectLimit(
      await f.run('for(let i=0;i<5;i++) await tools.arg({data:"x".repeat(2*1024*1024)});'),
    );
    expect(calls).toBe(3);
  } finally {
    await f.close();
  }
});

it("allows eight simultaneous callbacks with a deterministic release barrier", async () => {
  const releases: (() => void)[] = [];
  let peak = 0;
  const f = await fixture(
    new CallableCatalog([
      defineTool({
        name: "batch",
        description: "batch",
        parameters: Type.Object({}),
        execute: async () =>
          new Promise((resolve) => {
            releases.push(() => resolve({ output: [{ type: "text", text: "ok" }] }));
            peak = Math.max(peak, releases.length);
            if (releases.length === 8) for (const release of releases) release();
          }),
      }),
    ]),
  );
  try {
    const result = await f.run(
      "text((await Promise.all(Array.from({length:8},()=>tools.batch({})))).length);",
    );
    expect(result.isError).toBe(false);
    expect(result.output).toContainEqual({ type: "text", text: "8" });
    expect(peak).toBe(8);
  } finally {
    await f.close();
  }
});

it("bounds cumulative serialized replies without script output and without losing completed calls", async () => {
  const f = await fixture(
    new CallableCatalog([
      defineTool({
        name: "reply",
        description: "reply",
        parameters: Type.Object({}),
        execute: async () => ({ output: [{ type: "text", text: "x".repeat(4 * 1024 * 1024) }] }),
      }),
    ]),
  );
  try {
    const result = await f.run('store("bad",true); for(let i=0;i<17;i++) await tools.reply({});');
    expectLimit(result);
    expect(
      (result.details as { calls: { status: string }[] }).calls.some((c) => c.status === "ok"),
    ).toBe(true);
    expect((await f.run('text(load("bad")===undefined);')).output).toContainEqual({
      type: "text",
      text: "true",
    });
  } finally {
    await f.close();
  }
});

it("applies reply budgets to public discovery globals", async () => {
  const catalog = new CallableCatalog([]);
  catalog.namespace({ name: "large", description: "x".repeat(4 * 1024 * 1024) });
  const f = await fixture(catalog);
  try {
    expectLimit(await f.run('for(let i=0;i<17;i++) await describeNamespace("large");'));
  } finally {
    await f.close();
  }
});

it("preserves a real 20 MiB image callback and discovery parity", async () => {
  const png = Buffer.alloc(20 * 1024 * 1024, 97);
  Buffer.from("89504e470d0a1a0a", "hex").copy(png);
  const data = png.toString("base64");
  const f = await fixture(
    new CallableCatalog([
      defineTool({
        name: "picture",
        description: "picture",
        parameters: Type.Object({}),
        execute: async () => ({ output: [{ type: "image", data, mimeType: "image/png" }] }),
      }),
    ]),
  );
  try {
    const result = await f.run(
      'text((await searchTools("picture"))[0].name); const blocks=await tools.picture({}); text(blocks[0].data.length); image({...blocks[0],data:blocks[0].data.slice(0,4*1024*1024)});',
    );
    expect(result.isError, JSON.stringify(result.output?.filter((b) => b.type === "text"))).toBe(
      false,
    );
    expect(result.output).toContainEqual({
      type: "image",
      data: data.slice(0, 4 * 1024 * 1024),
      mimeType: "image/png",
    });
    const lines = result.output?.flatMap((block) =>
      block.type === "text" ? block.text.split("\n") : [],
    );
    expect(lines).toContain(String(data.length));
    expect(lines).toContain("picture");
  } finally {
    await f.close();
  }
});
