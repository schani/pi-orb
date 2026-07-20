import type { ReactNode } from "react";
import type {
  CompactionRecord,
  ContentBlock,
  EventRecord,
  HistoryRecord,
  MessageRecord,
} from "@pi-orb/protocol";
import { AssistantMarkdown } from "./AssistantMarkdown.tsx";

/** Streaming output block accumulated from `output_patch` events. */
export interface LiveBlock {
  blockId: string;
  blockType: "text" | "reasoning";
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
    <div className="tool-call" key={`call-${block.callId}`}>
      → {block.name}({truncate(JSON.stringify(block.arguments), TOOL_ARGS_LIMIT)})
    </div>
  );
}

function renderMessageBlocks(record: MessageRecord): ReactNode[] {
  const nodes: ReactNode[] = [];
  record.content.forEach((block, index) => {
    switch (block.type) {
      case "text":
        nodes.push(
          record.role === "assistant" ? (
            <AssistantMarkdown key={index}>{block.text}</AssistantMarkdown>
          ) : (
            <p className="msg-text" key={index}>
              {block.text}
            </p>
          ),
        );
        break;
      case "reasoning":
        nodes.push(
          <details className="reasoning" key={index}>
            <summary>reasoning</summary>
            <p className="msg-text">{block.text}</p>
          </details>,
        );
        break;
      case "tool_call":
        nodes.push(renderToolCall(block));
        break;
      case "image":
        nodes.push(
          <div className="muted" key={index}>
            [image]
          </div>,
        );
        break;
      case "tool_result":
        nodes.push(
          <pre
            className={block.isError === true ? "tool-output tool-error" : "tool-output"}
            key={index}
          >
            {blockText(block.content)}
          </pre>,
        );
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

function renderToolMessage(record: MessageRecord): ReactNode {
  const results = record.content.filter((block) => block.type === "tool_result");
  return (
    <div className="record record-tool" key={record.id}>
      {results.map((block, index) => (
        <pre
          className={block.isError === true ? "tool-output tool-error" : "tool-output"}
          key={index}
        >
          {blockText(block.content)}
        </pre>
      ))}
    </div>
  );
}

function renderMessage(record: MessageRecord): ReactNode {
  if (record.role === "tool") return renderToolMessage(record);
  const role = record.role ?? "message";
  return (
    <div className={`record record-${role}`} key={record.id}>
      <div className="record-role">{role}</div>
      {renderMessageBlocks(record)}
    </div>
  );
}

function renderCompaction(record: CompactionRecord): ReactNode {
  return (
    <div className="record record-compaction" key={record.id}>
      <span className="compaction-line">— conversation compacted —</span>
      <details>
        <summary>summary</summary>
        <p className="msg-text">{blockText(record.summary)}</p>
      </details>
    </div>
  );
}

/** Per DESIGN §9.4, only `pi.custom_message` with native `display: true` is shown. */
function isDisplayedCustomMessage(record: EventRecord): boolean {
  if (record.eventType !== "pi.custom_message") return false;
  const native = record.overflow["native"];
  if (typeof native !== "object" || native === null || Array.isArray(native)) return false;
  return native["display"] === true;
}

function renderEvent(record: EventRecord): ReactNode {
  if (!isDisplayedCustomMessage(record)) return null;
  return (
    <div className="record record-custom" key={record.id}>
      <p className="msg-text">{blockText(record.content ?? [])}</p>
    </div>
  );
}

function renderRecord(record: HistoryRecord): ReactNode {
  switch (record.type) {
    case "message":
      return renderMessage(record);
    case "compaction":
      return renderCompaction(record);
    case "event":
      return renderEvent(record);
  }
}

function toolChipClass(state: ToolChip["state"]): string {
  return `tool-chip tool-chip-${state}`;
}

export function HistoryView({ records, liveBlocks, tools, busy }: HistoryViewProps) {
  const hasLive = liveBlocks.length > 0 || tools.length > 0;
  return (
    <div className="history">
      {records.map(renderRecord)}
      {hasLive && (
        <div className="record record-live">
          <div className="record-role">assistant (streaming)</div>
          {liveBlocks.map((block) =>
            block.blockType === "reasoning" ? (
              <details className="reasoning" key={block.blockId}>
                <summary>reasoning</summary>
                <p className="msg-text">{block.text}</p>
              </details>
            ) : (
              <AssistantMarkdown key={block.blockId}>{block.text}</AssistantMarkdown>
            ),
          )}
          {tools.length > 0 && (
            <div className="tool-chips">
              {tools.map((tool) => (
                <span
                  className={toolChipClass(tool.state)}
                  key={tool.callId}
                  title={tool.message ?? undefined}
                >
                  {tool.name} · {tool.state}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      {busy && <div className="busy-indicator">working…</div>}
    </div>
  );
}
