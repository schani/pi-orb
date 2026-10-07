import {
  type DisplayBlock,
  type DisplayRecord,
  type OrbMessageView,
  ToolResultContext,
} from "@pi-orb/protocol";
import {
  createContext,
  createElement,
  memo,
  type ReactNode,
  type RefObject,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { HeadlineLimiter } from "../lib/activity-headline.ts";
import { representedInboxMessageIds } from "../lib/queued-messages.ts";
import { HeadlineSlots } from "../lib/use-activity-headline.tsx";
import { useHistoryTail } from "../lib/use-history-tail.ts";
import { ActivityRailRow } from "./ActivityRailRow.tsx";
import { BitRegister } from "./BitRegister.tsx";
import { ChatMarkdown as UnmemoizedChatMarkdown } from "./ChatMarkdown.tsx";
import { PlainChatText } from "./ChatText.tsx";
import { CommittedImage, imageIndex } from "./CommittedImage.tsx";
import { CommittedBody, type DetailContext, RunningBody } from "./DetailBody.tsx";
import { ResponseMarkdown as UnmemoizedResponseMarkdown } from "./ResponseMarkdown.tsx";
import { isSubagentNotice, SubagentNotice } from "./SubagentNotice.tsx";
import {
  type PersistedToolCall,
  ToolActivity,
  type ToolCallBlock,
  type ToolResultBlock,
} from "./ToolActivity.tsx";

const ChatMarkdown = memo(UnmemoizedChatMarkdown);
const ResponseMarkdown = memo(UnmemoizedResponseMarkdown);

type MessageRecord = Extract<DisplayRecord, { type: "message" }>;
type EventRecord = Extract<DisplayRecord, { type: "event" }>;
type CompactionRecord = Extract<DisplayRecord, { type: "compaction" }>;

/** Streaming output block accumulated from `output_patch` events. */
export interface LiveBlock {
  blockId: string;
  blockType: "text" | "reasoning";
  text: string;
  headline?: string;
  revision: number;
}

/** Latest per-call tool state from `tool_state` events. */
export interface ToolChip {
  callId: string;
  name: string;
  code?: string;
  state: "running" | "completed" | "failed";
  message: string | null;
}

interface HistoryViewProps {
  viewportRef?: RefObject<HTMLDivElement | null>;
  onCompensatedRef?: RefObject<(() => void) | null>;
  records: readonly DisplayRecord[];
  detailContext: DetailContext;
  detailAliases?: ReadonlyMap<string, string>;
  liveBlocks: readonly LiveBlock[];
  tools: readonly ToolChip[];
  busy: boolean;
  queuedMessages?: readonly OrbMessageView[];
}

const DetailContextValue = createContext<DetailContext | null>(null);
const OpenDetailValue = createContext<{
  aliases: ReadonlyMap<string, string>;
  opened: Set<string>;
} | null>(null);
function useDetailContext(): DetailContext {
  const context = useContext(DetailContextValue);
  // All detail children render inside HistoryView's provider.
  return context as DetailContext;
}

function VisibleImage({ recordId, detailKey }: { recordId: string; detailKey: string }) {
  const context = useDetailContext();
  return (
    <CommittedBody
      context={context}
      recordId={recordId}
      detailKey={detailKey}
      render={(body) =>
        body.type === "image" ? (
          body.url !== undefined ? (
            <img className="msg-image" src={body.url} alt="attachment" />
          ) : body.imageRef !== undefined && imageIndex(detailKey, body.imageRef) !== null ? (
            <CommittedImage
              context={context}
              recordId={recordId}
              detailKey={detailKey}
              index={imageIndex(detailKey, body.imageRef) ?? 0}
            />
          ) : (
            <span>[image]</span>
          )
        ) : null
      }
    />
  );
}

function LazyLegacyBody({
  recordId,
  detailKey,
  live = false,
}: {
  recordId: string;
  detailKey: string;
  live?: boolean;
}) {
  const context = useDetailContext();
  return live ? (
    <RunningBody context={context} blockId={detailKey} />
  ) : (
    <CommittedBody context={context} recordId={recordId} detailKey={detailKey} />
  );
}

function LazyDisclosure({
  className,
  summary,
  recordId,
  detailKey,
  defaultOpen = false,
}: {
  className: string;
  summary: ReactNode;
  recordId: string;
  detailKey: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details
      className={className}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{summary}</summary>
      {open && <LazyLegacyBody recordId={recordId} detailKey={detailKey} />}
    </details>
  );
}

function blockText(blocks: readonly DisplayBlock[]): string {
  return blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function renderToolCall(block: DisplayBlock & { type: "tool_call" }, recordId: string): ReactNode {
  return (
    <LazyDisclosure
      className="tool-details tool-call"
      key={`call-${block.callId}`}
      summary={`→ ${block.name}`}
      recordId={recordId}
      detailKey={block.detailKey}
    />
  );
}

function renderToolResult(
  block: DisplayBlock & { type: "tool_result" },
  key: string | number,
  recordId: string,
): ReactNode {
  const images = block.hasImages;
  return (
    <LazyDisclosure
      className="tool-details"
      key={key}
      defaultOpen={images}
      summary={
        <>
          {block.isError === true ? "tool error" : "tool output"}
          {images && <> · {block.callId}</>}
        </>
      }
      recordId={recordId}
      detailKey={block.detailKey}
    />
  );
}

function renderImageBlock(
  block: DisplayBlock & { type: "image" },
  key: number,
  recordId: string,
): ReactNode {
  return <VisibleImage key={key} recordId={recordId} detailKey={block.detailKey} />;
}

function ReasoningRail({
  detailKey,
  recordId,
  live,
  headline,
}: {
  detailKey: string;
  recordId: string;
  live: boolean;
  headline: string | undefined;
}) {
  const openState = useContext(OpenDetailValue);
  const identity = openState?.aliases.get(detailKey) ?? detailKey;
  const [open, setOpen] = useState(() => openState?.opened.has(identity) ?? false);
  const onToggle = (value: boolean) => {
    setOpen(value);
    if (value) openState?.opened.add(identity);
    else openState?.opened.delete(identity);
  };
  return (
    <ActivityRailRow
      className="reasoning"
      label="thinking"
      headline={headline || undefined}
      state={live ? "running" : "neutral"}
      defaultOpen={open}
      onToggle={onToggle}
    >
      {open && (
        <div className="reasoning-body">
          <LazyLegacyBody recordId={recordId} detailKey={detailKey} live={live} />
        </div>
      )}
    </ActivityRailRow>
  );
}
function renderReasoningRail(
  detailKey: string,
  key: string | number,
  recordId: string,
  live = false,
  headline?: string,
): ReactNode {
  return (
    <ReasoningRail
      key={key}
      detailKey={detailKey}
      recordId={recordId}
      live={live}
      headline={headline}
    />
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
        nodes.push(renderReasoningRail(block.detailKey, index, record.id, false, block.headline));
        break;
      case "tool_call":
        nodes.push(renderToolCall(block, record.id));
        break;
      case "image":
        nodes.push(renderImageBlock(block, index, record.id));
        break;
      case "tool_result":
        nodes.push(renderToolResult(block, index, record.id));
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
 * assistant/tool/event records share one prefix), or a
 * full-width compaction divider.
 */
type Turn =
  | { kind: "user"; record: MessageRecord }
  | { kind: "agent"; key: string; records: Array<MessageRecord | EventRecord> }
  | { kind: "alert"; record: EventRecord; message: string }
  | { kind: "compaction"; record: CompactionRecord };

/** Per docs/pi-adapter.md, only a custom message the harness marked displayed is shown. */
function isDisplayedCustomMessage(record: EventRecord): boolean {
  return record.eventType === "agent.settings_fallback" || record.custom?.display === true;
}

function assistantFailure(record: MessageRecord): string | null {
  if (record.role !== "assistant" || record.finishReason !== "error") return null;
  const failure = record.failure;
  if (failure === undefined) return "Model response failed.";
  if (!failure.providerTransportFailure) return failure.message;
  const provider = record.model?.provider === "openai-codex" ? "OpenAI" : "the model provider";
  return `The agent’s connection to ${provider} was interrupted. ${failure.message}`;
}

export function assistantResponseMarkdown(record: MessageRecord): string | null {
  if (record.role !== "assistant") return null;
  const parts = record.content
    .filter((block): block is DisplayBlock & { type: "text" } => block.type === "text")
    .map((block) => block.text)
    .filter((text) => text.trim() !== "");
  return parts.length === 0 ? null : parts.join("\n\n");
}

interface ToolPairing {
  results: ReadonlyMap<ToolCallBlock, { block: ToolResultBlock; recordId: string }>;
  pairedResults: ReadonlySet<ToolResultBlock>;
}

function pairToolResults(records: readonly DisplayRecord[]): ToolPairing {
  const context = new ToolResultContext<ToolCallBlock>();
  const results = new Map<ToolCallBlock, { block: ToolResultBlock; recordId: string }>();
  const pairedResults = new Set<ToolResultBlock>();
  for (const record of records) {
    const matches = context.visit(
      record,
      (source, index) => (source as MessageRecord).content[index] as ToolCallBlock,
    );
    if (record.type !== "message" || record.role === "user") continue;
    for (const [index, block] of record.content.entries()) {
      if (block.type !== "tool_result") continue;
      const call = matches.get(index);
      if (call === undefined) continue;
      results.set(call, { block, recordId: record.id });
      pairedResults.add(block);
    }
  }
  return { results, pairedResults };
}

function renderAgentRecords(
  records: readonly (MessageRecord | EventRecord)[],
  pairing: ToolPairing,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let runIndex = 0;
  let currentCalls: PersistedToolCall[] = [];

  const flushTools = () => {
    if (currentCalls.length === 0) return;
    nodes.push(<PersistedActivity calls={currentCalls} key={`tools-${runIndex}`} />);
    runIndex += 1;
    currentCalls = [];
  };

  for (const record of records) {
    if (record.type === "event") {
      flushTools();
      if (isSubagentNotice(record)) {
        nodes.push(<OwnedSubagent key={record.id} record={record} />);
        continue;
      }
      nodes.push(
        <div className="record-custom" key={record.id}>
          <p className="msg-text">
            <PlainChatText>{blockText(record.content ?? [])}</PlainChatText>
          </p>
        </div>,
      );
      continue;
    }

    const copySource = assistantResponseMarkdown(record);
    const firstTextIndex = record.content.findIndex(
      (block) => block.type === "text" && block.text.trim() !== "",
    );
    for (const [index, block] of record.content.entries()) {
      if (block.type === "tool_call") {
        const match = pairing.results.get(block);
        currentCalls.push({
          call: block,
          callRecordId: record.id,
          ...(match === undefined ? {} : { result: match.block, resultRecordId: match.recordId }),
        });
        continue;
      }
      if (block.type === "tool_result") {
        if (!pairing.pairedResults.has(block)) {
          flushTools();
          nodes.push(renderToolResult(block, `${record.id}-${index}`, record.id));
        }
        continue;
      }

      // Visible prose/reasoning/media is a boundary between maximal tool runs.
      flushTools();
      if (block.type === "text" && index === firstTextIndex && copySource !== null) {
        nodes.push(
          <ResponseMarkdown
            key={`${record.id}-${index}`}
            markdown={block.text}
            copySource={copySource}
          />,
        );
        continue;
      }
      const singleBlockRecord: MessageRecord = { ...record, content: [block] };
      const rendered = renderMessageBlocks(singleBlockRecord);
      // Reasoning must be a direct child of the turn body so its rail row can
      // collapse the body's prose gap against adjacent activity rows.
      if (block.type === "reasoning") nodes.push(...rendered);
      else nodes.push(<div key={`${record.id}-${index}`}>{rendered}</div>);
    }
    const failure = assistantFailure(record);
    if (failure !== null) {
      flushTools();
      nodes.push(
        <p className="error-text" role="alert" key={`${record.id}-error`}>
          <PlainChatText>{failure}</PlainChatText>
        </p>,
      );
    }
  }
  flushTools();
  return nodes;
}

const MessageBlocks = memo(function MessageBlocks({ record }: { record: MessageRecord }) {
  return renderMessageBlocks(record);
});

const AgentRecords = memo(
  function AgentRecords({
    records,
    pairing,
  }: {
    records: readonly (MessageRecord | EventRecord)[];
    pairing: ToolPairing;
  }) {
    return renderAgentRecords(records, pairing);
  },
  (previous, next) => {
    if (
      previous.records.length !== next.records.length ||
      previous.records.some((record, index) => record !== next.records[index])
    )
      return false;
    if (previous.pairing === next.pairing) return true;
    return next.records.every(
      (record) =>
        record.type !== "message" ||
        record.content.every((block) => {
          if (block.type === "tool_call") {
            const before = previous.pairing.results.get(block);
            const after = next.pairing.results.get(block);
            return before?.block === after?.block && before?.recordId === after?.recordId;
          }
          return (
            block.type !== "tool_result" ||
            previous.pairing.pairedResults.has(block) === next.pairing.pairedResults.has(block)
          );
        }),
    );
  },
);

function turnKey(turn: Turn): string {
  return turn.kind === "agent" ? turn.key : turn.record.id;
}

function groupTurns(records: readonly DisplayRecord[]): Turn[] {
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
        if (record.alert !== undefined) {
          turns.push({ kind: "alert", record, message: record.alert.message });
        } else if (isDisplayedCustomMessage(record)) {
          appendAgentPart(record);
        }
        break;
    }
  }
  return turns;
}

function OwnedSubagent({ record }: { record: EventRecord }) {
  return <SubagentNotice record={record} detailContext={useDetailContext()} />;
}

function PersistedActivity({ calls }: { calls: readonly PersistedToolCall[] }) {
  return <ToolActivity persisted={calls} detailContext={useDetailContext()} />;
}
function LiveActivity({ calls }: { calls: readonly ToolChip[] }) {
  return <ToolActivity live={calls} detailContext={useDetailContext()} />;
}

interface LiveAgentContent {
  blocks: readonly LiveBlock[];
  tools: readonly ToolChip[];
}

function renderLiveAgentContent(live: LiveAgentContent, busy: boolean): ReactNode[] {
  const nodes: ReactNode[] = [];
  if (live.tools.length > 0) nodes.push(<LiveActivity calls={live.tools} key="live-tools" />);
  for (const block of live.blocks) {
    nodes.push(
      block.blockType === "reasoning" ? (
        renderReasoningRail(block.blockId, block.blockId, "live", true, block.headline)
      ) : block.text.trim() === "" ? null : (
        <ResponseMarkdown key={block.blockId} markdown={block.text} copySource={block.text} />
      ),
    );
  }
  // Only authoritative busy state can keep the activity marker alive.
  if (busy) nodes.push(<BitRegister key="busy" />);
  return nodes;
}

function renderTurn(
  turn: Turn,
  pairing: ToolPairing,
  live?: LiveAgentContent,
  busy = false,
): ReactNode {
  switch (turn.kind) {
    case "user":
      return (
        <article className="rec rec-you" key={turn.record.id} data-history-row={turn.record.id}>
          <span className="visually-hidden">You:</span>
          <div className="rec-bd">
            <MessageBlocks record={turn.record} />
          </div>
        </article>
      );
    case "agent":
      return (
        <article className="rec rec-orb" key={turn.key} data-history-row={turn.key}>
          <span className="visually-hidden">Orb:</span>
          <div className="rec-bd">
            <AgentRecords records={turn.records} pairing={pairing} />
            {live !== undefined && renderLiveAgentContent(live, busy)}
          </div>
        </article>
      );
    case "alert":
      return (
        <article
          className="rec rec-alert"
          key={turn.record.id}
          data-history-row={turn.record.id}
          aria-label="Orb alert"
        >
          <div className="rec-bd">
            <div className="alert-band">{turn.message}</div>
          </div>
        </article>
      );
    case "compaction":
      return (
        <div className="record-compaction" key={turn.record.id} data-history-row={turn.record.id}>
          <span className="compaction-line">context compacted</span>
          <LazyDisclosure
            className="record-compaction-details"
            summary="summary"
            recordId={turn.record.id}
            detailKey={turn.record.detailKey}
          />
        </div>
      );
  }
}

function persistedToolCallIds(records: readonly DisplayRecord[]): Set<string> {
  const ids = new Set<string>();
  for (const record of records) {
    if (record.type !== "message") continue;
    for (const block of record.content) {
      if (block.type === "tool_call") ids.add(block.callId);
    }
  }
  return ids;
}

const EMPTY_ALIASES: ReadonlyMap<string, string> = new Map();

export const HistoryView = memo(function HistoryView({
  records,
  liveBlocks,
  tools,
  busy,
  queuedMessages = [],
  detailContext,
  detailAliases = EMPTY_ALIASES,
  viewportRef,
  onCompensatedRef,
}: HistoryViewProps) {
  const [headlineSlots] = useState(() => new HeadlineLimiter());
  const [openedDetails] = useState(() => new Set<string>());
  const representedMessageIds = useMemo(() => representedInboxMessageIds(records), [records]);
  const pendingMessages = queuedMessages.filter(
    (message) => !representedMessageIds.has(message.id),
  );
  const { turns, pairing, committedToolCallIds, derivationMs } = useMemo(() => {
    const start = performance.now();
    return {
      turns: groupTurns(records),
      pairing: pairToolResults(records),
      committedToolCallIds: persistedToolCallIds(records),
      derivationMs: performance.now() - start,
    };
  }, [records]);
  const keys = useMemo(() => turns.map(turnKey), [turns]);
  const historyRef = useRef<HTMLDivElement>(null);
  const firstMounted = useHistoryTail(keys, historyRef, viewportRef, onCompensatedRef);
  const openDetailValue = useMemo(
    () => ({ aliases: detailAliases, opened: openedDetails }),
    [detailAliases, openedDetails],
  );
  const measuredRecords = useRef<readonly DisplayRecord[] | null>(null);
  useLayoutEffect(() => {
    const derived = measuredRecords.current !== records;
    measuredRecords.current = records;
    performance.clearMarks("pi-orb:history-mount");
    performance.mark("pi-orb:history-mount", {
      detail: {
        records: records.length,
        totalRows: turns.length,
        mountedRows: turns.length - firstMounted,
        derivationRecords: derived ? records.length : 0,
        derivationMs: derived ? derivationMs : 0,
      },
    });
  }, [records, turns.length, firstMounted, derivationMs]);
  const finalTurn = turns[turns.length - 1];
  const uncommittedTools = tools.filter((tool) => !committedToolCallIds.has(tool.callId));
  const hasAgentLive = liveBlocks.length > 0 || uncommittedTools.length > 0;
  const mergeLiveIntoFinalTurn =
    hasAgentLive && finalTurn?.kind === "agent" && pendingMessages.length === 0;
  const mergedTurnIndex = mergeLiveIntoFinalTurn ? turns.length - 1 : -1;
  const liveAgentContent: LiveAgentContent = {
    blocks: liveBlocks,
    tools: uncommittedTools,
  };
  return createElement(
    HeadlineSlots.Provider,
    { value: headlineSlots },
    <DetailContextValue.Provider value={detailContext}>
      <OpenDetailValue.Provider value={openDetailValue}>
        <div className="history" ref={historyRef}>
          {turns
            .slice(firstMounted)
            .map((turn, index) =>
              index + firstMounted === mergedTurnIndex
                ? renderTurn(turn, pairing, liveAgentContent, busy)
                : renderTurn(turn, pairing),
            )}
          {pendingMessages.map((message) => {
            const system = message.system !== undefined;
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
              <article className={`rec ${system ? "rec-orb" : "rec-you"} rec-q`} key={message.id}>
                <span className="visually-hidden">{system ? "System:" : "You:"}</span>
                <div className="rec-bd">
                  <span className="rec-status">{status}</span>
                  {message.content.map((block, index) =>
                    block.type === "text" ? (
                      <ChatMarkdown key={index}>{block.text}</ChatMarkdown>
                    ) : block.type === "image" && block.data !== undefined ? (
                      <img
                        key={index}
                        className="msg-image"
                        src={`data:${block.mediaType ?? "image/png"};base64,${block.data}`}
                        alt="attachment"
                      />
                    ) : null,
                  )}
                  {failed && message.error !== undefined && (
                    <div className="error-text">{message.error}</div>
                  )}
                </div>
              </article>
            );
          })}
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
      </OpenDetailValue.Provider>
    </DetailContextValue.Provider>,
  );
});
