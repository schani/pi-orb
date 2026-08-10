import type {
  CompactionRecord,
  ContentBlock,
  EventRecord,
  HistoryRecord,
  MessageRecord,
  OrbMessageView,
} from "@pi-orb/protocol";
import type { ReactNode } from "react";
import { ChatMarkdown } from "./ChatMarkdown.tsx";
import { PlainChatText } from "./ChatText.tsx";

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

function renderMessageBlocks(record: MessageRecord): ReactNode[] {
  const nodes: ReactNode[] = [];
  record.content.forEach((block, index) => {
    switch (block.type) {
      case "text":
        nodes.push(<ChatMarkdown key={index}>{block.text}</ChatMarkdown>);
        break;
      case "reasoning":
        nodes.push(
          <details className="reasoning" key={index}>
            <summary>reasoning</summary>
            <p className="reasoning-body">
              <PlainChatText>{block.text}</PlainChatText>
            </p>
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

function renderAgentPart(record: MessageRecord | EventRecord): ReactNode {
  if (record.type === "event") {
    return (
      <div className="record-custom" key={record.id}>
        <p className="msg-text">
          <PlainChatText>{blockText(record.content ?? [])}</PlainChatText>
        </p>
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
        <article className="turn turn-shell" key={turn.record.id}>
          <Gutter mark="Y" />
          <div className="turn-body">
            <span className="turn-label">Shell</span>
            <pre className="shell-output">
              {`$ ${shell.command}${shell.output === "" ? "" : `\n${shell.output}`}`}
            </pre>
            {statuses.length > 0 && <div className="shell-status">{statuses.join(" · ")}</div>}
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

function toolChipClass(state: ToolChip["state"]): string {
  return `tool-chip tool-chip-${state}`;
}

function inboxMessageIds(record: HistoryRecord): string[] {
  const native = record.overflow["native"];
  if (typeof native !== "object" || native === null || Array.isArray(native)) return [];
  if (native["customType"] !== "pi-orb.user-message") return [];
  const details = native["details"];
  if (typeof details !== "object" || details === null || Array.isArray(details)) return [];
  if (Array.isArray(details["messageIds"])) {
    return details["messageIds"].filter((id): id is string => typeof id === "string");
  }
  return typeof details["messageId"] === "string" ? [details["messageId"]] : [];
}

export function HistoryView({
  records,
  liveBlocks,
  tools,
  busy,
  queuedMessages = [],
}: HistoryViewProps) {
  const representedMessageIds = new Set(records.flatMap(inboxMessageIds));
  const pendingMessages = queuedMessages.filter(
    (message) => !representedMessageIds.has(message.id),
  );
  const shellBlocks = liveBlocks.filter((block) => block.blockType === "shell");
  const agentBlocks = liveBlocks.filter((block) => block.blockType !== "shell");
  const hasAgentLive = agentBlocks.length > 0 || tools.length > 0;
  return (
    <div className="history">
      {groupTurns(records).map(renderTurn)}
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
        const status = message.delivery === "steer" ? "steering" : message.status;
        return (
          <article className="turn turn-user turn-queued" key={message.id}>
            <Gutter mark="Y" />
            <div className="turn-body">
              <span className="turn-label">You · {status}</span>
              {renderMessageBlocks(record)}
            </div>
          </article>
        );
      })}
      {shellBlocks.map((block) => (
        <article className="turn turn-shell turn-live" key={block.blockId}>
          <Gutter mark="Y" />
          <div className="turn-body">
            <span className="turn-label">Shell</span>
            <pre className="shell-output">{block.text}</pre>
          </div>
        </article>
      ))}
      {hasAgentLive && (
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
            {agentBlocks.map((block) =>
              block.blockType === "reasoning" ? (
                <details className="reasoning" key={block.blockId}>
                  <summary>reasoning</summary>
                  <p className="reasoning-body">
                    <PlainChatText>{block.text}</PlainChatText>
                  </p>
                </details>
              ) : (
                <ChatMarkdown key={block.blockId}>{block.text}</ChatMarkdown>
              ),
            )}
          </div>
        </article>
      )}
      {busy && <div className="busy-indicator">working…</div>}
    </div>
  );
}
