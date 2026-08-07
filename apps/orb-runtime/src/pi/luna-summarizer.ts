import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ResultAsync } from "neverthrow";
import {
  normalizedSummary,
  type TurnSummarizer,
  type TurnSummaryError,
  type TurnSummaryInput,
} from "../domain/turn-summary.ts";

/** OpenAI's small Luna model; it is available through the existing Codex OAuth provider. */
export const LUNA_MODEL_ID = "gpt-5.6-luna";

const summaryPrompt = (input: TurnSummaryInput): string =>
  [
    "Write a single short desktop-notification sentence describing what the coding agent did.",
    "Use plain text, past tense, at most 180 characters, and no preamble or markdown.",
    "Do not mention hidden reasoning. Be concrete about the main change or result.",
    "",
    "<turn>",
    input.transcript,
    "</turn>",
  ].join("\n");

/** A separate inference call: it never touches AgentSession or Pi history. */
export class LunaTurnSummarizer implements TurnSummarizer {
  private readonly runtime: ModelRuntime;
  private readonly model: Parameters<ModelRuntime["completeSimple"]>[0];

  constructor(runtime: ModelRuntime, modelTemplate: Parameters<ModelRuntime["completeSimple"]>[0]) {
    this.runtime = runtime;
    this.model = { ...modelTemplate, id: LUNA_MODEL_ID, name: "Luna" };
  }

  summarize(
    input: TurnSummaryInput,
    context: { readonly signal: AbortSignal },
  ): ResultAsync<string, TurnSummaryError> {
    return ResultAsync.fromPromise(
      this.runtime.completeSimple(
        this.model,
        {
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: summaryPrompt(input) }],
              timestamp: Date.now(),
            },
          ],
        },
        {
          signal: context.signal,
          reasoning: "minimal",
          maxTokens: 80,
          maxRetries: 0,
        },
      ),
      (cause): TurnSummaryError => ({
        type: "turn_summary_error",
        message: cause instanceof Error ? cause.message : String(cause),
      }),
    ).andThen((response) => {
      if (response.stopReason === "error" || response.stopReason === "aborted") {
        return normalizedSummary(response.errorMessage ?? "").mapErr(() => ({
          type: "turn_summary_error" as const,
          message: response.errorMessage ?? `Luna stopped with ${response.stopReason}`,
        }));
      }
      const text = response.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join(" ");
      return normalizedSummary(text);
    });
  }
}
