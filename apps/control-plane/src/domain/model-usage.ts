import {
  CLAUDE_MODEL_CALL_EVENT,
  ClaudeModelCallSchema,
  type HistoryRecord,
  type ModelCallUse,
} from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { Check } from "typebox/value";

export type { ModelCallUse } from "@pi-orb/protocol";

/** One `model_calls` row (docs/model-usage.md): provider-reported accounting, never content. */
export interface ModelCall {
  readonly ownerUserId: string;
  readonly orbId: string;
  /** A `ModelCallUse`, or a Claude auxiliary call's raw `query_source`. */
  readonly use: string;
  readonly provider: string;
  readonly model: string;
  /** `AssistantMessage.stopReason`; `ok`/`error` for Claude. */
  readonly outcome: string;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  /** Provider-side list-price estimate. */
  readonly costUsd?: number;
  readonly durationMs?: number;
  /** Provider response ID, equal to the history message's `responseId`; Pi only. */
  readonly responseId?: string;
  /** Milliseconds from request start to the first streamed content event; Pi streamed calls only. */
  readonly ttftMs?: number;
  /** Milliseconds from request start to the first answer (text or tool call) after streamed reasoning. */
  readonly thinkingMs?: number;
  /** Pi Durable calls: the conversation's `pi.provider` session ID. */
  readonly sessionId?: string;
}

/** What a capture point observed besides the response: stream timing and the provider session. */
export type ModelCallTiming = Pick<ModelCall, "ttftMs" | "thinkingMs" | "sessionId">;

/** Content-free ledger of platform-managed model calls; `record` stamps the time and never blocks or fails the call. */
export interface ModelUsageLedger {
  record(task: SimulationTask, call: ModelCall): void;
}

function claudeUse(querySource: string | undefined): ModelCallUse | string {
  if (querySource === undefined) return "unknown";
  if (querySource === "sdk") return "root";
  if (querySource.startsWith("agent:")) return "subagent";
  if (querySource === "compact") return "compaction";
  return querySource;
}

/** The `model_calls` row for a replicated `claude.model_call` record; null for any other or malformed record. */
export function claudeModelCall(
  record: HistoryRecord,
): (Omit<ModelCall, "ownerUserId" | "orbId"> & { readonly at: number }) | null {
  if (record.type !== "event" || record.eventType !== CLAUDE_MODEL_CALL_EVENT) return null;
  const call = record.overflow;
  if (!Check(ClaudeModelCallSchema, call)) return null;
  const at = Date.parse(call.at);
  if (Number.isNaN(at)) return null;
  const { querySource: _, at: _at, ...counts } = call;
  return { ...counts, at, use: claudeUse(call.querySource), provider: "anthropic" };
}
