import type {
  CompactionRecord,
  ContentBlock,
  EventRecord,
  HistoryRecord,
  MessageRecord,
} from "@pi-orb/protocol";
import type { ReactNode } from "react";
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
            <p className="reasoning-body">{block.text}</p>
          </details>,
        );
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
 * One visual row of the manuscript: a user note, a grouped agent turn (all
 * adjacent assistant/tool/event records share one gutter mark), or a
 * full-width compaction divider.
 */
type Turn =
  | { kind: "user"; record: MessageRecord }
  | { kind: "agent"; key: string; parts: ReactNode[] }
  | { kind: "compaction"; record: CompactionRecord };

/** Per DESIGN §9.4, only `pi.custom_message` with native `display: true` is shown. */
function isDisplayedCustomMessage(record: EventRecord): boolean {
  if (record.eventType !== "pi.custom_message") return false;
  const native = record.overflow["native"];
  if (typeof native !== "object" || native === null || Array.isArray(native)) return false;
  return native["display"] === true;
}

function renderAgentPart(record: MessageRecord | EventRecord): ReactNode {
  if (record.type === "event") {
    return (
      <div className="record-custom" key={record.id}>
        <p className="msg-text">{blockText(record.content ?? [])}</p>
      </div>
    );
  }
  if (record.role === "tool") {
    return (
      <div className="agent-tool-results" key={record.id}>
        {record.content
          .filter((block) => block.type === "tool_result")
          .map((block, index) => renderToolResult(block, `${record.id}-${index}`))}
      </div>
    );
  }
  return <div key={record.id}>{renderMessageBlocks(record)}</div>;
}

function groupTurns(records: readonly HistoryRecord[]): Turn[] {
  const turns: Turn[] = [];
  const appendAgentPart = (record: MessageRecord | EventRecord) => {
    const last = turns[turns.length - 1];
    if (last !== undefined && last.kind === "agent") {
      last.parts.push(renderAgentPart(record));
    } else {
      turns.push({ kind: "agent", key: record.id, parts: [renderAgentPart(record)] });
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
        if (isDisplayedCustomMessage(record)) appendAgentPart(record);
        break;
    }
  }
  return turns;
}

function Gutter({ mark }: { mark: "Y" | "O" }) {
  return (
    <div className="turn-gutter">
      <span className="turn-mark">{mark}</span>
      <span className="turn-rail" />
    </div>
  );
}

function renderTurn(turn: Turn): ReactNode {
  switch (turn.kind) {
    case "user":
      return (
        <article className="turn turn-user" key={turn.record.id}>
          <Gutter mark="Y" />
          <div className="turn-body">
            <span className="turn-label">You</span>
            {renderMessageBlocks(turn.record)}
          </div>
        </article>
      );
    case "agent":
      return (
        <article className="turn turn-agent" key={turn.key}>
          <Gutter mark="O" />
          <div className="turn-body">
            <span className="turn-label">Orb</span>
            {turn.parts}
          </div>
        </article>
      );
    case "compaction":
      return (
        <div className="record-compaction" key={turn.record.id}>
          <span className="compaction-line">context compacted</span>
          <details>
            <summary>summary</summary>
            <p className="msg-text">{blockText(turn.record.summary)}</p>
          </details>
        </div>
      );
  }
}

function toolChipClass(state: ToolChip["state"]): string {
  return `tool-chip tool-chip-${state}`;
}

export function HistoryView({ records, liveBlocks, tools, busy }: HistoryViewProps) {
  const hasLive = liveBlocks.length > 0 || tools.length > 0;
  return (
    <div className="history">
      {groupTurns(records).map(renderTurn)}
      {hasLive && (
        <article className="turn turn-agent turn-live">
          <Gutter mark="O" />
          <div className="turn-body">
            <span className="turn-label">Orb</span>
            {tools.length > 0 && (
              <div className="tool-chips">
                {tools.map((tool) => (
                  <span className={toolChipClass(tool.state)} key={tool.callId}>
                    {tool.state === "running" && <span className="tool-chip-dot" />}
                    {tool.name} · {tool.state}
                  </span>
                ))}
              </div>
            )}
            {liveBlocks.map((block) =>
              block.blockType === "reasoning" ? (
                <details className="reasoning" key={block.blockId}>
                  <summary>reasoning</summary>
                  <p className="reasoning-body">{block.text}</p>
                </details>
              ) : (
                <AssistantMarkdown key={block.blockId}>{block.text}</AssistantMarkdown>
              ),
            )}
          </div>
        </article>
      )}
      {busy && <div className="busy-indicator">working…</div>}
    </div>
  );
}
