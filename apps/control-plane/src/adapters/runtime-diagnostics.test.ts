import { err, ok } from "neverthrow";
import { expect, it } from "vitest";
import { RuntimeDiagnostics } from "./runtime-diagnostics.ts";

function fixture() {
  let now = 0;
  let processMicros = 0;
  let mainThreadMicros = 0;
  let unavailable = false;
  let loop = { active: 0, idle: 0 };
  let delay: { p99Ms: number; maxMs: number } | null = null;
  let tick = () => {};
  let gc = (_duration: number) => {};
  let stopped = 0;
  const diagnostics = new RuntimeDiagnostics({
    now: () => now,
    readCpu: () =>
      unavailable ? err({ code: "unavailable" as const }) : ok({ processMicros, mainThreadMicros }),
    readLoop: () => loop,
    createDelay: () => ({
      read: () => delay,
      reset: () => {
        delay = null;
      },
      stop: () => stopped++,
    }),
    schedule: (callback) => {
      tick = callback;
      return () => stopped++;
    },
    observeGc: (callback) => {
      gc = callback;
      return () => stopped++;
    },
  });
  return {
    diagnostics,
    advance: (ms: number, processCpu: number, mainCpu: number) => {
      now += ms;
      processMicros += processCpu;
      mainThreadMicros += mainCpu;
      tick();
    },
    loop: (active: number, idle: number) => {
      loop = { active, idle };
    },
    delay: (value: typeof delay) => {
      delay = value;
    },
    unavailable: (value: boolean) => {
      unavailable = value;
    },
    gc: (duration: number) => gc(duration),
    stopped: () => stopped,
    [Symbol.dispose]: () => diagnostics[Symbol.dispose](),
  };
}

it("retains short CPU peaks and loop/GC stalls across a quiet reporting interval", () => {
  using f = fixture();
  f.advance(1_000, 1_800_000, 900_000);
  f.advance(29_000, 1_200_000, 600_000);
  f.loop(7_500, 22_500);
  f.delay({ p99Ms: 120, maxMs: 700 });
  f.gc(12);
  f.gc(40);
  expect(f.diagnostics.sample()).toEqual({
    process_cpu_percent: 10,
    main_thread_cpu_percent: 5,
    process_cpu_peak_percent: 180,
    main_thread_cpu_peak_percent: 90,
    cpu_sample_max_interval_ms: 29_000,
    event_loop_utilization_percent: 25,
    event_loop_delay_p99_ms: 120,
    event_loop_delay_max_ms: 700,
    gc_count: 2,
    gc_total_ms: 52,
    gc_max_ms: 40,
  });
  f.advance(1_000, 100_000, 50_000);
  f.loop(7_600, 23_400);
  expect(f.diagnostics.sample()).toMatchObject({
    process_cpu_percent: 10,
    process_cpu_peak_percent: 10,
    main_thread_cpu_peak_percent: 5,
    cpu_sample_max_interval_ms: 1_000,
    event_loop_utilization_percent: 10,
    event_loop_delay_max_ms: null,
    gc_count: 0,
    gc_total_ms: 0,
    gc_max_ms: 0,
  });
  f.diagnostics[Symbol.dispose]();
  f.diagnostics[Symbol.dispose]();
  expect(f.stopped()).toBe(3);
});

it("reports unavailable CPU and unsampled intervals as null, then reestablishes a baseline", () => {
  using f = fixture();
  expect(f.diagnostics.sample()).toMatchObject({
    process_cpu_percent: null,
    process_cpu_peak_percent: null,
    event_loop_utilization_percent: null,
    event_loop_delay_p99_ms: null,
  });
  f.unavailable(true);
  f.advance(1_000, 500_000, 500_000);
  expect(f.diagnostics.sample()).toMatchObject({ process_cpu_percent: null });
  f.unavailable(false);
  f.advance(1_000, 0, 0);
  expect(f.diagnostics.sample()).toMatchObject({ process_cpu_percent: null });
  f.advance(1_000, 100_000, 100_000);
  expect(f.diagnostics.sample()).toMatchObject({
    process_cpu_percent: 10,
    main_thread_cpu_percent: 10,
    process_cpu_peak_percent: 10,
  });
  f.diagnostics[Symbol.dispose]();
});
