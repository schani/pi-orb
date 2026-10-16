import type { SimulationTask } from "determined";
import type { Result } from "neverthrow";
import { sleepResult } from "./dst.ts";
import { logEvent } from "./log.ts";

export interface Rollout {
  readonly releaseId: string;
  readonly phase: string;
  readonly generation: number;
  readonly resources: readonly string[];
  readonly servingRevision: string;
}
export type RolloutReadError = { readonly type: "rollout_read_unavailable" };
export interface RolloutReader {
  read(task: SimulationTask, stop: AbortSignal): Promise<Result<Rollout | null, RolloutReadError>>;
}
export interface SocketRetirementCause {
  readonly releaseId: string;
  readonly revision: string;
}

/** Local socket admission only; grants no lifecycle or agent authority. */
export class RolloutSocketRetirement {
  private retired: SocketRetirementCause | null = null;

  get retirement(): SocketRetirementCause | null {
    return this.retired;
  }
  private readonly connections = new Set<(cause: SocketRetirementCause) => void>();

  register(close: (cause: SocketRetirementCause) => void): (() => void) | null {
    if (this.retirement !== null) return null;
    this.connections.add(close);
    return () => {
      this.connections.delete(close);
    };
  }

  retire(cause: SocketRetirementCause): number {
    if (this.retirement !== null) return 0;
    this.retired = cause;
    const count = this.connections.size;
    for (const close of this.connections) close(cause);
    this.connections.clear();
    return count;
  }
}

export async function watchRolloutSockets(
  task: SimulationTask,
  reader: RolloutReader,
  revision: string,
  generation: number,
  sockets: RolloutSocketRetirement,
  stop: AbortSignal,
): Promise<void> {
  let unavailable = false;
  while (!stop.aborted) {
    const result = await reader.read(task, stop);
    if (stop.aborted) return;
    if (result.isErr() !== unavailable) {
      unavailable = result.isErr();
      logEvent(
        task,
        unavailable ? "rollout-socket-read-unavailable" : "rollout-socket-read-recovered",
        {
          revision,
          cause: unavailable ? "rollout_read_unavailable" : "read_succeeded",
        },
      );
    }
    const rollout = result.isOk() ? result.value : null;
    if (
      rollout !== null &&
      rollout.phase === "retire" &&
      rollout.generation > generation &&
      rollout.servingRevision !== revision &&
      rollout.resources.includes(revision)
    ) {
      const socketCount = sockets.retire({ releaseId: rollout.releaseId, revision });
      logEvent(task, "rollout-sockets-retired", {
        releaseId: rollout.releaseId,
        revision,
        generation: rollout.generation,
        socketCount,
        cause: "old_revision_rollout",
      });
      return;
    }
    if ((await sleepResult(task, 5_000, "rollout socket retirement", stop)).isErr()) return;
  }
}
