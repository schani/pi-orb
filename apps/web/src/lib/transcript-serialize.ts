import type { ActiveSubagent, AgentSettingsEvent, HistoryRecord } from "@pi-orb/protocol";
import type { LiveBlock, ToolChip } from "../components/HistoryView.tsx";
import type { OrbPageState } from "../pages/OrbPage.tsx";
import type { ApiError } from "./api.ts";

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
  historyError: ApiError | null;
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

export function serializeState(state: OrbPageState): SerializedState {
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
