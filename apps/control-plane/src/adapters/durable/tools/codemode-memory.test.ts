import { expect, it } from "vitest";
import { CodeModeMemory, MEMORY_SAMPLE_INTERVAL_MS } from "./codemode-memory.ts";

const MiB = 1024 * 1024;
const usage = {
  rss: 900 * MiB,
  heapUsed: 60 * MiB,
  heapTotal: 80 * MiB,
  external: 5 * MiB,
  arrayBuffers: 1 * MiB,
};

function memoryWithFakeTimer() {
  const lines: string[] = [];
  let tick: (() => void) | undefined;
  let schedules = 0;
  const memory = new CodeModeMemory(
    (line) => lines.push(line),
    () => usage as NodeJS.MemoryUsage,
    (callback, ms) => {
      expect(ms).toBe(MEMORY_SAMPLE_INTERVAL_MS);
      schedules++;
      tick = callback;
      return {};
    },
    () => {
      tick = undefined;
    },
  );
  return {
    memory,
    lines,
    tick: () => tick?.(),
    running: () => tick !== undefined,
    schedules: () => schedules,
  };
}

it("samples live workers with the largest one's orb and process memory", () => {
  const { memory, lines, tick, schedules } = memoryWithFakeTimer();
  const small = memory.acquire("orb-a");
  const large = memory.acquire("orb-b");
  expect(schedules()).toBe(1);
  new Float64Array(small.workerData.memoryStats).set([12 * MiB, 20 * MiB]);
  new Float64Array(large.workerData.memoryStats).set([200 * MiB, 210 * MiB]);
  tick();
  expect(lines.map((line) => JSON.parse(line))).toEqual([
    {
      message: "codemode.memory",
      workers: 2,
      worker_sum_mib: 212,
      worker_max_mib: 200,
      worker_max_orb: "orb-b",
      rss_mib: 900,
      heap_used_mib: 60,
      heap_total_mib: 80,
      external_mib: 5,
      array_buffers_mib: 1,
    },
  ]);
  expect(small.peakBytes()).toBe(20 * MiB);
  small.release();
  large.release();
});

it("counts releases once, stays silent when idle and keeps one timer across reentry", () => {
  const { memory, lines, tick, running, schedules } = memoryWithFakeTimer();
  const first = memory.acquire("orb");
  first.release();
  first.release();
  expect(memory.active).toBe(0);
  const second = memory.acquire("orb");
  expect(schedules()).toBe(1);
  second.release();
  tick();
  expect(lines).toEqual([]);
  expect(running()).toBe(false);
  memory.acquire(undefined).release();
  expect(schedules()).toBe(2);
});
