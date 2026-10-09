// All code-mode workers in this process share one CPU microsecond per wall microsecond.
export const CPU_QUANTUM_MS = 20;
const MAX_CREDIT_US = BigInt(CPU_QUANTUM_MS * 1000);

export function refillCpuBudget(buffer, elapsedUs) {
  const credit = new BigInt64Array(buffer, 0, 1);
  let previous = Atomics.load(credit, 0);
  for (;;) {
    const replenished = previous + BigInt(elapsedUs);
    const next = replenished < MAX_CREDIT_US ? replenished : MAX_CREDIT_US;
    const observed = Atomics.compareExchange(credit, 0, previous, next);
    if (observed === previous) break;
    previous = observed;
  }
  const epoch = new Int32Array(buffer, 8, 1);
  Atomics.add(epoch, 0, 1);
  Atomics.notify(epoch, 0);
}

export class CpuBudget {
  buffer = new SharedArrayBuffer(16);
  active = 0;
  timer;
  last;

  constructor(now = () => process.hrtime.bigint(), schedule = setInterval, cancel = clearInterval) {
    this.now = now;
    this.schedule = schedule;
    this.cancel = cancel;
    this.last = now();
    refillCpuBudget(this.buffer, CPU_QUANTUM_MS * 1000);
  }

  refill() {
    const now = this.now();
    const elapsedUs = (now - this.last) / 1000n;
    this.last += elapsedUs * 1000n;
    refillCpuBudget(this.buffer, elapsedUs);
  }

  acquire() {
    if (this.active++ === 0) {
      this.refill();
      this.timer = this.schedule(() => this.refill(), CPU_QUANTUM_MS);
      this.timer.unref?.();
    }
    const stats = new SharedArrayBuffer(24);
    let released = false;
    return {
      workerData: { cpuBudget: this.buffer, cpuStats: stats },
      snapshot: () => {
        const values = new BigInt64Array(stats);
        return {
          budgetCores: 1,
          cpuMs: Number(Atomics.load(values, 0)) / 1000,
          throttledMs: Number(Atomics.load(values, 1)) / 1000,
          checkpoints: Number(Atomics.load(values, 2)),
        };
      },
      release: () => {
        if (released) return;
        released = true;
        if (--this.active === 0) {
          this.cancel(this.timer);
          this.timer = undefined;
        }
      },
    };
  }
}

export const codeModeCpuBudget = new CpuBudget();
