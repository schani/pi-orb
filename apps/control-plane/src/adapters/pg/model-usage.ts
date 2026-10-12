import type { SimulationTask } from "determined";
import { ok, ResultAsync } from "neverthrow";
import { logEvent } from "../../domain/log.ts";
import type { ModelCall, ModelUsageLedger } from "../../domain/model-usage.ts";
import type { PostgreSQLClient } from "./client.ts";

/**
 * Fire-and-forget `model_calls` inserts (docs/model-usage.md). Each row commits in its own transaction without
 * waiting for the WAL flush; an outage logs one edge when it starts and one when it ends, never per row.
 */
export class PostgreSQLModelUsageLedger implements ModelUsageLedger {
  private readonly db: PostgreSQLClient;
  private readonly pending = new Set<Promise<void>>();
  private failing = false;

  constructor(db: PostgreSQLClient) {
    this.db = db;
  }

  record(task: SimulationTask, call: ModelCall): void {
    const write = this.db
      .transaction(async (query, execute) => {
        const relaxed = await execute("SET LOCAL synchronous_commit = off");
        if (relaxed.isErr()) return relaxed;
        return (
          await query(
            `INSERT INTO model_calls (at, owner_user_id, orb_id, use, provider, model, outcome,
               input, output, cache_read, cache_write, duration_ms)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [
              new Date(task.wallNow()),
              call.ownerUserId,
              call.orbId,
              call.use,
              call.provider,
              call.model,
              call.outcome,
              call.input,
              call.output,
              call.cacheRead,
              call.cacheWrite,
              call.durationMs ?? null,
            ],
          )
        ).andThen(() => ok(undefined));
      })
      .match(
        () => {
          if (!this.failing) return;
          this.failing = false;
          logEvent(task, "model_usage.write_recovered");
        },
        (error) => {
          if (this.failing) return;
          this.failing = true;
          logEvent(task, "model_usage.write_failed", { code: error.code });
        },
      );
    this.pending.add(write);
    void write.then(() => this.pending.delete(write));
  }

  /** Settles once every insert recorded so far has committed or failed. */
  drain(): ResultAsync<void, never> {
    return ResultAsync.fromSafePromise(Promise.all(this.pending).then(() => undefined));
  }
}
