import type {
  CompactionRecord,
  ContentBlock,
  EventRecord,
  HistoryRecord,
  MessageRecord,
} from "@pi-orb/protocol";
import type { PersistedToolCall, ToolResultBlock } from "./tool-activity.ts";

/** The adapter-derived shell view of a `pi.bash_execution` record. */
export type ShellExecution = NonNullable<EventRecord["shell"]>;

export function blockText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/**
 * One transcript record: a user turn, a grouped agent turn (all adjacent
 * assistant/tool/event records share one prefix), a shell block, or a
 * full-width compaction divider.
 */
export type Turn =
  | { kind: "user"; record: MessageRecord }
  | { kind: "agent"; key: string; records: Array<MessageRecord | EventRecord> }
  | { kind: "shell"; record: EventRecord; shell: ShellExecution }
  | { kind: "compaction"; record: CompactionRecord };

/** Per docs/pi-adapter.md, only a custom message the harness marked displayed is shown. */
export function isDisplayedCustomMessage(record: EventRecord): boolean {
  return record.eventType === "agent.settings_fallback" || record.custom?.display === true;
}

export function isSubagentNotice(record: EventRecord): boolean {
  return record.subagent !== undefined;
}

export function assistantFailure(record: MessageRecord): string | null {
  if (record.role !== "assistant" || record.finishReason !== "error") return null;
  const failure = record.failure;
  if (failure === undefined) return "Model response failed.";
  if (!failure.diagnostics.includes("provider_transport_failure")) return failure.message;
  const provider = record.model?.provider === "openai-codex" ? "OpenAI" : "the model provider";
  return `The agent’s connection to ${provider} was interrupted. ${failure.message}`;
}

/**
 * One rendered element of an agent turn. Tool calls collapse into maximal
 * runs; any visible prose, notice or failure between them breaks the run.
 */
export type AgentPart =
  | { kind: "tool_run"; key: string; calls: PersistedToolCall[] }
  | { kind: "subagent_notice"; key: string; record: EventRecord }
  | { kind: "event_text"; key: string; record: EventRecord; text: string }
  | { kind: "tool_result"; key: string; block: ToolResultBlock }
  | { kind: "block"; key: string; record: MessageRecord; block: ContentBlock }
  | { kind: "failure"; key: string; message: string };

export function splitAgentRecords(records: readonly (MessageRecord | EventRecord)[]): AgentPart[] {
  const parts: AgentPart[] = [];
  let runIndex = 0;
  let currentCalls: PersistedToolCall[] = [];
  let currentById = new Map<string, PersistedToolCall>();

  const flushTools = () => {
    if (currentCalls.length === 0) return;
    parts.push({ kind: "tool_run", key: `tools-${runIndex}`, calls: currentCalls });
    runIndex += 1;
    currentCalls = [];
    currentById = new Map();
  };

  for (const record of records) {
    if (record.type === "event") {
      flushTools();
      if (isSubagentNotice(record)) {
        parts.push({ kind: "subagent_notice", key: record.id, record });
        continue;
      }
      parts.push({
        kind: "event_text",
        key: record.id,
        record,
        text: blockText(record.content ?? []),
      });
      continue;
    }

    for (const [index, block] of record.content.entries()) {
      if (block.type === "tool_call") {
        const item: PersistedToolCall = { call: block };
        currentCalls.push(item);
        currentById.set(block.callId, item);
        continue;
      }
      if (block.type === "tool_result") {
        const item = currentById.get(block.callId);
        if (item !== undefined) {
          item.result = block;
        } else {
          flushTools();
          parts.push({ kind: "tool_result", key: `${record.id}-${index}`, block });
        }
        continue;
      }

      // Visible prose/reasoning/media is a boundary between maximal tool runs.
      flushTools();
      parts.push({ kind: "block", key: `${record.id}-${index}`, record, block });
    }
    const failure = assistantFailure(record);
    if (failure !== null) {
      flushTools();
      parts.push({ kind: "failure", key: `${record.id}-error`, message: failure });
    }
  }
  flushTools();
  return parts;
}

export function groupTurns(records: readonly HistoryRecord[]): Turn[] {
  const turns: Turn[] = [];
  const appendAgentPart = (record: MessageRecord | EventRecord) => {
    const last = turns[turns.length - 1];
    if (last !== undefined && last.kind === "agent") {
      last.records.push(record);
    } else {
      turns.push({ kind: "agent", key: record.id, records: [record] });
    }
  };
  for (const record of records) {
    switch (record.type) {
      case "message":
        if (record.role === "user") turns.push({ kind: "user", record });
        else appendAgentPart(record);
        break;
      case "compaction":
        turns.push({ kind: "compaction", record });
        break;
      case "event":
        if (record.shell !== undefined) {
          turns.push({ kind: "shell", record, shell: record.shell });
        } else if (isDisplayedCustomMessage(record)) {
          appendAgentPart(record);
        }
        break;
    }
  }
  return turns;
}

export function persistedToolCallIds(records: readonly HistoryRecord[]): Set<string> {
  const ids = new Set<string>();
  for (const record of records) {
    if (record.type !== "message") continue;
    for (const block of record.content) {
      if (block.type === "tool_call") ids.add(block.callId);
    }
  }
  return ids;
}
