import type {
  ActiveSubagent,
  AgentSettingsEvent,
  ContentBlock,
  HistoryRecord,
} from "@pi-orb/protocol";
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
import type { LiveBlock, ToolChip, TranscriptState } from "./state.ts";
import {
  type ActivityCategory,
  activityCalls,
  type CategoryCount,
  type CategoryProgress,
  callLabel,
  callStatus,
  categorize,
  categoryCount,
  categoryHeadline,
  categoryProgress,
  categoryState,
  type DiffStats,
  patchStats,
  resultText,
} from "./tool-activity.ts";

/**
 * JSON-only projection of the client model: the comparison surface of the
 * fixture corpus (docs/transcript-model.md). Maps become insertion-ordered
 * arrays and absent optional fields become `null`, so two implementations of
 * the model emit byte-identical documents for the same input.
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
}

export function serializeState(state: TranscriptState): SerializedState {
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
  | { kind: "block"; key: string; block: SerializedBlock }
  | { kind: "failure"; key: string; message: string };

type SerializedTurn =
  | { kind: "user"; id: string; blocks: SerializedBlock[] }
  | { kind: "agent"; key: string; parts: SerializedPart[] }
  | { kind: "shell"; id: string; shell: ShellExecution }
  | { kind: "compaction"; id: string; summary: string };

/** JSON-only projection of the turn/tool-run structure a client renders. */
export interface SerializedTurns {
  turns: SerializedTurn[];
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

function serializePart(part: AgentPart): SerializedPart {
  switch (part.kind) {
    case "tool_run":
      return {
        kind: "tool_run",
        key: part.key,
        categories: categorize(activityCalls(part.calls, [])).map(serializeCategory),
      };
    case "subagent_notice":
      return { kind: "subagent_notice", key: part.key, text: blockText(part.record.content ?? []) };
    case "event_text":
      return { kind: "event_text", key: part.key, text: part.text };
    case "tool_result":
      return { kind: "tool_result", key: part.key, block: serializeBlock(part.block) };
    case "block":
      return { kind: "block", key: part.key, block: serializeBlock(part.block) };
    case "failure":
      return { kind: "failure", key: part.key, message: part.message };
  }
}

function serializeTurn(turn: Turn): SerializedTurn {
  switch (turn.kind) {
    case "user":
      return { kind: "user", id: turn.record.id, blocks: turn.record.content.map(serializeBlock) };
    case "agent":
      return {
        kind: "agent",
        key: turn.key,
        parts: splitAgentRecords(turn.records).map(serializePart),
      };
    case "shell":
      return { kind: "shell", id: turn.record.id, shell: turn.shell };
    case "compaction":
      return { kind: "compaction", id: turn.record.id, summary: blockText(turn.record.summary) };
  }
}

export function serializeTurns(records: readonly HistoryRecord[]): SerializedTurns {
  return {
    turns: groupTurns(records).map(serializeTurn),
    representedMessageIds: [...representedInboxMessageIds(records)],
    persistedToolCallIds: [...persistedToolCallIds(records)],
  };
}
