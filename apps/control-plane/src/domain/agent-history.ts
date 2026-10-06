import type { SimulationTask } from "determined";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import type { AgentSnapshot } from "./agent-ports.ts";
import type { RuntimeClientError } from "./errors.ts";
import type { ControlPlaneDeps } from "./ports.ts";

/** Project authoritative central entries before publishing them to browsers. */
export function commitAgentHistory(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  snapshot: AgentSnapshot,
): ResultAsync<void, RuntimeClientError> {
  const failure = (message: string): RuntimeClientError => ({
    type: "runtime_client_error",
    code: "history_unavailable",
    message,
    retryable: true,
    answered: true,
  });
  const run = async (): Promise<Result<void, RuntimeClientError>> => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const found = await deps.store.getOrb(task, snapshot.orbId);
      if (found.isErr()) return err(failure(found.error.message));
      if (found.value === null) return err(failure("orb does not exist"));
      const cursor = found.value.replicationCursor;
      const index =
        cursor === null ? -1 : snapshot.records.findIndex((record) => record.id === cursor);
      if (cursor !== null && index < 0)
        return err(failure("central history cursor is absent from authority"));
      const records = snapshot.records.slice(index + 1);
      const last = records.at(-1);
      if (last === undefined)
        return (await deps.store.initOrVerifySession(task, snapshot.orbId, snapshot.session))
          .map(() => undefined)
          .mapErr((error) => failure(error.message));
      const committed = await deps.store.commitPullBatch(task, {
        orbId: snapshot.orbId,
        expectedCursor: cursor,
        session: snapshot.session,
        records,
        nextCursor: last.id,
        nextHeadId: snapshot.headId,
      });
      if (committed.isOk()) {
        await task.checkpoint("central history projected", snapshot.orbId);
        return ok(undefined);
      }
      if (committed.error.type !== "cursor_conflict") return err(failure(committed.error.message));
      await task.checkpoint("central history cursor conflict", snapshot.orbId);
    }
    return err(failure("central history projection contention"));
  };
  return new ResultAsync(run());
}
