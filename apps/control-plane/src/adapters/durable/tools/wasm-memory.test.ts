import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const wasm = readFileSync(require.resolve("quickjs-wasi/quickjs.wasm"));
const vmUrl = new URL("./runtime/vm.js", import.meta.resolve("@earendil-works/pi-codemode"));

// Native children must not inherit coverage, loaders, or engine flags.
it("keeps exported wasm initial capacity and growth outside Node's host memory counters", () => {
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { getHeapStatistics } from "node:v8";
    import { readFileSync } from "node:fs";
    import { QuickJS } from "quickjs-wasi";
    const rows = [];
    const sample = (stage, memory) => rows.push({ stage, ...getHeapStatistics(), linear: memory?.buffer.byteLength ?? 0 });
    sample("before");
    const module = new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0,5,6,1,1,128,4,128,8,7,10,1,6,109,101,109,111,114,121,2,0]));
    const memory = new WebAssembly.Instance(module).exports.memory;
    sample("initial", memory);
    memory.grow(512);
    new Uint8Array(memory.buffer).fill(7);
    await new Promise(setImmediate);
    sample("grown", memory);
    const qjsModule = await QuickJS.resolveModule(readFileSync(new URL(import.meta.resolve("quickjs-wasi/quickjs.wasm"))));
    const qjs = new QuickJS(qjsModule);
    sample("quickjs-before");
    const { instance } = await QuickJS.instantiate(qjsModule, qjs);
    qjs.setInstance(instance);
    const owned = qjs._getMemory();
    sample("quickjs-initial", owned);
    instance.exports._initialize();
    instance.exports.qjs_init();
    sample("quickjs-ready", owned);
    qjs.evalCode("globalThis.held = new Uint8Array(32*1024*1024).fill(7)").dispose();
    sample("quickjs-grown", owned);
    console.log(JSON.stringify(rows));
    qjs.dispose();
  `,
    ],
    { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "", NODE_V8_COVERAGE: "" } },
  );
  expect(child.status, child.stderr).toBe(0);
  const rows = JSON.parse(child.stdout) as {
    external_memory: number;
    used_heap_size: number;
    linear: number;
  }[];
  const row = (index: number) => {
    const value = rows[index];
    assert.ok(value);
    return value;
  };
  expect(rows[1]?.linear).toBe(32 * 1024 * 1024);
  expect(rows[2]?.linear).toBe(64 * 1024 * 1024);
  // 1 MiB tolerates adapter metadata, but rejects either capacity being counted again.
  expect(Math.abs(row(1).external_memory - row(0).external_memory)).toBeLessThan(1024 * 1024);
  expect(Math.abs(row(2).external_memory - row(1).external_memory)).toBeLessThan(1024 * 1024);
  expect(row(4).linear).toBeGreaterThan(1024 * 1024);
  expect(Math.abs(row(4).external_memory - row(3).external_memory)).toBeLessThan(1024 * 1024);
  expect(row(6).linear - row(5).linear).toBeGreaterThanOrEqual(32 * 1024 * 1024);
  expect(Math.abs(row(6).external_memory - row(5).external_memory)).toBeLessThan(1024 * 1024);
  for (const [before, after] of [
    [0, 1],
    [1, 2],
    [3, 4],
    [5, 6],
  ] as const) {
    const host = (index: number) => row(index).used_heap_size + row(index).external_memory;
    expect(Math.abs(host(after) - host(before))).toBeLessThan(1024 * 1024);
  }
});

it("publishes a fresh owned-memory getter before guest callbacks and clears it on disposal", async () => {
  // Inspect the sealed SDK boundary, not a first-party route to QuickJS internals.
  const { startVm } = await import(/* @vite-ignore */ vmUrl.href);
  let getBytes: (() => number) | undefined;
  const samples: number[] = [];
  let peak = 0;
  const session = await startVm({
    wasm,
    data: {
      code: 'text("before"); globalThis.held = new Uint8Array(32*1024*1024).fill(1); text("after");',
      tools: [],
      globals: [],
      store: {},
      memoryLimitBytes: 256 * 1024 * 1024,
    },
    onWasmMemory: (get: () => number) => {
      getBytes = get;
    },
    shouldInterrupt: () => false,
    post: (message: { type: string }) => {
      if (message.type !== "output") return;
      const bytes = getBytes?.() ?? 0;
      samples.push(bytes);
      peak = Math.max(peak, bytes);
    },
  });
  try {
    expect(getBytes).toBeTypeOf("function");
    expect(samples).toHaveLength(2);
    expect(samples[0]).toBeGreaterThan(0);
    const [before, after] = samples;
    assert.ok(before !== undefined && after !== undefined);
    expect(after - before).toBeGreaterThanOrEqual(32 * 1024 * 1024);
  } finally {
    session.dispose();
  }
  expect(getBytes?.()).toBe(0);
  expect(peak).toBe(samples[1]);
});

it("samples owned wasm for a quiet script's completion before disposal", async () => {
  const { startVm } = await import(/* @vite-ignore */ vmUrl.href);
  let getBytes: (() => number) | undefined;
  let peak = 0;
  const messages: string[] = [];
  const session = await startVm({
    wasm,
    data: { code: "", tools: [], globals: [], store: {}, memoryLimitBytes: 256 * 1024 * 1024 },
    onWasmMemory: (get: () => number) => {
      getBytes = get;
    },
    shouldInterrupt: () => false,
    post: (message: { type: string }) => {
      messages.push(message.type);
      peak = Math.max(peak, getBytes?.() ?? 0);
    },
  });
  try {
    expect(messages).toEqual(["done"]);
    expect(peak).toBeGreaterThan(1024 * 1024);
  } finally {
    session.dispose();
  }
  expect(getBytes?.()).toBe(0);
  expect(peak).toBeGreaterThan(1024 * 1024);
});
