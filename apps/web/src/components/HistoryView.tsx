import type {
  CompactionRecord,
  ContentBlock,
  EventRecord,
  HistoryRecord,
  MessageRecord,
  OrbMessageView,
} from "@pi-orb/protocol";
import type { ReactNode } from "react";
import { representedInboxMessageIds } from "../lib/queued-messages.ts";
import { ActivityRailRow } from "./ActivityRailRow.tsx";
import { ChatMarkdown } from "./ChatMarkdown.tsx";
import { PlainChatText } from "./ChatText.tsx";
import {
  type PersistedToolCall,
  ToolActivity,
  type ToolCallBlock,
  type ToolResultBlock,
} from "./ToolActivity.tsx";

/** Streaming output block accumulated from `output_patch` events. */
export interface LiveBlock {
  blockId: string;
  blockType: "text" | "reasoning" | "shell";
  text: string;
  revision: number;
}

/** Latest per-call tool state from `tool_state` events. */
export interface ToolChip {
  callId: string;
  name: string;
  state: "running" | "completed" | "failed";
  message: string | null;
}

interface HistoryViewProps {
  records: readonly HistoryRecord[];
  liveBlocks: readonly LiveBlock[];
  tools: readonly ToolChip[];
  busy: boolean;
  queuedMessages?: readonly OrbMessageView[];
}

const TOOL_ARGS_LIMIT = 200;

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function blockText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function renderToolCall(block: ContentBlock & { type: "tool_call" }): ReactNode {
  return (
    <details className="tool-details tool-call" key={`call-${block.callId}`}>
      <summary>→ {block.name}</summary>
      <pre className="tool-input">
        {truncate(JSON.stringify(block.arguments, null, 2), TOOL_ARGS_LIMIT)}
      </pre>
    </details>
  );
}

function renderToolResult(
  block: ContentBlock & { type: "tool_result" },
  key: string | number,
): ReactNode {
  return (
    <details className="tool-details" key={key}>
      <summary>{block.isError === true ? "tool error" : "tool output"}</summary>
      <pre className={block.isError === true ? "tool-output tool-error" : "tool-output"}>
        {blockText(block.content)}
      </pre>
    </details>
  );
}

function renderImageBlock(block: ContentBlock & { type: "image" }, key: number): ReactNode {
  const src =
    block.data !== undefined
      ? `data:${block.mediaType ?? "image/png"};base64,${block.data}`
      : block.url;
  return src !== undefined ? (
    <img className="msg-image" key={key} src={src} alt="attachment" />
  ) : (
    <div className="muted" key={key}>
      [image]
    </div>
  );
}

function renderReasoningRail(text: string, key: string | number, live = false): ReactNode {
  return (
    <ActivityRailRow
      className="reasoning"
      key={key}
      label="thinking"
      state={live ? "running" : "neutral"}
    >
      <p className="reasoning-body">
        <PlainChatText>{text}</PlainChatText>
      </p>
    </ActivityRailRow>
  );
}

function renderMessageBlocks(record: MessageRecord): ReactNode[] {
  const nodes: ReactNode[] = [];
  record.content.forEach((block, index) => {
    switch (block.type) {
      case "text":
        nodes.push(<ChatMarkdown key={index}>{block.text}</ChatMarkdown>);
        break;
      case "reasoning":
        nodes.push(renderReasoningRail(block.text, index));
        break;
      case "tool_call":
        nodes.push(renderToolCall(block));
        break;
      case "image":
        nodes.push(renderImageBlock(block, index));
        break;
      case "tool_result":
        nodes.push(renderToolResult(block, index));
        break;
      case "other":
        nodes.push(
          <div className="muted" key={index}>
            [{block.contentType}]
          </div>,
        );
        break;
    }
  });
  return nodes;
}

/**
 * One transcript record: a user turn, a grouped agent turn (all adjacent
 * assistant/tool/event records share one prefix), a shell block, or a
 * full-width compaction divider.
 */
type Turn =
  | { kind: "user"; record: MessageRecord }
  | { kind: "agent"; key: string; records: Array<MessageRecord | EventRecord> }
  | { kind: "shell"; record: EventRecord }
  | { kind: "compaction"; record: CompactionRecord };

interface BashExecutionView {
  command: string;
  output: string;
  exitCode: number | null;
  cancelled: boolean;
  truncated: boolean;
  excludeFromContext: boolean;
}

function bashExecutionView(record: EventRecord): BashExecutionView {
  const native = record.overflow["native"];
  const entry =
    typeof native === "object" && native !== null && !Array.isArray(native)
      ? (native as Record<string, unknown>)
      : null;
  const rawMessage = entry?.["message"];
  const message =
    typeof rawMessage === "object" && rawMessage !== null && !Array.isArray(rawMessage)
      ? (rawMessage as Record<string, unknown>)
      : null;
  return {
    command: typeof message?.["command"] === "string" ? message["command"] : "",
    output:
      typeof message?.["output"] === "string" ? message["output"] : blockText(record.content ?? []),
    exitCode: typeof message?.["exitCode"] === "number" ? message["exitCode"] : null,
    cancelled: message?.["cancelled"] === true,
    truncated: message?.["truncated"] === true,
    excludeFromContext: message?.["excludeFromContext"] === true,
  };
}

/** Per docs/pi-adapter.md, only `pi.custom_message` with native `display: true` is shown. */
function isDisplayedCustomMessage(record: EventRecord): boolean {
  if (record.eventType !== "pi.custom_message") return false;
  const native = record.overflow["native"];
  if (typeof native !== "object" || native === null || Array.isArray(native)) return false;
  return native["display"] === true;
}

function renderAgentRecords(records: readonly (MessageRecord | EventRecord)[]): ReactNode[] {
  const nodes: ReactNode[] = [];
  let runIndex = 0;
  let currentCalls: PersistedToolCall[] = [];
  let currentById = new Map<string, PersistedToolCall>();

  const flushTools = () => {
    if (currentCalls.length === 0) return;
    nodes.push(<ToolActivity persisted={currentCalls} key={`tools-${runIndex}`} />);
    runIndex += 1;
    currentCalls = [];
    currentById = new Map();
  };

  for (const record of records) {
    if (record.type === "event") {
      flushTools();
      nodes.push(
        <div className="record-custom" key={record.id}>
          <p className="msg-text">
            <PlainChatText>{blockText(record.content ?? [])}</PlainChatText>
          </p>
        </div>,
      );
      continue;
    }

    for (const [index, block] of record.content.entries()) {
      if (block.type === "tool_call") {
        const item: PersistedToolCall = { call: block as ToolCallBlock };
        currentCalls.push(item);
        currentById.set(block.callId, item);
        continue;
      }
      if (block.type === "tool_result") {
        const item = currentById.get(block.callId);
        if (item !== undefined) {
          item.result = block as ToolResultBlock;
          item.resultRecord = record;
        } else {
          flushTools();
          nodes.push(renderToolResult(block, `${record.id}-${index}`));
        }
        continue;
      }

      // Visible prose/reasoning/media is a boundary between maximal tool runs.
      flushTools();
      const singleBlockRecord: MessageRecord = { ...record, content: [block] };
      const rendered = renderMessageBlocks(singleBlockRecord);
      // Reasoning must be a direct child of the turn body so its rail row can
      // collapse the body's prose gap against adjacent activity rows.
      if (block.type === "reasoning") nodes.push(...rendered);
      else nodes.push(<div key={`${record.id}-${index}`}>{rendered}</div>);
    }
  }
  flushTools();
  return nodes;
}

function groupTurns(records: readonly HistoryRecord[]): Turn[] {
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
        if (record.eventType === "pi.bash_execution") {
          turns.push({ kind: "shell", record });
        } else if (isDisplayedCustomMessage(record)) {
          appendAgentPart(record);
        }
        break;
    }
  }
  return turns;
}

interface LiveAgentContent {
  blocks: readonly LiveBlock[];
  tools: readonly ToolChip[];
}

function renderLiveAgentContent(live: LiveAgentContent, busy: boolean): ReactNode[] {
  const nodes: ReactNode[] = [];
  if (live.tools.length > 0) nodes.push(<ToolActivity live={live.tools} key="live-tools" />);
  for (const block of live.blocks) {
    nodes.push(
      block.blockType === "reasoning" ? (
        renderReasoningRail(block.text, block.blockId, true)
      ) : (
        <ChatMarkdown key={block.blockId}>{block.text}</ChatMarkdown>
      ),
    );
  }
  // The cursor is the only claim that the agent is still producing output.
  if (busy) nodes.push(<span className="cur" key="cursor" />);
  return nodes;
}

function renderTurn(turn: Turn, live?: LiveAgentContent, busy = false): ReactNode {
  switch (turn.kind) {
    case "user":
      return (
        <article className="rec rec-you" key={turn.record.id}>
          <span className="rec-px">you</span>
          <div className="rec-bd">{renderMessageBlocks(turn.record)}</div>
        </article>
      );
    case "agent":
      return (
        <article className="rec rec-orb" key={turn.key}>
          <span className="rec-px">orb</span>
          <div className="rec-bd">
            {renderAgentRecords(turn.records)}
            {live !== undefined && renderLiveAgentContent(live, busy)}
          </div>
        </article>
      );
    case "shell": {
      const shell = bashExecutionView(turn.record);
      const statuses = [
        ...(shell.excludeFromContext ? ["excluded from model context"] : []),
        ...(shell.cancelled
          ? ["cancelled"]
          : shell.exitCode !== null && shell.exitCode !== 0
            ? [`exit ${shell.exitCode}`]
            : []),
        ...(shell.truncated ? ["output truncated"] : []),
      ];
      return (
        <article className="rec rec-sh" key={turn.record.id}>
          <span className="rec-px">sh</span>
          <div className="rec-bd">
            <div className="shblk">
              <div className="shblk-cmd">! {shell.command}</div>
              {shell.output !== "" && <pre className="shblk-out">{shell.output}</pre>}
              {statuses.length > 0 && <div className="shblk-ft">{statuses.join(" · ")}</div>}
            </div>
          </div>
        </article>
      );
    }
    case "compaction":
      return (
        <div className="record-compaction" key={turn.record.id}>
          <span className="compaction-line">context compacted</span>
          <details>
            <summary>summary</summary>
            <p className="msg-text">
              <PlainChatText>{blockText(turn.record.summary)}</PlainChatText>
            </p>
          </details>
        </div>
      );
  }
}

function liveBlockAlreadyPersisted(block: LiveBlock, records: readonly HistoryRecord[]): boolean {
  const persistedType = block.blockType === "reasoning" ? "reasoning" : "text";
  return records.some(
    (record) =>
      record.type === "message" &&
      record.role === "assistant" &&
      record.content.some(
        (content) => content.type === persistedType && content.text === block.text,
      ),
  );
}

function persistedToolCallIds(records: readonly HistoryRecord[]): Set<string> {
  const ids = new Set<string>();
  for (const record of records) {
    if (record.type !== "message") continue;
    for (const block of record.content) {
      if (block.type === "tool_call") ids.add(block.callId);
    }
  }
  return ids;
}

export function HistoryView({
  records,
  liveBlocks,
  tools,
  busy,
  queuedMessages = [],
}: HistoryViewProps) {
  const representedMessageIds = representedInboxMessageIds(records);
  const pendingMessages = queuedMessages.filter(
    (message) => !representedMessageIds.has(message.id),
  );
  const shellBlocks = liveBlocks.filter((block) => block.blockType === "shell");
  const turns = groupTurns(records);
  const finalTurn = turns[turns.length - 1];
  const finalAgentRecords = finalTurn?.kind === "agent" ? finalTurn.records : [];
  const agentBlocks = liveBlocks
    .filter((block) => block.blockType !== "shell")
    .filter((block) => !liveBlockAlreadyPersisted(block, finalAgentRecords));
  const committedToolCallIds = persistedToolCallIds(records);
  const uncommittedTools = tools.filter((tool) => !committedToolCallIds.has(tool.callId));
  const hasAgentLive = agentBlocks.length > 0 || uncommittedTools.length > 0;
  const mergeLiveIntoFinalTurn =
    hasAgentLive &&
    finalTurn?.kind === "agent" &&
    pendingMessages.length === 0 &&
    shellBlocks.length === 0;
  const mergedTurnIndex = mergeLiveIntoFinalTurn ? turns.length - 1 : -1;
  const liveAgentContent: LiveAgentContent = { blocks: agentBlocks, tools: uncommittedTools };
  return (
    <div className="history">
      {turns.map((turn, index) =>
        index === mergedTurnIndex ? renderTurn(turn, liveAgentContent, busy) : renderTurn(turn),
      )}
      {pendingMessages.map((message) => {
        const record: MessageRecord = {
          id: `queued:${message.id}`,
          parentId: null,
          timestamp: message.createdAt,
          type: "message",
          role: "user",
          content: message.content,
          overflow: {},
        };
        const status =
          message.status === "failed"
            ? "failed"
            : message.delivery === "steer"
              ? "steering"
              : message.status;
        // A message the runtime refused for good is terminal: say so where the
        // message is, with the reason, rather than leaving it looking pending
        // forever (docs/runtime-protocol.md).
        const failed = message.status === "failed";
        return (
          <article className="rec rec-you rec-q" key={message.id}>
            <span className="rec-px">you</span>
            <div className="rec-bd">
              <span className="rec-status">{status}</span>
              {renderMessageBlocks(record)}
              {failed && message.error !== undefined && (
                <div className="error-text">{message.error}</div>
              )}
            </div>
          </article>
        );
      })}
      {shellBlocks.map((block) => (
        <article className="rec rec-sh" key={block.blockId}>
          <span className="rec-px">sh</span>
          <div className="rec-bd">
            <div className="shblk">
              <pre className="shblk-out">{block.text}</pre>
            </div>
          </div>
        </article>
      ))}
      {hasAgentLive && !mergeLiveIntoFinalTurn && (
        <article className="rec rec-orb">
          <span className="rec-px">orb</span>
          <div className="rec-bd">{renderLiveAgentContent(liveAgentContent, busy)}</div>
        </article>
      )}
      {busy && !hasAgentLive && (
        <div className="busy-indicator">
          <span className="cur" />
        </div>
      )}
    </div>
  );
}
