export const CPU_QUANTUM_MS: number;
export function refillCpuBudget(buffer: SharedArrayBuffer, elapsedUs: number | bigint): void;
export class CpuBudget {
  buffer: SharedArrayBuffer;
  active: number;
  constructor(
    now?: () => bigint,
    schedule?: (callback: () => void, ms: number) => { unref?: () => void },
    cancel?: (timer: unknown) => void,
  );
  refill(): void;
  acquire(): {
    workerData: { cpuBudget: SharedArrayBuffer; cpuStats: SharedArrayBuffer };
    snapshot(): { budgetCores: number; cpuMs: number; throttledMs: number; checkpoints: number };
    release(): void;
  };
}
export const codeModeCpuBudget: CpuBudget;
