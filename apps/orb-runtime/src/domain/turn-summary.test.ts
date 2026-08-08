import { NoSimulationTask } from "determined";
import { errAsync, ResultAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import {
  buildTurnSummaryInput,
  type TurnSummarizer,
  TurnSummaryCoordinator,
} from "./turn-summary.ts";

const task = new NoSimulationTask("turn-summary-test", false);

const input = { transcript: "User: fix it\n\nAgent: Fixed it." };

describe("turn summaries", () => {
  it("omits reasoning and raw tool output from Luna input", () => {
    const result = buildTurnSummaryInput([
      {
        id: "a",
        parentId: null,
        timestamp: "now",
        type: "message",
        role: "assistant",
        content: [
          { type: "reasoning", text: "secret chain" },
          { type: "tool_call", callId: "c", name: "bash", arguments: { command: "secret" } },
          { type: "text", text: "Updated the tests." },
        ],
        overflow: {},
      },
      {
        id: "t",
        parentId: "a",
        timestamp: "now",
        type: "message",
        role: "tool",
        content: [
          {
            type: "tool_result",
            callId: "c",
            content: [{ type: "text", text: "sensitive raw output" }],
          },
        ],
        overflow: {},
      },
    ]);
    expect(result?.transcript).toContain("Updated the tests.");
    expect(result?.transcript).toContain("used tool: bash");
    expect(result?.transcript).not.toContain("secret chain");
    expect(result?.transcript).not.toContain("sensitive raw output");
  });

  it("reports failures without producing a notification", async () => {
    const summaries: string[] = [];
    const errors: string[] = [];
    const summarizer: TurnSummarizer = {
      summarize: () => errAsync({ type: "turn_summary_error", message: "Luna unavailable" }),
    };
    const coordinator = new TurnSummaryCoordinator({
      task,
      summarizer,
      timeoutMs: 100,
      onSummary: (_operationId, summary) => summaries.push(summary),
      onError: (_operationId, error) => errors.push(error.message),
    });
    coordinator.enqueue("op-1", input);
    await Promise.resolve();
    await coordinator.drain();
    expect(summaries).toEqual([]);
    expect(errors).toEqual(["Luna unavailable"]);
  });

  it("accepts later work while an earlier summary is pending", async () => {
    const releases: (() => void)[] = [];
    const summarizer: TurnSummarizer = {
      summarize: (_input, context) =>
        ResultAsync.fromSafePromise(
          new Promise<string>((resolve) => {
            const abort = () => resolve("aborted");
            context.signal.addEventListener("abort", abort, { once: true });
            releases.push(() => {
              context.signal.removeEventListener("abort", abort);
              resolve("done");
            });
          }),
        ),
    };
    const completed: string[] = [];
    const coordinator = new TurnSummaryCoordinator({
      task,
      summarizer,
      timeoutMs: 5_000,
      maxConcurrency: 2,
      onSummary: (operationId) => completed.push(operationId),
      onError: () => undefined,
    });
    coordinator.enqueue("op-1", input);
    coordinator.enqueue("op-2", input);
    await Promise.resolve();
    expect(releases).toHaveLength(2);
    for (const release of releases) release();
    await coordinator.drain();
    expect(completed.sort()).toEqual(["op-1", "op-2"]);
  });
});
