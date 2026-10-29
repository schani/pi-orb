export const MEMORY_SAMPLE_INTERVAL_MS = 10_000;

const toMiB = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;

interface LiveWorker {
  orbId: string | undefined;
  /** bounded-worker.js writes [current, peak] bytes: V8 heap used + external + owned QuickJS wasm capacity. */
  stats: Float64Array;
}
const current = (worker: LiveWorker) => worker.stats[0] ?? 0;

/**
 * Process-wide registry of live code-mode workers. While any is live, one
 * `codemode.memory` JSON line per interval records worker and process memory;
 * an idle process logs nothing (docs/pi-adapter.md). Node writes stdout pipes and
 * files synchronously on Linux, so an OOM kill cannot drop a buffered sample.
 */
export class CodeModeMemory {
  private readonly live = new Set<LiveWorker>();
  private timer: unknown;
  private readonly log: (line: string) => void;
  private readonly usage: () => NodeJS.MemoryUsage;
  private readonly schedule: (callback: () => void, ms: number) => { unref?: () => void };
  private readonly cancel: (timer: unknown) => void;

  constructor(
    log: (line: string) => void = (line) => console.log(line),
    usage: () => NodeJS.MemoryUsage = () => process.memoryUsage(),
    schedule: (callback: () => void, ms: number) => { unref?: () => void } = setInterval,
    cancel: (timer: unknown) => void = (timer) => clearInterval(timer as NodeJS.Timeout),
  ) {
    this.log = log;
    this.usage = usage;
    this.schedule = schedule;
    this.cancel = cancel;
  }

  get active(): number {
    return this.live.size;
  }

  acquire(orbId: string | undefined) {
    const memoryStats = new SharedArrayBuffer(16);
    const worker: LiveWorker = { orbId, stats: new Float64Array(memoryStats) };
    this.live.add(worker);
    if (this.timer === undefined) {
      const timer = this.schedule(() => this.sample(), MEMORY_SAMPLE_INTERVAL_MS);
      timer.unref?.();
      this.timer = timer;
    }
    return {
      workerData: { memoryStats },
      peakBytes: () => worker.stats[1] ?? 0,
      release: () => {
        this.live.delete(worker);
      },
    };
  }

  /** Stops at the first idle tick, so short scripts keep the cadence instead of restarting it. */
  sample(): void {
    if (this.live.size === 0) {
      this.cancel(this.timer);
      this.timer = undefined;
      return;
    }
    let sum = 0;
    let max: LiveWorker | undefined;
    for (const worker of this.live) {
      sum += current(worker);
      if (!max || current(worker) > current(max)) max = worker;
    }
    const usage = this.usage();
    this.log(
      JSON.stringify({
        message: "codemode.memory",
        workers: this.live.size,
        worker_sum_mib: toMiB(sum),
        worker_max_mib: toMiB(max ? current(max) : 0),
        worker_max_orb: max?.orbId,
        rss_mib: toMiB(usage.rss),
        heap_used_mib: toMiB(usage.heapUsed),
        heap_total_mib: toMiB(usage.heapTotal),
        external_mib: toMiB(usage.external),
        array_buffers_mib: toMiB(usage.arrayBuffers),
      }),
    );
  }
}

export const codeModeMemory = new CodeModeMemory();
