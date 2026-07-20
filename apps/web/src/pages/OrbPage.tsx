import { useEffect, useReducer, useRef, useState } from "react";
import {
  CAPABILITY_ABORT,
  type HistoryRecord,
  type OrbHistoryView,
  type OrbView,
  type RuntimeEvent,
  type ServerFrame,
} from "@pi-orb/protocol";
import {
  describeApiError,
  getOrb,
  getOrbHistory,
  startOrb,
  stopOrb,
  type ApiError,
} from "../lib/api.ts";
import { openLiveConnection, type LiveConnection, type LiveConnectionStatus } from "../lib/live.ts";
import { HistoryView, type LiveBlock, type ToolChip } from "../components/HistoryView.tsx";
import { Composer } from "../components/Composer.tsx";

const POLL_INTERVAL_MS = 2000;

interface WelcomeInfo {
  runtimeInstanceId: string;
  sessionId: string;
  capabilities: string[];
}

interface OrbPageState {
  /** Insertion-ordered records keyed by id for cross-boundary dedupe. */
  records: Map<string, HistoryRecord>;
  /** Last complete record id applied; sent as `afterRecordId` in hello. */
  afterRecordId: string | null;
  /** Current conversation head used for `expectedHeadId`. */
  headId: string | null;
  historyLoaded: boolean;
  historyError: ApiError | null;
  connection: LiveConnectionStatus;
  welcome: WelcomeInfo | null;
  activity: "idle" | "busy" | null;
  operationId: string | null;
  liveBlocks: Map<string, LiveBlock>;
  tools: Map<string, ToolChip>;
  composerText: string;
  pendingRequest: { requestId: string; kind: "message" | "abort" } | null;
  requestError: { code: string; message: string } | null;
  serverError: { code: string; message: string } | null;
  notice: string | null;
}

type OrbPageAction =
  | { type: "history_loaded"; view: OrbHistoryView }
  | { type: "history_failed"; error: ApiError }
  | { type: "frame"; frame: ServerFrame }
  | { type: "connection_status"; status: LiveConnectionStatus }
  | { type: "composer_changed"; text: string }
  | { type: "request_sent"; requestId: string; kind: "message" | "abort" }
  | { type: "request_lost"; requestId: string }
  | { type: "send_unavailable" };

function initialState(): OrbPageState {
  return {
    records: new Map(),
    afterRecordId: null,
    headId: null,
    historyLoaded: false,
    historyError: null,
    connection: "closed",
    welcome: null,
    activity: null,
    operationId: null,
    liveBlocks: new Map(),
    tools: new Map(),
    composerText: "",
    pendingRequest: null,
    requestError: null,
    serverError: null,
    notice: null,
  };
}

function lastKey(map: Map<string, HistoryRecord>): string | null {
  let last: string | null = null;
  for (const key of map.keys()) last = key;
  return last;
}

function applyRuntimeEvent(state: OrbPageState, event: RuntimeEvent): OrbPageState {
  switch (event.type) {
    case "status": {
      const operationId =
        event.operationId ?? (event.activity === "idle" ? null : state.operationId);
      return { ...state, activity: event.activity, operationId };
    }
    case "operation_started":
      return { ...state, activity: "busy", operationId: event.operationId };
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
      };
  }
}

function applyFrame(state: OrbPageState, frame: ServerFrame): OrbPageState {
  switch (frame.type) {
    case "server.welcome":
      return {
        ...state,
        welcome: {
          runtimeInstanceId: frame.runtimeInstanceId,
          sessionId: frame.sessionId,
          capabilities: frame.capabilities,
        },
        serverError: null,
      };
    case "sync.started": {
      const next: OrbPageState = {
        ...state,
        liveBlocks: new Map(),
        tools: new Map(),
        operationId: null,
        activity: null,
      };
      if (frame.mode === "full") {
        return { ...next, records: new Map(), afterRecordId: null, headId: null };
      }
      return next;
    }
    case "history.record": {
      const records = new Map(state.records);
      records.set(frame.record.id, frame.record);
      return {
        ...state,
        records,
        afterRecordId: frame.record.id,
        headId: frame.headId ?? frame.record.id,
      };
    }
    case "sync.completed":
      return { ...state, headId: frame.headId ?? lastKey(state.records) };
    case "runtime.event":
      return applyRuntimeEvent(state, frame.event);
    case "request.result": {
      if (state.pendingRequest === null || frame.requestId !== state.pendingRequest.requestId) {
        return state;
      }
      if (frame.result.type === "accepted") {
        const clearComposer = state.pendingRequest.kind === "message";
        return {
          ...state,
          pendingRequest: null,
          requestError: null,
          composerText: clearComposer ? "" : state.composerText,
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

function reducer(state: OrbPageState, action: OrbPageAction): OrbPageState {
  switch (action.type) {
    case "history_loaded": {
      const records = new Map<string, HistoryRecord>();
      for (const record of action.view.records) records.set(record.id, record);
      return {
        ...state,
        records,
        afterRecordId: action.view.cursor,
        headId: action.view.headId,
        historyLoaded: true,
        historyError: null,
      };
    }
    case "history_failed":
      return { ...state, historyError: action.error };
    case "frame":
      return applyFrame(state, action.frame);
    case "connection_status":
      return { ...state, connection: action.status };
    case "composer_changed":
      return { ...state, composerText: action.text };
    case "request_sent":
      return {
        ...state,
        pendingRequest: { requestId: action.requestId, kind: action.kind },
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
          "The runtime restarted before acknowledging your request; it was not resent. " +
          "If your message appears in the history it was delivered — otherwise send it again.",
      };
    }
    case "send_unavailable":
      return { ...state, notice: "Not connected — the request was not sent." };
  }
}

export function OrbPage({ orbId }: { orbId: string }) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const [orb, setOrb] = useState<OrbView | null>(null);
  const [orbError, setOrbError] = useState<ApiError | null>(null);

  // Poll the orb resource every 2s (DESIGN §11.3).
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const result = await getOrb(orbId);
      if (cancelled) return;
      if (result.isOk()) {
        setOrb(result.value);
        setOrbError(null);
      } else {
        setOrbError(result.error);
      }
    };
    poll();
    const timer = window.setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [orbId]);

  // Database-first history load (DESIGN §8.3).
  useEffect(() => {
    let cancelled = false;
    getOrbHistory(orbId).then((result) => {
      if (cancelled) return;
      dispatch(
        result.isOk()
          ? { type: "history_loaded", view: result.value }
          : { type: "history_failed", error: result.error },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [orbId]);

  // Live connection while running; hello carries the latest applied cursor.
  const afterRecordIdRef = useRef<string | null>(null);
  useEffect(() => {
    afterRecordIdRef.current = state.afterRecordId;
  }, [state.afterRecordId]);

  const liveRef = useRef<LiveConnection | null>(null);
  const shouldConnect = orb?.state === "running" && state.historyLoaded;
  useEffect(() => {
    if (!shouldConnect) return;
    const connection = openLiveConnection({
      orbId,
      getAfterRecordId: () => afterRecordIdRef.current,
      onFrame: (frame) => dispatch({ type: "frame", frame }),
      onStatus: (status) => dispatch({ type: "connection_status", status }),
      onRequestLost: (requestId) => dispatch({ type: "request_lost", requestId }),
    });
    liveRef.current = connection;
    return () => {
      liveRef.current = null;
      connection.dispose();
    };
  }, [orbId, shouldConnect]);

  const sendMessage = () => {
    const connection = liveRef.current;
    const text = state.composerText.trim();
    if (connection === null || text === "") return;
    const requestId = connection.sendRequest({
      type: "message",
      expectedHeadId: state.headId,
      content: [{ type: "text", text }],
    });
    if (requestId === null) dispatch({ type: "send_unavailable" });
    else dispatch({ type: "request_sent", requestId, kind: "message" });
  };

  const sendAbort = () => {
    const connection = liveRef.current;
    const operationId = state.operationId;
    if (connection === null || operationId === null) return;
    const requestId = connection.sendRequest({ type: "abort", operationId });
    if (requestId === null) dispatch({ type: "send_unavailable" });
    else dispatch({ type: "request_sent", requestId, kind: "abort" });
  };

  const runLifecycle = async (call: (orbId: string) => ReturnType<typeof startOrb>) => {
    const result = await call(orbId);
    if (result.isOk()) {
      setOrb(result.value);
      setOrbError(null);
    } else {
      setOrbError(result.error);
    }
  };

  const canStart = orb !== null && (orb.state === "stopped" || orb.state === "failed");
  const canStop =
    orb !== null &&
    (orb.state === "creating" || orb.state === "starting" || orb.state === "running");
  const connected = state.connection === "open";
  const canSend =
    connected && state.activity === "idle" && state.pendingRequest === null && state.historyLoaded;
  const canAbort =
    connected &&
    state.activity === "busy" &&
    state.operationId !== null &&
    state.pendingRequest === null &&
    (state.welcome?.capabilities.includes(CAPABILITY_ABORT) ?? false);

  return (
    <main className="page orb-page">
      <section className="panel orb-status">
        <div className="orb-status-row">
          <h1 className="orb-title">orb {orbId}</h1>
          {orb !== null && <span className={`state-badge state-${orb.state}`}>{orb.state}</span>}
        </div>
        {orb !== null && (
          <dl className="orb-meta">
            <dt>state version</dt>
            <dd>{orb.stateVersion}</dd>
            {orb.checkoutCommit !== undefined && (
              <>
                <dt>checkout</dt>
                <dd className="mono">{orb.checkoutCommit}</dd>
              </>
            )}
            {orb.lastError !== undefined && (
              <>
                <dt>last error</dt>
                <dd className="error-text">{orb.lastError}</dd>
              </>
            )}
          </dl>
        )}
        {orb?.stateDetail !== undefined && (
          <div className="banner banner-info">
            Stopping: draining history…
            {orb.stateDetail.retrying && " (retrying)"}
            {orb.stateDetail.message !== undefined && ` — ${orb.stateDetail.message}`}
          </div>
        )}
        {orb?.actionRequired !== undefined && (
          <div className="banner banner-action">
            <strong>Device login required.</strong> Visit{" "}
            <a href={orb.actionRequired.verificationUri} target="_blank" rel="noreferrer">
              {orb.actionRequired.verificationUri}
            </a>{" "}
            and enter code
            <span className="user-code">{orb.actionRequired.userCode}</span>
            <span className="muted"> (expires {orb.actionRequired.expiresAt})</span>
          </div>
        )}
        <div className="orb-actions">
          <button type="button" onClick={() => runLifecycle(startOrb)} disabled={!canStart}>
            start
          </button>
          <button type="button" onClick={() => runLifecycle(stopOrb)} disabled={!canStop}>
            stop
          </button>
          {orb?.state === "running" && (
            <span className="muted">
              live: {state.connection}
              {state.activity !== null && ` · ${state.activity}`}
            </span>
          )}
        </div>
        {orbError !== null && (
          <div className="banner banner-error">{describeApiError(orbError)}</div>
        )}
      </section>

      {state.serverError !== null && (
        <div className="banner banner-error">
          runtime error {state.serverError.code}: {state.serverError.message}
        </div>
      )}
      {state.requestError !== null && (
        <div className="banner banner-error">
          request rejected ({state.requestError.code}): {state.requestError.message}
        </div>
      )}
      {state.notice !== null && <div className="banner banner-info">{state.notice}</div>}
      {state.historyError !== null && (
        <div className="banner banner-error">
          history unavailable: {describeApiError(state.historyError)}
        </div>
      )}

      <HistoryView
        records={[...state.records.values()]}
        liveBlocks={[...state.liveBlocks.values()]}
        tools={[...state.tools.values()]}
        busy={state.activity === "busy"}
      />

      <Composer
        text={state.composerText}
        onTextChange={(text) => dispatch({ type: "composer_changed", text })}
        canSend={canSend}
        onSend={sendMessage}
        canAbort={canAbort}
        onAbort={sendAbort}
        pending={state.pendingRequest !== null}
      />
    </main>
  );
}
