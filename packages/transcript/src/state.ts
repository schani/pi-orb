import type {
  ActiveSubagent,
  AgentSettingsEvent,
  HistoryRecord,
  OrbHistoryView,
  OrbView,
  RuntimeEvent,
  ServerFrame,
} from "@pi-orb/protocol";
import { mergeReplicatedHistory } from "./history-refresh.ts";
import { type CachedTranscript, snapshotFromHistory } from "./transcript-cache.ts";

/** Live channel state as the client's socket adapter reports it. */
export type LiveConnectionStatus = "connecting" | "open" | "retrying" | "closed";

export type ComposerMode = "message" | "shell" | "excluded_shell" | "command";

export interface ComposerImage {
  id: string;
  /** e.g. "image/png". */
  mediaType: string;
  /** Base64 payload without a data-URL prefix. */
  data: string;
}

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

export interface WelcomeInfo {
  runtimeInstanceId: string;
  sessionId: string;
  capabilities: string[];
  maxPromptBytes: number;
}

export interface TranscriptState {
  /** Insertion-ordered records keyed by id for cross-boundary dedupe. */
  records: ReadonlyMap<string, HistoryRecord>;
  sessionId: string | null;
  cacheReady: boolean;
  historyEpoch: number;
  /** Last complete record id applied; sent as `afterRecordId` in hello. */
  afterRecordId: string | null;
  /** Current conversation head used for `expectedHeadId`. */
  headId: string | null;
  historyLoaded: boolean;
  /** Already-described transport failure; the client owns its error taxonomy. */
  historyError: string | null;
  connection: LiveConnectionStatus;
  welcome: WelcomeInfo | null;
  activity: "idle" | "busy" | null;
  operationId: string | null;
  subagents: readonly ActiveSubagent[];
  liveBlocks: Map<string, LiveBlock>;
  tools: Map<string, ToolChip>;
  composerText: string;
  composerMode: ComposerMode;
  composerImages: ComposerImage[];
  settings: AgentSettingsEvent | null;
  synced: boolean;
  commandDraft: { text: string; mode: ComposerMode } | null;
  pendingRequest: {
    requestId: string;
    kind: "message" | "shell" | "abort" | "settings";
    submittedText?: string;
  } | null;
  requestError: { code: string; message: string } | null;
  serverError: { code: string; message: string } | null;
  notice: string | null;
}

export type TranscriptAction =
  | { type: "history_loaded"; view: OrbHistoryView }
  | { type: "history_restored"; snapshot: CachedTranscript }
  | { type: "history_refreshed"; view: OrbHistoryView; epoch: number }
  | { type: "history_failed"; message: string }
  | { type: "frame"; frame: ServerFrame }
  | { type: "connection_status"; status: LiveConnectionStatus }
  | { type: "composer_changed"; text: string; mode: ComposerMode }
  | { type: "image_added"; image: ComposerImage }
  | { type: "image_removed"; id: string }
  | { type: "notice"; message: string }
  | { type: "open_settings"; command: "model" | "thinking" }
  | { type: "request_sent"; requestId: string; kind: "message" | "shell" | "abort" | "settings" }
  | { type: "request_lost"; requestId: string }
  | { type: "message_enqueued"; requestId: string }
  | { type: "message_enqueue_failed"; requestId: string; message: string }
  | { type: "send_unavailable" };

/** `draft` is the client's restored composer content, when it keeps one. */
export function initialState(
  draft: { text: string; mode: ComposerMode; images: ComposerImage[] } | null = null,
): TranscriptState {
  return {
    records: new Map(),
    sessionId: null,
    cacheReady: false,
    historyEpoch: 0,
    afterRecordId: null,
    headId: null,
    historyLoaded: false,
    historyError: null,
    connection: "closed",
    welcome: null,
    activity: null,
    operationId: null,
    subagents: [],
    liveBlocks: new Map(),
    tools: new Map(),
    composerText: draft?.text ?? "",
    composerMode: draft?.mode ?? "message",
    composerImages: draft?.images ?? [],
    settings: null,
    synced: false,
    commandDraft: null,
    pendingRequest: null,
    requestError: null,
    serverError: null,
    notice: null,
  };
}

function lastKey(map: ReadonlyMap<string, HistoryRecord>): string | null {
  let last: string | null = null;
  for (const key of map.keys()) last = key;
  return last;
}

function applyRuntimeEvent(state: TranscriptState, event: RuntimeEvent): TranscriptState {
  switch (event.type) {
    case "agent_settings": {
      const adjusted =
        state.pendingRequest?.kind === "settings" &&
        state.settings !== null &&
        state.settings.settings.model.id !== event.settings.model.id &&
        state.settings.settings.thinkingLevel !== event.settings.thinkingLevel;
      return {
        ...state,
        settings: event,
        ...(adjusted
          ? { notice: `Thinking adjusted to ${event.settings.thinkingLevel} for this model.` }
          : {}),
      };
    }
    case "status": {
      const operationId =
        event.operationId ?? (event.activity === "idle" ? null : state.operationId);
      return {
        ...state,
        activity: event.activity,
        operationId,
        subagents:
          event.activity === "idle" || operationId !== state.operationId ? [] : state.subagents,
      };
    }
    case "subagents":
      return state.connection === "open" && state.operationId === event.operationId
        ? { ...state, subagents: event.children }
        : state;
    case "operation_started":
      return {
        ...state,
        activity: "busy",
        operationId: event.operationId,
        subagents: state.operationId === event.operationId ? state.subagents : [],
      };
    case "output_patch": {
      const existing = state.liveBlocks.get(event.blockId);
      const text =
        event.patch.type === "append"
          ? (existing?.text ?? "") + event.patch.text
          : event.patch.text;
      const liveBlocks = new Map(state.liveBlocks);
      liveBlocks.set(event.blockId, {
        blockId: event.blockId,
        blockType: event.blockType,
        text,
        revision: event.revision,
      });
      return { ...state, liveBlocks };
    }
    case "tool_state": {
      const tools = new Map(state.tools);
      tools.set(event.callId, {
        callId: event.callId,
        name: event.name,
        state: event.state,
        message: event.message ?? null,
      });
      return { ...state, tools };
    }
    case "turn_notification":
      // Notification display is a client side effect handled before reduction.
      return state;
    case "operation_finished":
      // Complete records for the operation have already arrived as
      // history.record frames, so transient live state can be dropped. The
      // runtime's own status frame confirms idleness; we anticipate it here
      // so the composer re-enables without waiting for it.
      return {
        ...state,
        liveBlocks: new Map(),
        tools: new Map(),
        operationId: null,
        activity: "idle",
        subagents: [],
        serverError:
          event.outcome === "failed"
            ? {
                code: "operation_failed",
                message: event.message ?? "the runtime operation failed",
              }
            : state.serverError,
      };
  }
}

function applyFrame(state: TranscriptState, frame: ServerFrame): TranscriptState {
  switch (frame.type) {
    case "server.welcome":
      return {
        ...state,
        subagents: [],
        ...(state.sessionId !== null && state.sessionId !== frame.sessionId
          ? {
              records: new Map(),
              afterRecordId: null,
              headId: null,
              cacheReady: false,
              historyEpoch: state.historyEpoch + 1,
            }
          : {}),
        sessionId: frame.sessionId,
        welcome: {
          runtimeInstanceId: frame.runtimeInstanceId,
          sessionId: frame.sessionId,
          capabilities: frame.capabilities,
          maxPromptBytes: frame.limits.maxPromptBytes,
        },
        serverError: null,
      };
    case "sync.started": {
      const next: TranscriptState = {
        ...state,
        historyEpoch: state.historyEpoch + 1,
        liveBlocks: new Map(),
        tools: new Map(),
        operationId: null,
        activity: null,
        subagents: [],
        settings: null,
        synced: false,
      };
      if (frame.mode === "full") {
        return {
          ...next,
          records: new Map(),
          afterRecordId: null,
          headId: null,
          cacheReady: false,
        };
      }
      return next;
    }
    case "history.record": {
      const records = new Map(state.records);
      records.set(frame.record.id, frame.record);
      const liveBlocks = new Map(state.liveBlocks);
      for (const id of frame.retiredBlockIds) liveBlocks.delete(id);
      return {
        ...state,
        records,
        liveBlocks,
        afterRecordId: frame.record.id,
        headId: frame.headId ?? frame.record.id,
      };
    }
    case "sync.completed":
      return {
        ...state,
        headId: frame.headId ?? lastKey(state.records),
        synced: true,
        cacheReady: true,
        historyLoaded: true,
        historyError: null,
      };
    case "runtime.event":
      return applyRuntimeEvent(state, frame.event);
    case "request.result": {
      if (state.pendingRequest === null || frame.requestId !== state.pendingRequest.requestId) {
        return state;
      }
      if (frame.result.type === "settings_applied") {
        const unchangedDraft =
          state.composerMode === "command" &&
          state.composerText === state.pendingRequest.submittedText;
        return {
          ...state,
          pendingRequest: null,
          requestError: null,
          ...(unchangedDraft
            ? {
                composerText: state.commandDraft?.text ?? "",
                composerMode: state.commandDraft?.mode ?? "message",
                commandDraft: null,
              }
            : {}),
        };
      }
      if (frame.result.type === "accepted") {
        const clearComposer = state.pendingRequest.kind !== "abort";
        return {
          ...state,
          pendingRequest: null,
          requestError: null,
          composerText: clearComposer ? "" : state.composerText,
          composerMode: clearComposer ? "message" : state.composerMode,
          composerImages: clearComposer ? [] : state.composerImages,
        };
      }
      return {
        ...state,
        pendingRequest: null,
        requestError: {
          code: frame.result.error.code,
          message: frame.result.error.message,
        },
      };
    }
    case "server.error":
      return {
        ...state,
        serverError: { code: frame.error.code, message: frame.error.message },
      };
  }
}

export function isLiveBusy(
  lifecycle: OrbView["state"] | undefined,
  state: Pick<TranscriptState, "connection" | "activity">,
): boolean {
  return lifecycle === "running" && state.connection === "open" && state.activity === "busy";
}

export function reducer(state: TranscriptState, action: TranscriptAction): TranscriptState {
  switch (action.type) {
    case "history_loaded":
      return reducer(state, {
        type: "history_restored",
        snapshot: snapshotFromHistory(action.view),
      });
    case "history_restored":
      return {
        ...state,
        ...action.snapshot,
        historyLoaded: true,
        historyError: null,
        cacheReady: true,
        historyEpoch: state.historyEpoch + 1,
      };
    case "history_refreshed": {
      // Replica repair has no live-block identities. An open socket owns the
      // ordered handoff, including patches still in flight when HTTP arrives.
      if (state.connection === "open" || action.epoch !== state.historyEpoch) return state;
      const sessionId = action.view.session?.id ?? state.sessionId;
      if (state.sessionId !== null && sessionId !== state.sessionId) {
        return reducer(state, { type: "history_loaded", view: action.view });
      }
      const merged = mergeReplicatedHistory(
        {
          records: [...state.records.values()],
          afterRecordId: state.afterRecordId,
          headId: state.headId,
        },
        action.view,
      );
      return {
        ...state,
        sessionId,
        cacheReady: true,
        historyLoaded: true,
        records: new Map(merged.records.map((record) => [record.id, record])),
        afterRecordId: merged.afterRecordId,
        headId: merged.headId,
        liveBlocks: new Map(),
        historyError: null,
      };
    }
    case "history_failed":
      return { ...state, historyError: action.message };
    case "frame":
      return applyFrame(state, action.frame);
    case "connection_status":
      return {
        ...state,
        connection: action.status,
        historyEpoch: state.historyEpoch + (action.status === "connecting" ? 1 : 0),
        ...(action.status === "open"
          ? {}
          : { activity: null, operationId: null, subagents: [], settings: null, synced: false }),
      };
    case "open_settings":
      return {
        ...state,
        commandDraft:
          state.composerMode === "command"
            ? state.commandDraft
            : { text: state.composerText, mode: state.composerMode },
        composerText: `${action.command} `,
        composerMode: "command",
        requestError: null,
        notice: null,
      };
    case "composer_changed":
      if (state.composerMode === "command" && action.mode === "message" && state.commandDraft)
        return {
          ...state,
          composerText: state.commandDraft.text,
          composerMode: state.commandDraft.mode,
          commandDraft: null,
          notice: null,
        };
      return { ...state, composerText: action.text, composerMode: action.mode, notice: null };
    case "image_added":
      return { ...state, composerImages: [...state.composerImages, action.image], notice: null };
    case "image_removed":
      return {
        ...state,
        composerImages: state.composerImages.filter((image) => image.id !== action.id),
      };
    case "notice":
      return { ...state, notice: action.message };
    case "request_sent":
      return {
        ...state,
        pendingRequest: {
          requestId: action.requestId,
          kind: action.kind,
          submittedText: state.composerText,
        },
        requestError: null,
        notice: null,
      };
    case "request_lost": {
      const pendingRequest =
        state.pendingRequest !== null && state.pendingRequest.requestId === action.requestId
          ? null
          : state.pendingRequest;
      return {
        ...state,
        pendingRequest,
        notice:
          state.pendingRequest?.kind === "settings"
            ? "The runtime restarted before acknowledging the change. Check the synchronized settings before trying again."
            : "The runtime restarted before acknowledging your request; it was not resent. " +
              "If your message appears in the history it was delivered — otherwise send it again.",
      };
    }
    case "message_enqueued":
      if (state.pendingRequest?.requestId !== action.requestId) return state;
      return {
        ...state,
        pendingRequest: null,
        requestError: null,
        composerText: "",
        composerMode: "message",
        composerImages: [],
        notice: null,
      };
    case "message_enqueue_failed":
      if (state.pendingRequest?.requestId !== action.requestId) return state;
      return {
        ...state,
        pendingRequest: null,
        requestError: { code: "enqueue_failed", message: action.message },
      };
    case "send_unavailable":
      return { ...state, notice: "Not connected — the request was not sent." };
  }
}
