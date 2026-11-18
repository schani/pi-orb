import { monitorEventLoopDelay, PerformanceObserver, performance } from "node:perf_hooks";
import { Result, type Result as ResultType } from "neverthrow";

interface CpuUsage {
  processMicros: number;
  mainThreadMicros: number;
}
interface CpuPoint extends CpuUsage {
  at: number;
}
interface DelayMonitor {
  read(): { p99Ms: number; maxMs: number } | null;
  reset(): void;
  stop(): void;
}
interface Dependencies {
  now(): number;
  readCpu(): ResultType<CpuUsage, { code: "unavailable" }>;
  readLoop(): { active: number; idle: number };
  createDelay(): DelayMonitor;
  schedule(callback: () => void): () => void;
  observeGc(callback: (durationMs: number) => void): () => void;
}
const defaults: Dependencies = {
  now: () => performance.now(),
  readCpu: Result.fromThrowable(
    () => {
      const cpu = process.cpuUsage();
      const main = process.threadCpuUsage();
      return { processMicros: cpu.user + cpu.system, mainThreadMicros: main.user + main.system };
    },
    () => ({ code: "unavailable" as const }),
  ),
  readLoop: () => performance.eventLoopUtilization(),
  createDelay: () => {
    const histogram = monitorEventLoopDelay({ resolution: 100 });
    histogram.enable();
    return {
      read: () =>
        histogram.count === 0
          ? null
          : { p99Ms: histogram.percentile(99) / 1e6, maxMs: histogram.max / 1e6 },
      reset: () => histogram.reset(),
      stop: () => histogram.disable(),
    };
  },
  schedule: (callback) => {
    const timer = setInterval(callback, 1_000);
    timer.unref();
    return () => clearInterval(timer);
  },
  observeGc: (callback) => {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) callback(entry.duration);
    });
    observer.observe({ entryTypes: ["gc"] });
    return () => observer.disconnect();
  },
};

function percent(current: number, previous: number, elapsedMs: number): number | null {
  return elapsedMs > 0 && current >= previous ? (current - previous) / (elapsedMs * 10) : null;
}

/** Fixed-size process statistics, folded into the existing HTTP sample. */
export class RuntimeDiagnostics {
  private readonly deps: Dependencies;
  private readonly delay: DelayMonitor;
  private readonly cancel: () => void;
  private readonly stopGc: () => void;
  private tickCpu: CpuPoint | null;
  private sampleCpu: CpuPoint | null;
  private loop: { active: number; idle: number };
  private processPeak: number | null = null;
  private mainPeak: number | null = null;
  private maxInterval = 0;
  private gcCount = 0;
  private gcTotal = 0;
  private gcMax = 0;
  private disposed = false;

  constructor(deps: Partial<Dependencies> = {}) {
    this.deps = { ...defaults, ...deps };
    this.delay = this.deps.createDelay();
    this.tickCpu = this.sampleCpu = this.readCpu();
    this.loop = this.deps.readLoop();
    this.cancel = this.deps.schedule(() => this.tick());
    this.stopGc = this.deps.observeGc((duration) => {
      this.gcCount++;
      this.gcTotal += duration;
      this.gcMax = Math.max(this.gcMax, duration);
    });
  }
  private readCpu(): CpuPoint | null {
    const cpu = this.deps.readCpu();
    return cpu.isOk() ? { ...cpu.value, at: this.deps.now() } : null;
  }
  private tick(): void {
    if (this.disposed) return;
    const current = this.readCpu();
    const previous = this.tickCpu;
    this.tickCpu = current;
    if (current === null || previous === null) return;
    const elapsed = current.at - previous.at;
    const processCpu = percent(current.processMicros, previous.processMicros, elapsed);
    const mainCpu = percent(current.mainThreadMicros, previous.mainThreadMicros, elapsed);
    if (processCpu !== null) this.processPeak = Math.max(this.processPeak ?? 0, processCpu);
    if (mainCpu !== null) this.mainPeak = Math.max(this.mainPeak ?? 0, mainCpu);
    this.maxInterval = Math.max(this.maxInterval, elapsed);
  }
  sample(): Record<string, number | null> {
    const current = this.readCpu();
    const previous = this.sampleCpu;
    this.sampleCpu = current;
    const elapsed = current !== null && previous !== null ? current.at - previous.at : 0;
    const loop = this.deps.readLoop();
    const active = loop.active - this.loop.active;
    const total = active + loop.idle - this.loop.idle;
    this.loop = loop;
    const delay = this.delay.read();
    this.delay.reset();
    const sample = {
      process_cpu_percent:
        current && previous
          ? percent(current.processMicros, previous.processMicros, elapsed)
          : null,
      main_thread_cpu_percent:
        current && previous
          ? percent(current.mainThreadMicros, previous.mainThreadMicros, elapsed)
          : null,
      process_cpu_peak_percent: this.processPeak,
      main_thread_cpu_peak_percent: this.mainPeak,
      cpu_sample_max_interval_ms: this.maxInterval,
      event_loop_utilization_percent: total > 0 ? (100 * active) / total : null,
      event_loop_delay_p99_ms: delay?.p99Ms ?? null,
      event_loop_delay_max_ms: delay?.maxMs ?? null,
      gc_count: this.gcCount,
      gc_total_ms: this.gcTotal,
      gc_max_ms: this.gcMax,
    };
    this.processPeak = this.mainPeak = null;
    this.maxInterval = this.gcCount = this.gcTotal = this.gcMax = 0;
    return sample;
  }
  [Symbol.dispose](): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
    this.stopGc();
    this.delay.stop();
  }
}
