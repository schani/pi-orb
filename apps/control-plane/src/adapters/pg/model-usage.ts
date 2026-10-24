import { UsageViewSchema } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import { Check } from "typebox/value";
import type { StoreError } from "../../domain/errors.ts";
import { logEvent } from "../../domain/log.ts";
import type { ModelCall, ModelUsageLedger } from "../../domain/model-usage.ts";
import type { ModelUsageReader, UsageRead } from "../../domain/usage-read.ts";
import { arrayParam, type PgRow, type PostgreSQLClient } from "./client.ts";

function usageRows(rows: PgRow[], boundaries: readonly number[]): Result<UsageRead, StoreError> {
  const result: UsageRead = { buckets: [], orbs: [] };
  const invalid = () =>
    err<UsageRead, StoreError>({
      type: "store_error",
      code: "invariant",
      message: "Invalid model usage aggregate",
      retryable: false,
    });
  const times = boundaries.slice(0, -1);
  for (const row of rows) {
    const totals = {
      input: row["input"],
      output: row["output"],
      cacheRead: row["cacheRead"],
      cacheWrite: row["cacheWrite"],
      calls: row["calls"],
    };
    if (row["kind"] === "bucket") {
      const index = row["bucket"];
      const bucket = {
        ...totals,
        at: typeof index === "number" ? times[index] : undefined,
        orbId: row["orbId"],
        use: row["use"],
        provider: row["provider"],
        model: row["model"],
      };
      if (!Check(UsageViewSchema.properties.buckets.items, bucket)) return invalid();
      result.buckets.push(bucket);
    } else if (row["kind"] === "orb") {
      const orb = { ...totals, id: row["id"], name: row["name"] };
      if (!Check(UsageViewSchema.properties.orbs.items, orb)) return invalid();
      result.orbs.push(orb);
    } else return invalid();
  }
  return ok(result);
}

/**
 * Fire-and-forget `model_calls` inserts (docs/model-usage.md). Each row commits in its own transaction without
 * waiting for the WAL flush; an outage logs one edge when it starts and one when it ends, never per row.
 */
export class PostgreSQLModelUsageLedger implements ModelUsageLedger, ModelUsageReader {
  private readonly db: PostgreSQLClient;
  private readonly pending = new Set<Promise<void>>();
  private failing = false;

  constructor(db: PostgreSQLClient) {
    this.db = db;
  }

  read(
    _task: SimulationTask,
    ownerUserId: string,
    boundaries: readonly number[],
  ): ResultAsync<UsageRead, StoreError> {
    return this.db
      .query(
        `WITH edges AS (
         SELECT at, lead(at) OVER (ORDER BY ord) AS until, (ord-1)::int AS bucket
         FROM unnest($2::timestamptz[]) WITH ORDINALITY AS t(at, ord)
       ), usage AS MATERIALIZED (
         SELECT e.bucket, c.* FROM edges e JOIN model_calls c ON c.at >= e.at AND c.at < e.until
         WHERE c.owner_user_id = $1
       ), owned_orbs AS (
         SELECT o.id, o.name FROM orbs o JOIN projects p ON p.id = o.project_id WHERE p.owner_user_id::text = $1
       )
       SELECT 'bucket' AS kind, bucket, use, provider, model, orb_id::text AS "orbId", NULL::text AS id, NULL::text AS name,
         sum(input)::float8 AS input, sum(output)::float8 AS output,
         sum(cache_read)::float8 AS "cacheRead", sum(cache_write)::float8 AS "cacheWrite", count(*)::float8 AS calls
       FROM usage GROUP BY bucket, use, provider, model, orb_id
       UNION ALL
       SELECT 'orb', NULL, NULL, NULL, NULL, NULL, u.orb_id::text, o.name,
         sum(input)::float8, sum(output)::float8, sum(cache_read)::float8, sum(cache_write)::float8, count(*)::float8
       FROM usage u LEFT JOIN owned_orbs o ON o.id = u.orb_id GROUP BY u.orb_id, o.name`,
        [ownerUserId, arrayParam(boundaries.map((at) => new Date(at)))],
      )
      .andThen((result) => usageRows(result.rows, boundaries));
  }

  record(task: SimulationTask, call: ModelCall): void {
    const write = this.db
      .transaction(async (query, execute) => {
        const relaxed = await execute("SET LOCAL synchronous_commit = off");
        if (relaxed.isErr()) return relaxed;
        return (
          await query(
            `INSERT INTO model_calls (at, owner_user_id, orb_id, use, provider, model, outcome,
               input, output, cache_read, cache_write, cost_usd, duration_ms,
               response_id, ttft_ms, thinking_ms)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
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
              call.costUsd ?? null,
              call.durationMs ?? null,
              call.responseId ?? null,
              call.ttftMs ?? null,
              call.thinkingMs ?? null,
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
