import { isCancellation } from "determined";
import { ResultAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { runDst } from "../testkit/sim.ts";
import {
  type TurnSummarizer,
  TurnSummaryCoordinator,
  type TurnSummaryError,
} from "./turn-summary.ts";

describe("turn summary coordinator DST", () => {
  it("keeps agent completion independent while summaries finish under varied schedules", async () => {
    await runDst({ name: "turn-summary-background", iterations: 30 }, async (sim) => {
      const run = await sim.runTasks([
        {
          name: "scenario",
          f: async (task) => {
            const delivered: string[] = [];
            const failed: string[] = [];
            const summarizer: TurnSummarizer = {
              summarize: (input, context) =>
                ResultAsync.fromPromise(
                  task
                    .sleep(
                      input.transcript === "first" ? 40 : 10,
                      `summarize ${input.transcript}`,
                      { signal: context.signal },
                    )
                    .then(() => input.transcript),
                  (cause): TurnSummaryError => ({
                    type: "turn_summary_error",
                    message: isCancellation(cause) ? "cancelled" : String(cause),
                  }),
                ),
            };
            const coordinator = new TurnSummaryCoordinator({
              task,
              summarizer,
              timeoutMs: 1_000,
              maxConcurrency: 2,
              onSummary: (operationId) => delivered.push(operationId),
              onError: (operationId) => failed.push(operationId),
            });

            coordinator.enqueue("op-first", { transcript: "first" });
            coordinator.enqueue("op-second", { transcript: "second" });
            // Enqueue is the agent-settled path: neither model call is awaited here.
            expect(delivered).toEqual([]);
            await task.checkpoint("summaries enqueued");
            await coordinator.drain();
            // Determined may fire a deadline later than nominal and before a shorter model timer;
            // either outcome is valid, but every operation must reach exactly one terminal path.
            expect(new Set([...delivered, ...failed])).toEqual(new Set(["op-first", "op-second"]));
            expect(delivered.filter((id) => failed.includes(id))).toEqual([]);
          },
        },
      ]);
      if (run.isErr()) throw run.error;
    });
  });

  it("consumes a timed-out Luna call without emitting a notification", async () => {
    await runDst({ name: "turn-summary-timeout", iterations: 10 }, async (sim) => {
      const run = await sim.runTasks([
        {
          name: "scenario",
          f: async (task) => {
            const delivered: string[] = [];
            const failed: string[] = [];
            const summarizer: TurnSummarizer = {
              summarize: (_input, context) =>
                ResultAsync.fromPromise(
                  new Promise<string>((_resolve, reject) => {
                    context.signal.addEventListener("abort", () => reject(context.signal.reason), {
                      once: true,
                    });
                  }),
                  (cause): TurnSummaryError => ({
                    type: "turn_summary_error",
                    message: isCancellation(cause) ? "cancelled" : String(cause),
                  }),
                ),
            };
            const coordinator = new TurnSummaryCoordinator({
              task,
              summarizer,
              timeoutMs: 25,
              onSummary: (operationId) => delivered.push(operationId),
              onError: (operationId) => failed.push(operationId),
            });
            coordinator.enqueue("op-timeout", { transcript: "never finishes" });
            await task.checkpoint("summary enqueued");
            await coordinator.drain();
            expect(delivered).toEqual([]);
            expect(failed).toEqual(["op-timeout"]);
          },
        },
      ]);
      if (run.isErr()) throw run.error;
    });
  });
});
