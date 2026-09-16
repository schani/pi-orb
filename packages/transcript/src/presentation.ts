import type { ContentBlock, HistoryRecord, MessageRecord, OrbMessageView } from "@pi-orb/protocol";
import {
  type AgentPart,
  blockText,
  groupTurns,
  persistedToolCallIds,
  type ShellExecution,
  splitAgentRecords,
  type Turn,
} from "./grouping.ts";
import { representedInboxMessageIds } from "./queued-messages.ts";
import type { LiveBlock, ToolChip } from "./state.ts";
import { type ActivityCategory, activityCalls, categorize } from "./tool-activity.ts";

export interface PresentationInput {
  records: readonly HistoryRecord[];
  liveBlocks?: readonly LiveBlock[];
  tools?: readonly ToolChip[];
  queuedMessages?: readonly OrbMessageView[];
  busy?: boolean;
}

/** Live agent output, either at the tail of the final turn or standing alone. */
export interface LiveTail {
  categories: ActivityCategory[];
  blocks: LiveBlock[];
  busy: boolean;
}

export type PresentedPart =
  | { kind: "tool_run"; key: string; categories: ActivityCategory[] }
  /** `copySource` is the response's raw Markdown on the block that hosts its copy action. */
  | (Extract<AgentPart, { kind: "block" }> & { copySource: string | null })
  | Exclude<AgentPart, { kind: "tool_run" | "block" }>;

/** One row of the rendered transcript, in order. */
export type PresentedRow =
  | { kind: "user"; key: string; record: MessageRecord }
  | { kind: "agent"; key: string; parts: PresentedPart[]; live: LiveTail | null }
  | { kind: "shell"; key: string; shell: ShellExecution }
  | { kind: "compaction"; key: string; summary: string }
  | { kind: "queued"; key: string; record: MessageRecord; status: string; error: string | null }
  | { kind: "live_shell"; key: string; text: string }
  | { kind: "busy"; key: string };

/**
 * The raw Markdown of one assistant response: every non-empty text block in
 * order, so copying preserves fences, links and emphasis (docs/web-ui.md).
 */
export function assistantResponseMarkdown(record: MessageRecord): string | null {
  if (record.role !== "assistant") return null;
  const parts = record.content
    .filter((block): block is ContentBlock & { type: "text" } => block.type === "text")
    .map((block) => block.text)
    .filter((text) => text.trim() !== "");
  return parts.length === 0 ? null : parts.join("\n\n");
}

/** A response owns one copy action, hosted by its first non-empty text block. */
function copySource(record: MessageRecord, block: ContentBlock): string | null {
  if (block.type !== "text" || block.text.trim() === "") return null;
  const first = record.content.find((other) => other.type === "text" && other.text.trim() !== "");
  return block === first ? assistantResponseMarkdown(record) : null;
}

function presentPart(part: AgentPart): PresentedPart {
  switch (part.kind) {
    case "tool_run":
      return {
        kind: "tool_run",
        key: part.key,
        categories: categorize(activityCalls(part.calls, [])),
      };
    case "block":
      return { ...part, copySource: copySource(part.record, part.block) };
    default:
      return part;
  }
}

function turnRow(turn: Turn): PresentedRow {
  switch (turn.kind) {
    case "user":
      return { kind: "user", key: turn.record.id, record: turn.record };
    case "agent":
      return {
        kind: "agent",
        key: turn.key,
        parts: splitAgentRecords(turn.records).map(presentPart),
        live: null,
      };
    case "shell":
      return { kind: "shell", key: turn.record.id, shell: turn.shell };
    case "compaction":
      return { kind: "compaction", key: turn.record.id, summary: blockText(turn.record.summary) };
  }
}

/**
 * The whole rendering decision for one conversation: which turns exist, where
 * the live tail attaches, which tool calls the transcript already owns, and
 * which inbox rows still need a provisional turn. Clients render the result
 * and decide nothing further (docs/transcript-model.md).
 */
export function presentTranscript(input: PresentationInput): PresentedRow[] {
  const liveBlocks = input.liveBlocks ?? [];
  const busy = input.busy ?? false;

  // An inbox row is retired by the record that represents it, whatever its
  // control-plane status: the transcript itself is now the receipt.
  const represented = representedInboxMessageIds(input.records);
  const queued = (input.queuedMessages ?? []).filter((message) => !represented.has(message.id));

  // A committed tool call owns its chip; only live-only calls join the tail.
  const committed = persistedToolCallIds(input.records);
  const liveCalls = (input.tools ?? [])
    .filter((tool) => !committed.has(tool.callId))
    .map(({ callId, name, state }) => ({ callId, name, state }));

  const shellBlocks = liveBlocks.filter((block) => block.blockType === "shell");
  const agentBlocks = liveBlocks.filter((block) => block.blockType !== "shell");
  const live: LiveTail | null =
    agentBlocks.length > 0 || liveCalls.length > 0
      ? { categories: categorize(activityCalls([], liveCalls)), blocks: agentBlocks, busy }
      : null;

  const rows: PresentedRow[] = groupTurns(input.records).map(turnRow);

  // Live output continues the final turn only when nothing else already
  // separates it from that turn.
  const last = rows[rows.length - 1];
  const tail =
    live !== null && queued.length === 0 && shellBlocks.length === 0 && last?.kind === "agent"
      ? last
      : null;
  if (tail !== null) tail.live = live;

  for (const message of queued) {
    rows.push({
      kind: "queued",
      key: message.id,
      record: {
        id: `queued:${message.id}`,
        parentId: null,
        timestamp: message.createdAt,
        type: "message",
        role: "user",
        content: message.content,
        overflow: {},
      },
      status:
        message.status === "failed"
          ? "failed"
          : message.delivery === "steer"
            ? "steering"
            : message.status,
      // A message the runtime refused for good is terminal: say so where the
      // message is, with the reason, rather than leaving it looking pending
      // forever (docs/runtime-protocol.md).
      error: message.status === "failed" ? (message.error ?? null) : null,
    });
  }
  for (const block of shellBlocks) {
    rows.push({ kind: "live_shell", key: block.blockId, text: block.text });
  }
  if (live !== null && tail === null) rows.push({ kind: "agent", key: "live", parts: [], live });
  // Only authoritative busy state can keep the activity marker alive.
  if (busy && live === null) rows.push({ kind: "busy", key: "busy" });
  return rows;
}
