export function createCpuCheckpoint(
  data: {
    cpuBudget?: SharedArrayBuffer;
    cpuStats?: SharedArrayBuffer;
    interrupt: SharedArrayBuffer;
  },
  platform?: {
    cpu(): number;
    now(): bigint;
    wait(array: Int32Array, index: number, value: number, timeout: number): string;
  },
): () => boolean;
