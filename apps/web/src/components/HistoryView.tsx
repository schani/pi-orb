import type {
  ContentBlock,
  EventRecord,
  HistoryRecord,
  MessageRecord,
  OrbMessageView,
} from "@pi-orb/protocol";
import {
  blockText,
  groupTurns,
  type LiveBlock,
  persistedToolCallIds,
  representedInboxMessageIds,
  splitAgentRecords,
  type ToolChip,
  type Turn,
} from "@pi-orb/transcript";
import { memo, type ReactNode } from "react";
import { ActivityRailRow } from "./ActivityRailRow.tsx";
import { BitRegister } from "./BitRegister.tsx";
import { ChatMarkdown } from "./ChatMarkdown.tsx";
import { PlainChatText } from "./ChatText.tsx";
import { ResponseMarkdown } from "./ResponseMarkdown.tsx";
import { SubagentNotice } from "./SubagentNotice.tsx";
import { ToolActivity } from "./ToolActivity.tsx";

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

export function assistantResponseMarkdown(record: MessageRecord): string | null {
  if (record.role !== "assistant") return null;
  const parts = record.content
    .filter((block): block is ContentBlock & { type: "text" } => block.type === "text")
    .map((block) => block.text)
    .filter((text) => text.trim() !== "");
  return parts.length === 0 ? null : parts.join("\n\n");
}

/** One response owns one copy action, hosted by its first non-empty text block. */
function responseCopySource(record: MessageRecord, block: ContentBlock): string | null {
  if (block.type !== "text" || block.text.trim() === "") return null;
  const first = record.content.find((other) => other.type === "text" && other.text.trim() !== "");
  return block === first ? assistantResponseMarkdown(record) : null;
}

function renderAgentRecords(records: readonly (MessageRecord | EventRecord)[]): ReactNode[] {
  const nodes: ReactNode[] = [];
  for (const part of splitAgentRecords(records)) {
    switch (part.kind) {
      case "tool_run":
        nodes.push(<ToolActivity persisted={part.calls} key={part.key} />);
        break;
      case "subagent_notice":
        nodes.push(<SubagentNotice key={part.key} record={part.record} />);
        break;
      case "event_text":
        nodes.push(
          <div className="record-custom" key={part.key}>
            <p className="msg-text">
              <PlainChatText>{part.text}</PlainChatText>
            </p>
          </div>,
        );
        break;
      case "tool_result":
        nodes.push(renderToolResult(part.block, part.key));
        break;
      case "block": {
        const copySource = responseCopySource(part.record, part.block);
        if (part.block.type === "text" && copySource !== null) {
          nodes.push(
            <ResponseMarkdown key={part.key} markdown={part.block.text} copySource={copySource} />,
          );
          break;
        }
        const rendered = renderMessageBlocks({ ...part.record, content: [part.block] });
        // Reasoning must be a direct child of the turn body so its rail row can
        // collapse the body's prose gap against adjacent activity rows.
        if (part.block.type === "reasoning") nodes.push(...rendered);
        else nodes.push(<div key={part.key}>{rendered}</div>);
        break;
      }
      case "failure":
        nodes.push(
          <p className="error-text" role="alert" key={part.key}>
            <PlainChatText>{part.message}</PlainChatText>
          </p>,
        );
        break;
    }
  }
  return nodes;
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
      ) : block.text.trim() === "" ? null : (
        <ResponseMarkdown key={block.blockId} markdown={block.text} copySource={block.text} />
      ),
    );
  }
  // Only authoritative busy state can keep the activity marker alive.
  if (busy) nodes.push(<BitRegister key="busy" />);
  return nodes;
}

function renderTurn(turn: Turn, live?: LiveAgentContent, busy = false): ReactNode {
  switch (turn.kind) {
    case "user":
      return (
        <article className="rec rec-you" key={turn.record.id}>
          <span className="visually-hidden">You:</span>
          <div className="rec-bd">{renderMessageBlocks(turn.record)}</div>
        </article>
      );
    case "agent":
      return (
        <article className="rec rec-orb" key={turn.key}>
          <span className="visually-hidden">Orb:</span>
          <div className="rec-bd">
            {renderAgentRecords(turn.records)}
            {live !== undefined && renderLiveAgentContent(live, busy)}
          </div>
        </article>
      );
    case "shell": {
      const shell = turn.shell;
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

export const HistoryView = memo(function HistoryView({
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
  const agentBlocks = liveBlocks.filter((block) => block.blockType !== "shell");
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
            <span className="visually-hidden">You:</span>
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
          <span className="visually-hidden">Orb:</span>
          <div className="rec-bd">{renderLiveAgentContent(liveAgentContent, busy)}</div>
        </article>
      )}
      {busy && !hasAgentLive && (
        <div className="busy-indicator">
          <BitRegister />
        </div>
      )}
    </div>
  );
});
