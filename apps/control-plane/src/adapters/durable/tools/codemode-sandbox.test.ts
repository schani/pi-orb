import {
  type CodemodeHostCall,
  CodemodeSandbox,
  type CodemodeWasmModule,
} from "@earendil-works/pi-codemode";
import { expect, it, vi } from "vitest";
import { CALLBACK_LIMIT_MESSAGE, OUTPUT_LIMIT_MESSAGE } from "./callback-limits.js";
import { CodeModeMemory } from "./codemode-memory.ts";
import { createNativeCodemodeSandbox } from "./codemode-sandbox.ts";
import { CpuBudget } from "./cpu-budget.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("keeps native fingerprint, seeded randomness, virtual clock and ordered delivery on deterministic rerun", async () => {
  async function run(bounded: boolean) {
    const sandbox = bounded
      ? createNativeCodemodeSandbox()
      : new CodemodeSandbox({ memoryLimitBytes: 256 * 1024 * 1024 });
    const ready = deferred<void>();
    const calls: CodemodeHostCall[] = [];
    let fingerprint = "";
    const job = sandbox.start(
      "const seen=[]; const a=tools.first({random:Math.random(),at:Date.now()}).then(x=>seen.push([x,Date.now()])); const b=tools.second({}).then(x=>seen.push([x,Date.now()])); await Promise.all([a,b]); text(seen);",
      {
        startedAt: 1234,
        seed: 42,
        tools: [{ name: "first" }, { name: "second" }],
        onStarted: (value) => {
          fingerprint = value;
        },
        onCall: (call) => {
          calls.push(call);
          if (calls.length === 2) ready.resolve();
        },
      },
    );
    try {
      await ready.promise;
      job.deliver(2, 5678, calls[0]!.id, { ok: true, value: "first" });
      job.deliver(1, 2345, calls[1]!.id, { ok: true, value: "second" });
      const result = await job.result;
      expect(result.ok).toBe(true);
      return { result, calls, fingerprint };
    } finally {
      await sandbox.close();
    }
  }
  const original = await run(false);
  const bounded = await run(true);
  expect(bounded.fingerprint).toBe(original.fingerprint);
  expect(bounded.calls).toEqual(original.calls);
  expect(bounded.result.output).toEqual(original.result.output);
});

it.each(["abort", "timeout", "close"] as const)(
  "stops a parked native start on %s and holds resources until actual exit",
  async (mode) => {
    const budget = new CpuBudget(
      () => 0n,
      () => ({}),
      () => {},
    );
    Atomics.store(new BigInt64Array(budget.buffer, 0, 1), 0, -1n);
    const memory = new CodeModeMemory(
      () => {},
      undefined,
      () => ({}),
      () => {},
    );
    const admitted = deferred<void>();
    const exited = deferred<void>();
    let stats!: BigInt64Array;
    let releaseCount = 0;
    const sandbox = createNativeCodemodeSandbox({
      cpuBudget: budget,
      memory,
      acquireWorker: () => {
        admitted.resolve();
        return () => {
          releaseCount++;
          exited.resolve();
        };
      },
      onWorkerStarted: () => {
        stats = new BigInt64Array(sandbox.workerStats()[0]!.cpuStats);
      },
    });
    const abort = new AbortController();
    if (mode === "timeout") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let callbacks = 0;
    const job = sandbox.start('store("bad", true); await tools.never({});', {
      startedAt: 1,
      seed: 1,
      signal: abort.signal,
      timeoutMs: 30_000,
      tools: [{ name: "never" }],
      onCall: () => {
        callbacks++;
      },
    });
    try {
      await admitted.promise;
      // Node supplies waitAsync; the repository targets an older TypeScript library.
      const atomics = Atomics as typeof Atomics & {
        waitAsync(
          array: BigInt64Array,
          index: number,
          value: bigint,
        ):
          | { async: false; value: "not-equal" | "timed-out" }
          | { async: true; value: Promise<"ok" | "timed-out"> };
      };
      const parked = atomics.waitAsync(stats, 3, 0n);
      if (parked.async) await parked.value;
      expect(Atomics.load(stats, 3)).toBe(1n);
      expect(budget.active).toBe(1);
      expect(memory.active).toBe(1);
      if (mode === "timeout") await vi.advanceTimersByTimeAsync(30_000);
      else if (mode === "close") await sandbox.close();
      else abort.abort();
      const result = await job.result;
      expect(result).toMatchObject({
        ok: false,
        error: { kind: mode === "timeout" ? "timeout" : "aborted" },
      });
      expect("storeWrites" in result).toBe(false);
      expect(callbacks).toBe(0);
      await exited.promise;
      expect(budget.active).toBe(0);
      expect(memory.active).toBe(0);
      expect(releaseCount).toBe(1);
    } finally {
      vi.useRealTimers();
      await sandbox.close();
    }
  },
);

it("denies late worker admission after close while wasm is loading", async () => {
  const wasm = deferred<CodemodeWasmModule>();
  let admitted = 0;
  const sandbox = createNativeCodemodeSandbox({
    wasm: wasm.promise,
    acquireWorker: () => {
      admitted++;
      return () => {};
    },
  });
  const job = sandbox.start("text(1)", { startedAt: 1, seed: 1, onCall: () => {} });
  await sandbox.close();
  expect((await job.result).ok).toBe(false);
  // A valid module lets the delayed native launcher reach its admission hook.
  const { loadQuickJSWasm } = await import("@earendil-works/pi-codemode");
  wasm.resolve(await loadQuickJSWasm());
  await sandbox.drained();
  expect(admitted).toBe(0);
});

it.each([
  ["concurrency", "await Promise.all(Array.from({length:9},()=>tools.call({})));"],
  ["arguments", 'await tools.call({data:"é".repeat(4*1024*1024)});'],
  ["calls", "for(let i=0;i<257;i++) await tools.call({});"],
])("enforces %s limits on repeated deterministic native starts", async (_name, code) => {
  for (let attempt = 0; attempt < 2; attempt++) {
    const sandbox = createNativeCodemodeSandbox();
    let seq = 0;
    const job = sandbox.start('store("bad",true);' + code, {
      startedAt: 1,
      seed: 42,
      tools: [{ name: "call" }],
      onCall: (call) => {
        if (_name !== "concurrency") job.deliver(++seq, 2, call.id, { ok: true, value: null });
      },
    });
    try {
      const result = await job.result;
      expect(result).toMatchObject({ ok: false, error: { message: CALLBACK_LIMIT_MESSAGE } });
      expect("storeWrites" in result).toBe(false);
    } finally {
      await sandbox.close();
      await sandbox.drained();
    }
  }
});

it("bounds native delivered replies and suppresses late delivery and store writes", async () => {
  const sandbox = createNativeCodemodeSandbox();
  let seq = 0;
  const job = sandbox.start('store("bad",true); for(let i=0;i<17;i++) await tools.call({});', {
    startedAt: 1,
    seed: 1,
    tools: [{ name: "call" }],
    onCall: (call) =>
      job.deliver(++seq, 2, call.id, { ok: true, value: "x".repeat(4 * 1024 * 1024) }),
  });
  try {
    expect(await job.result).toMatchObject({
      ok: false,
      error: { message: CALLBACK_LIMIT_MESSAGE },
    });
    expect(() => job.deliver(++seq, 2, 999, { ok: true, value: null })).not.toThrow();
  } finally {
    await sandbox.close();
    await sandbox.drained();
  }
});

it("rejects invalid start and post-close admission without leaking resources", async () => {
  const budget = new CpuBudget();
  const memory = new CodeModeMemory(
    () => {},
    undefined,
    () => ({}),
    () => {},
  );
  const sandbox = createNativeCodemodeSandbox({ cpuBudget: budget, memory });
  try {
    expect(() => sandbox.start("", { startedAt: 1, seed: -1, onCall: () => {} })).toThrow();
    expect(budget.active).toBe(0);
    expect(memory.active).toBe(0);
    await sandbox.close();
    expect(() => sandbox.start("", { startedAt: 1, seed: 1, onCall: () => {} })).toThrow();
    expect(budget.active).toBe(0);
  } finally {
    await sandbox.close();
  }
});

it("keeps result telemetry local across concurrent sandbox instances", async () => {
  const first = createNativeCodemodeSandbox();
  const second = createNativeCodemodeSandbox();
  try {
    const bad = first.start('text("x".repeat(2*1024*1024));', {
      startedAt: 1,
      seed: 1,
      onCall: () => {},
    });
    const good = second.start('text("ok");', { startedAt: 1, seed: 1, onCall: () => {} });
    expect((await bad.result).ok).toBe(false);
    expect((await good.result).ok).toBe(true);
    expect(first.snapshot().failure).toBe("output_limit");
    expect(second.snapshot().failure).toBeUndefined();
    expect(second.snapshot().callbackLimit).toBe(false);
    expect(first.snapshot().memory.peakBytes).toBeGreaterThan(0);
    expect(second.snapshot().cpu.checkpoints).toBeGreaterThan(0);
  } finally {
    await Promise.all([first.close(), second.close()]);
    await Promise.all([first.drained(), second.drained()]);
  }
});

it("shares callback admission between tools, discovery and chart globals", async () => {
  const sandbox = createNativeCodemodeSandbox();
  const calls: CodemodeHostCall[] = [];
  const job = sandbox.start(
    'store("bad",true); await Promise.all([tools.call({}), searchTools("x"), describeTool("x"), chart({}), tools.call({}), searchTools("x"), describeTool("x"), chart({}), tools.call({})]);',
    {
      startedAt: 1,
      seed: 1,
      tools: [{ name: "call" }],
      globals: [{ name: "searchTools" }, { name: "describeTool" }, { name: "chart" }],
      onCall: (call) => {
        calls.push(call);
      },
    },
  );
  try {
    expect(await job.result).toMatchObject({
      ok: false,
      error: { message: CALLBACK_LIMIT_MESSAGE },
    });
    expect(calls.map((call) => call.name)).toEqual([
      "call",
      "searchTools",
      "describeTool",
      "chart",
      "call",
      "searchTools",
      "describeTool",
      "chart",
    ]);
  } finally {
    await sandbox.close();
    await sandbox.drained();
  }
});

it("counts native error properties against the reply budget even when script catches errors", async () => {
  const sandbox = createNativeCodemodeSandbox();
  let seq = 0;
  const job = sandbox.start(
    'store("bad",true); for(let i=0;i<17;i++) { try { await tools.call({}); } catch {} }',
    {
      startedAt: 1,
      seed: 1,
      tools: [{ name: "call" }],
      onCall: (call) =>
        job.deliver(++seq, 2, call.id, {
          ok: false,
          message: "expected",
          properties: { data: "x".repeat(4 * 1024 * 1024) },
        }),
    },
  );
  try {
    const result = await job.result;
    expect(result).toMatchObject({ ok: false, error: { message: CALLBACK_LIMIT_MESSAGE } });
    expect("storeWrites" in result).toBe(false);
  } finally {
    await sandbox.close();
    await sandbox.drained();
  }
});

it.each([
  ["items", 'for(let i=0;i<4097;i++) text("");'],
  [
    "images",
    'const picture={type:"image",data:"iVBORw0KGgoA"+"YWFh".repeat(2*1024*1024-3),mimeType:"image/png"}; for(let i=0;i<5;i++) image(picture);',
  ],
])("bounds deterministic output %s", async (_name, code) => {
  const sandbox = createNativeCodemodeSandbox();
  const job = sandbox.start('store("bad",true);' + code, {
    startedAt: 1,
    seed: 1,
    onCall: () => {},
  });
  try {
    const result = await job.result;
    expect(result).toMatchObject({ ok: false, error: { message: OUTPUT_LIMIT_MESSAGE } });
    expect("storeWrites" in result).toBe(false);
    expect(sandbox.snapshot().failure).toBe("output_limit");
  } finally {
    await sandbox.close();
    await sandbox.drained();
  }
});

it("blocks delayed admission when the shared running registry closes native sandboxes", async () => {
  const running = new Set<CodemodeSandbox>();
  const wasm = deferred<CodemodeWasmModule>();
  let admitted = 0;
  const sandbox = createNativeCodemodeSandbox({
    running,
    wasm: wasm.promise,
    acquireWorker: () => {
      admitted++;
      return () => {};
    },
  });
  const job = sandbox.start("text(1)", { startedAt: 1, seed: 1, onCall: () => {} });
  expect(running.size).toBe(1);
  const closing = Promise.all([...running].map((native) => native.close()));
  const { loadQuickJSWasm } = await import("@earendil-works/pi-codemode");
  wasm.resolve(await loadQuickJSWasm());
  await closing;
  expect((await job.result).ok).toBe(false);
  await sandbox.drained();
  expect(admitted).toBe(0);
  expect(running.size).toBe(0);
});
