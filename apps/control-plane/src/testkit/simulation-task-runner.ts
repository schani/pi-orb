import type { SimulationTask } from "determined";
import type { ReconcileTaskRunner } from "../domain/loops.ts";

type ReconcileJob = {
  readonly run: (task: SimulationTask) => Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
};

/**
 * `determined` models concurrency with distinct SimulationTasks. Production
 * creates one real-time task per dispatched lane; this mailbox gives each
 * statically declared DST worker its own task while exercising the same
 * dispatcher contract.
 */
export class SimulationTaskRunner {
  calls = 0;
  private readonly queued = new Map<string, ReconcileJob>();
  private readonly waiting = new Map<string, (job: ReconcileJob | null) => void>();

  readonly run: ReconcileTaskRunner = (orbId, operation) =>
    new Promise<void>((resolve, reject) => {
      this.calls++;
      const job = { run: operation, resolve, reject };
      const waiter = this.waiting.get(orbId);
      if (waiter !== undefined) {
        this.waiting.delete(orbId);
        waiter(job);
        return;
      }
      if (this.queued.has(orbId)) throw new Error(`duplicate queued reconcile for ${orbId}`);
      this.queued.set(orbId, job);
    });

  async worker(task: SimulationTask, orbId: string, stop: AbortSignal): Promise<void> {
    while (!stop.aborted) {
      const job = await this.next(orbId, stop);
      if (job === null) return;
      try {
        await job.run(task);
        job.resolve();
      } catch (error) {
        job.reject(error);
      }
    }
  }

  private next(orbId: string, stop: AbortSignal): Promise<ReconcileJob | null> {
    const queued = this.queued.get(orbId);
    if (queued !== undefined) {
      this.queued.delete(orbId);
      return Promise.resolve(queued);
    }
    if (stop.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      const onAbort = (): void => {
        this.waiting.delete(orbId);
        resolve(null);
      };
      stop.addEventListener("abort", onAbort, { once: true });
      this.waiting.set(orbId, (job) => {
        stop.removeEventListener("abort", onAbort);
        resolve(job);
      });
    });
  }
}
