import type {
  ActiveSubagent,
  AgentSettingsEvent,
  ContentBlock,
  HistoryRecord,
  OrbMessageView,
} from "@pi-orb/protocol";
import { blockText, persistedToolCallIds, type ShellExecution } from "./grouping.ts";
import {
  type LiveTail,
  type PresentedPart,
  type PresentedRow,
  presentTranscript,
} from "./presentation.ts";
import {
  hasDeliveredMessageAwaitingHistory,
  messagesAwaitingHistory,
  representedInboxMessageIds,
  withQueuedMessage,
} from "./queued-messages.ts";
import { isLiveBusy, type LiveBlock, type ToolChip, type TranscriptState } from "./state.ts";
import {
  type ActivityCategory,
  type CategoryCount,
  type CategoryProgress,
  callLabel,
  callStatus,
  categoryCount,
  categoryHeadline,
  categoryProgress,
  categoryState,
  type DiffStats,
  patchStats,
  resultText,
} from "./tool-activity.ts";
import type { TranscriptCache } from "./transcript-cache.ts";

/**
 * JSON-only fixture projection of represented model behavior. Maps become
 * insertion-ordered arrays, and only explicitly projected optionals become
 * `null`; included protocol objects retain their shapes. Fixtures compare JSON
 * structure, not serialized bytes or complete rendering fidelity.
 */
export interface SerializedState {
  records: HistoryRecord[];
  sessionId: string | null;
  cacheReady: boolean;
  historyEpoch: number;
  afterRecordId: string | null;
  headId: string | null;
  historyLoaded: boolean;
  historyError: string | null;
  connection: string;
  welcome: {
    runtimeInstanceId: string;
    sessionId: string;
    capabilities: string[];
    maxPromptBytes: number;
  } | null;
  activity: "idle" | "busy" | null;
  operationId: string | null;
  subagents: ActiveSubagent[];
  liveBlocks: LiveBlock[];
  tools: ToolChip[];
  composerText: string;
  composerMode: string;
  composerImages: { id: string; mediaType: string; data: string }[];
  settings: AgentSettingsEvent | null;
  synced: boolean;
  commandDraft: { text: string; mode: string } | null;
  pendingRequest: { requestId: string; kind: string; submittedText: string | null } | null;
  requestError: { code: string; message: string } | null;
  serverError: { code: string; message: string } | null;
  notice: string | null;
  /** Presentation structure for this state, projected for fixture comparison. */
  presentation: SerializedRow[];
}

export function serializeState(
  state: TranscriptState,
  queuedMessages: readonly OrbMessageView[] = [],
): SerializedState {
  return {
    records: [...state.records.values()],
    sessionId: state.sessionId,
    cacheReady: state.cacheReady,
    historyEpoch: state.historyEpoch,
    afterRecordId: state.afterRecordId,
    headId: state.headId,
    historyLoaded: state.historyLoaded,
    historyError: state.historyError,
    connection: state.connection,
    welcome:
      state.welcome === null
        ? null
        : {
            runtimeInstanceId: state.welcome.runtimeInstanceId,
            sessionId: state.welcome.sessionId,
            capabilities: [...state.welcome.capabilities],
            maxPromptBytes: state.welcome.maxPromptBytes,
          },
    activity: state.activity,
    operationId: state.operationId,
    subagents: [...state.subagents],
    liveBlocks: [...state.liveBlocks.values()],
    tools: [...state.tools.values()],
    composerText: state.composerText,
    composerMode: state.composerMode,
    composerImages: [...state.composerImages],
    settings: state.settings,
    synced: state.synced,
    commandDraft: state.commandDraft,
    pendingRequest:
      state.pendingRequest === null
        ? null
        : {
            requestId: state.pendingRequest.requestId,
            kind: state.pendingRequest.kind,
            submittedText: state.pendingRequest.submittedText ?? null,
          },
    requestError: state.requestError,
    serverError: state.serverError,
    notice: state.notice,
    presentation: serializePresentation(
      presentTranscript({
        records: [...state.records.values()],
        liveBlocks: [...state.liveBlocks.values()],
        tools: [...state.tools.values()],
        queuedMessages,
        busy: isLiveBusy("running", state),
      }),
    ),
  };
}

type SerializedBlock =
  | { type: "text" | "reasoning"; text: string }
  | { type: "image"; mediaType: string | null }
  | { type: "other"; contentType: string }
  | { type: "tool_call"; callId: string; name: string }
  | { type: "tool_result"; callId: string; isError: boolean; text: string };

function serializeBlock(block: ContentBlock): SerializedBlock {
  switch (block.type) {
    case "text":
    case "reasoning":
      return { type: block.type, text: block.text };
    case "image":
      return { type: "image", mediaType: block.mediaType ?? null };
    case "other":
      return { type: "other", contentType: block.contentType };
    case "tool_call":
      return { type: "tool_call", callId: block.callId, name: block.name };
    case "tool_result":
      return {
        type: "tool_result",
        callId: block.callId,
        isError: block.isError === true,
        text: resultText(block),
      };
  }
}

interface SerializedCall {
  callId: string;
  name: string;
  state: string;
  label: string;
  status: string;
  output: string;
  stats: DiffStats | null;
}

interface SerializedCategory {
  key: string;
  kind: string;
  label: string;
  headline: string | null;
  state: string;
  count: CategoryCount;
  progress: CategoryProgress;
  calls: SerializedCall[];
}

type SerializedPart =
  | { kind: "tool_run"; key: string; categories: SerializedCategory[] }
  | { kind: "subagent_notice" | "event_text"; key: string; text: string }
  | { kind: "tool_result"; key: string; block: SerializedBlock }
  | { kind: "block"; key: string; block: SerializedBlock; copySource: string | null }
  | { kind: "failure"; key: string; message: string };

interface SerializedLive {
  categories: SerializedCategory[];
  blocks: { blockId: string; blockType: string; text: string; revision: number }[];
  busy: boolean;
}

type SerializedRow =
  | { kind: "user"; key: string; blocks: SerializedBlock[] }
  | { kind: "agent"; key: string; parts: SerializedPart[]; live: SerializedLive | null }
  | { kind: "shell"; key: string; shell: ShellExecution }
  | { kind: "compaction"; key: string; summary: string }
  | { kind: "queued"; key: string; status: string; error: string | null; blocks: SerializedBlock[] }
  | { kind: "live_shell"; key: string; text: string }
  | { kind: "busy"; key: string };

/** Fixture projection of `presentTranscript` row structure and derived behavior. */
export interface SerializedTurns {
  turns: SerializedRow[];
  representedMessageIds: string[];
  persistedToolCallIds: string[];
}

function serializeCategory(category: ActivityCategory): SerializedCategory {
  return {
    key: category.key,
    kind: category.kind,
    label: category.label,
    headline: categoryHeadline(category),
    state: categoryState(category),
    count: categoryCount(category),
    progress: categoryProgress(category),
    calls: category.calls.map((call) => ({
      callId: call.callId,
      name: call.name,
      state: call.state,
      label: callLabel(call, category.kind),
      status: callStatus(call),
      output: resultText(call.result),
      stats: patchStats(call.result?.patch ?? null),
    })),
  };
}

function serializePart(part: PresentedPart): SerializedPart {
  switch (part.kind) {
    case "tool_run":
      return {
        kind: "tool_run",
        key: part.key,
        categories: part.categories.map(serializeCategory),
      };
    case "subagent_notice":
      return { kind: "subagent_notice", key: part.key, text: blockText(part.record.content ?? []) };
    case "event_text":
      return { kind: "event_text", key: part.key, text: part.text };
    case "tool_result":
      return { kind: "tool_result", key: part.key, block: serializeBlock(part.block) };
    case "block":
      return {
        kind: "block",
        key: part.key,
        block: serializeBlock(part.block),
        copySource: part.copySource,
      };
    case "failure":
      return { kind: "failure", key: part.key, message: part.message };
  }
}

function serializeLive(live: LiveTail): SerializedLive {
  return {
    categories: live.categories.map(serializeCategory),
    blocks: live.blocks.map((block) => ({ ...block })),
    busy: live.busy,
  };
}

function serializeRow(row: PresentedRow): SerializedRow {
  switch (row.kind) {
    case "user":
      return { kind: "user", key: row.key, blocks: row.record.content.map(serializeBlock) };
    case "agent":
      return {
        kind: "agent",
        key: row.key,
        parts: row.parts.map(serializePart),
        live: row.live === null ? null : serializeLive(row.live),
      };
    case "queued":
      return {
        kind: "queued",
        key: row.key,
        status: row.status,
        error: row.error,
        blocks: row.record.content.map(serializeBlock),
      };
    case "shell":
    case "compaction":
    case "live_shell":
    case "busy":
      return row;
  }
}

export function serializePresentation(rows: readonly PresentedRow[]): SerializedRow[] {
  return rows.map(serializeRow);
}

export function serializeTurns(records: readonly HistoryRecord[]): SerializedTurns {
  return {
    turns: serializePresentation(presentTranscript({ records })),
    representedMessageIds: [...representedInboxMessageIds(records)],
    persistedToolCallIds: [...persistedToolCallIds(records)],
  };
}

export interface SerializedInboxMessage {
  id: string;
  status: string;
  delivery: string | null;
}

/** JSON-only projection of inbox reconciliation (`fixtures/inbox/`). */
export interface SerializedInbox {
  represented: string[];
  awaitingHistory: string[];
  deliveredAwaitingHistory: boolean;
  afterAppend: SerializedInboxMessage[];
}

function serializeInboxMessage(message: OrbMessageView): SerializedInboxMessage {
  return { id: message.id, status: message.status, delivery: message.delivery ?? null };
}

export function serializeInbox(
  items: readonly OrbMessageView[],
  records: readonly HistoryRecord[],
  append: readonly OrbMessageView[] = [],
): SerializedInbox {
  return {
    represented: [...representedInboxMessageIds(records)],
    awaitingHistory: messagesAwaitingHistory(items, records).map((message) => message.id),
    deliveredAwaitingHistory: hasDeliveredMessageAwaitingHistory(items, records),
    afterAppend: append
      .reduce<readonly OrbMessageView[]>(withQueuedMessage, items)
      .map(serializeInboxMessage),
  };
}

export interface SerializedCacheEntry {
  orbId: string;
  projectId: string;
  sessionId: string | null;
  recordIds: string[];
  afterRecordId: string | null;
  headId: string | null;
}

/** JSON-only projection of the transcript cache (`fixtures/cache/`). */
export interface SerializedCache {
  entries: SerializedCacheEntry[];
  owners: number;
  invalidationEpoch: number;
}

export function serializeCache(cache: TranscriptCache): SerializedCache {
  return {
    entries: cache.contents.map((entry) => ({
      orbId: entry.orbId,
      projectId: entry.projectId,
      sessionId: entry.snapshot.sessionId,
      recordIds: [...entry.snapshot.records.keys()],
      afterRecordId: entry.snapshot.afterRecordId,
      headId: entry.snapshot.headId,
    })),
    owners: cache.stats.owners,
    invalidationEpoch: cache.invalidationEpoch,
  };
}
