import { CPU_QUANTUM_MS } from "./cpu-budget.js";

// Only called in a worker. Atomics.wait parks the thread without occupying a CPU.
export function createCpuCheckpoint(
  data,
  platform = {
    cpu: () => {
      const usage = process.threadCpuUsage();
      return usage.user + usage.system;
    },
    now: () => process.hrtime.bigint(),
    wait: Atomics.wait,
  },
) {
  if (!data.cpuBudget) return () => false;
  const credit = new BigInt64Array(data.cpuBudget, 0, 1);
  const epoch = new Int32Array(data.cpuBudget, 8, 1);
  const stats = new BigInt64Array(data.cpuStats);
  const interrupt = new Int32Array(data.interrupt);
  let previousCpu = 0;
  const charge = () => {
    const cpu = platform.cpu();
    const consumed = BigInt(cpu - previousCpu);
    previousCpu = cpu;
    Atomics.sub(credit, 0, consumed);
    Atomics.add(stats, 0, consumed);
  };
  return () => {
    charge();
    Atomics.add(stats, 2, 1n);
    while (Atomics.load(interrupt, 0) === 0 && Atomics.load(credit, 0) <= 0n) {
      const generation = Atomics.load(epoch, 0);
      if (Atomics.load(credit, 0) > 0n) break;
      const started = platform.now();
      platform.wait(epoch, 0, generation, CPU_QUANTUM_MS);
      Atomics.add(stats, 1, (platform.now() - started) / 1000n);
      charge();
    }
    return Atomics.load(interrupt, 0) !== 0;
  };
}
