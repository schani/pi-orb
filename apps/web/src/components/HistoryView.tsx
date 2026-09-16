import type { ContentBlock, HistoryRecord, MessageRecord, OrbMessageView } from "@pi-orb/protocol";
import {
  blockText,
  type LiveBlock,
  type LiveTail,
  type PresentedPart,
  type PresentedRow,
  presentTranscript,
  type ToolChip,
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

function renderParts(parts: readonly PresentedPart[]): ReactNode[] {
  const nodes: ReactNode[] = [];
  for (const part of parts) {
    switch (part.kind) {
      case "tool_run":
        nodes.push(<ToolActivity categories={part.categories} key={part.key} />);
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
        if (part.block.type === "text" && part.copySource !== null) {
          nodes.push(
            <ResponseMarkdown
              key={part.key}
              markdown={part.block.text}
              copySource={part.copySource}
            />,
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

function renderLive(live: LiveTail): ReactNode[] {
  const nodes: ReactNode[] = [];
  if (live.categories.length > 0) {
    nodes.push(<ToolActivity categories={live.categories} key="live-tools" />);
  }
  for (const block of live.blocks) {
    nodes.push(
      block.blockType === "reasoning" ? (
        renderReasoningRail(block.text, block.blockId, true)
      ) : block.text.trim() === "" ? null : (
        <ResponseMarkdown key={block.blockId} markdown={block.text} copySource={block.text} />
      ),
    );
  }
  if (live.busy) nodes.push(<BitRegister key="busy" />);
  return nodes;
}

function renderRow(row: PresentedRow): ReactNode {
  switch (row.kind) {
    case "user":
      return (
        <article className="rec rec-you" key={row.key}>
          <span className="visually-hidden">You:</span>
          <div className="rec-bd">{renderMessageBlocks(row.record)}</div>
        </article>
      );
    case "agent":
      return (
        <article className="rec rec-orb" key={row.key}>
          <span className="visually-hidden">Orb:</span>
          <div className="rec-bd">
            {renderParts(row.parts)}
            {row.live !== null && renderLive(row.live)}
          </div>
        </article>
      );
    case "shell": {
      const statuses = [
        ...(row.shell.excludeFromContext ? ["excluded from model context"] : []),
        ...(row.shell.cancelled
          ? ["cancelled"]
          : row.shell.exitCode !== null && row.shell.exitCode !== 0
            ? [`exit ${row.shell.exitCode}`]
            : []),
        ...(row.shell.truncated ? ["output truncated"] : []),
      ];
      return (
        <article className="rec rec-sh" key={row.key}>
          <span className="rec-px">sh</span>
          <div className="rec-bd">
            <div className="shblk">
              <div className="shblk-cmd">! {row.shell.command}</div>
              {row.shell.output !== "" && <pre className="shblk-out">{row.shell.output}</pre>}
              {statuses.length > 0 && <div className="shblk-ft">{statuses.join(" · ")}</div>}
            </div>
          </div>
        </article>
      );
    }
    case "compaction":
      return (
        <div className="record-compaction" key={row.key}>
          <span className="compaction-line">context compacted</span>
          <details>
            <summary>summary</summary>
            <p className="msg-text">
              <PlainChatText>{row.summary}</PlainChatText>
            </p>
          </details>
        </div>
      );
    case "queued":
      return (
        <article className="rec rec-you rec-q" key={row.key}>
          <span className="visually-hidden">You:</span>
          <div className="rec-bd">
            <span className="rec-status">{row.status}</span>
            {renderMessageBlocks(row.record)}
            {row.error !== null && <div className="error-text">{row.error}</div>}
          </div>
        </article>
      );
    case "live_shell":
      return (
        <article className="rec rec-sh" key={row.key}>
          <span className="rec-px">sh</span>
          <div className="rec-bd">
            <div className="shblk">
              <pre className="shblk-out">{row.text}</pre>
            </div>
          </div>
        </article>
      );
    case "busy":
      return (
        <div className="busy-indicator" key={row.key}>
          <BitRegister />
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
  const rows = presentTranscript({ records, liveBlocks, tools, queuedMessages, busy });
  return <div className="history">{rows.map(renderRow)}</div>;
});
