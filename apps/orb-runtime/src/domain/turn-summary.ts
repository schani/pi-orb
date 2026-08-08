import type { HistoryRecord } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, ok, type Result, ResultAsync } from "neverthrow";

const MAX_SUMMARY_INPUT_CHARS = 12_000;

export interface TurnSummaryInput {
  readonly transcript: string;
}

export interface TurnSummaryError {
  readonly type: "turn_summary_error";
  readonly message: string;
}

export interface TurnSummarizer {
  summarize(
    input: TurnSummaryInput,
    context: { readonly signal: AbortSignal },
  ): ResultAsync<string, TurnSummaryError>;
}

function textContent(record: HistoryRecord): string[] {
  if (record.type !== "message") return [];
  const lines: string[] = [];
  for (const block of record.content) {
    if (block.type === "text") lines.push(block.text);
    if (record.role === "assistant" && block.type === "tool_call") {
      lines.push(`[used tool: ${block.name}]`);
    }
    if (record.role === "tool" && block.type === "tool_result") {
      lines.push(`[tool ${block.isError === true ? "failed" : "completed"}]`);
    }
  }
  return lines;
}

/** Build a small, immutable view of one turn; reasoning and raw tool output are omitted. */
export function buildTurnSummaryInput(records: readonly HistoryRecord[]): TurnSummaryInput | null {
  const sections: string[] = [];
  for (const record of records) {
    if (record.type !== "message") continue;
    if (record.role !== "user" && record.role !== "assistant" && record.role !== "tool") continue;
    const text = textContent(record).join("\n").trim();
    if (text === "") continue;
    const role = record.role === "tool" ? "Tool" : record.role === "user" ? "User" : "Agent";
    sections.push(`${role}: ${text}`);
  }
  const transcript = sections.join("\n\n").slice(-MAX_SUMMARY_INPUT_CHARS).trim();
  return transcript === "" ? null : { transcript };
}

interface SummaryJob {
  readonly operationId: string;
  readonly input: TurnSummaryInput;
}

export interface TurnSummaryCoordinatorOptions {
  readonly task: SimulationTask;
  readonly summarizer: TurnSummarizer;
  readonly timeoutMs: number;
  readonly maxConcurrency?: number;
  readonly maxQueued?: number;
  readonly onSummary: (operationId: string, summary: string) => void;
  readonly onError: (operationId: string, error: TurnSummaryError) => void;
}

/**
 * Best-effort background summary queue. Enqueue never waits for inference, and every adapter
 * failure is consumed here rather than crossing into the agent-operation state machine.
 */
export class TurnSummaryCoordinator {
  private readonly options: TurnSummaryCoordinatorOptions;
  private readonly queue: SummaryJob[] = [];
  private readonly drainWaiters: (() => void)[] = [];
  private active = 0;

  constructor(options: TurnSummaryCoordinatorOptions) {
    this.options = options;
  }

  enqueue(operationId: string, input: TurnSummaryInput): void {
    const maxQueued = this.options.maxQueued ?? 8;
    if (this.queue.length >= maxQueued) {
      this.options.onError(operationId, {
        type: "turn_summary_error",
        message: "summary queue is full",
      });
      return;
    }
    this.queue.push({ operationId, input });
    this.pump();
  }

  /** Test/diagnostic barrier only; runtime shutdown deliberately does not call it. */
  drain(): Promise<void> {
    if (this.active === 0 && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.push(resolve));
  }

  private pump(): void {
    const maxConcurrency = this.options.maxConcurrency ?? 2;
    while (this.active < maxConcurrency) {
      const job = this.queue.shift();
      if (job === undefined) break;
      this.active++;
      void this.run(job);
    }
  }

  private async run(job: SummaryJob): Promise<void> {
    const result = await ResultAsync.fromPromise(
      this.options.task.withTimedSignal(
        (signal) =>
          this.options.summarizer.summarize(job.input, { signal }).match(
            (value) => ok<string, TurnSummaryError>(value),
            (error) => err<string, TurnSummaryError>(error),
          ),
        this.options.timeoutMs,
        `Luna summary ${job.operationId}`,
      ),
      (cause): TurnSummaryError => ({
        type: "turn_summary_error",
        message: cause instanceof Error ? cause.message : String(cause),
      }),
    ).andThen((nested) => nested);

    if (result.isOk()) this.options.onSummary(job.operationId, result.value);
    else this.options.onError(job.operationId, result.error);

    this.active--;
    this.pump();
    if (this.active === 0 && this.queue.length === 0) {
      for (const resolve of this.drainWaiters.splice(0)) resolve();
    }
  }
}

export function normalizedSummary(text: string): Result<string, TurnSummaryError> {
  const summary = text.replace(/\s+/g, " ").trim().slice(0, 240);
  return summary === ""
    ? err({ type: "turn_summary_error", message: "Luna returned an empty summary" })
    : ok(summary);
}
