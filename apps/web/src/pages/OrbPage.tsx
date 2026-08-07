import {
  CAPABILITY_ABORT,
  CAPABILITY_INPUT_IMAGE,
  type HistoryRecord,
  type MessageInputBlock,
  type OrbHistoryView,
  type OrbView,
  type RuntimeEvent,
  type ServerFrame,
} from "@pi-orb/protocol";
import { useEffect, useReducer, useRef, useState } from "react";
import { Composer, type ComposerImage } from "../components/Composer.tsx";
import type { ComposerMode } from "../components/composer-mode.ts";
import { HistoryView, type LiveBlock, type ToolChip } from "../components/HistoryView.tsx";
import {
  type ApiError,
  describeApiError,
  getOrb,
  getOrbHistory,
  startOrb,
  stopOrb,
  updateOrb,
} from "../lib/api.ts";
import { copyToClipboard } from "../lib/copy-to-clipboard.ts";
import { type LiveConnection, type LiveConnectionStatus, openLiveConnection } from "../lib/live.ts";
import { isPinnedToBottom } from "../lib/scroll-pin.ts";
import {
  type BrowserNotificationPermission,
  describeTurnNotificationResult,
  notificationPermission,
  requestNotificationPermission,
  showTurnNotification,
} from "../lib/turn-notifications.ts";

const POLL_INTERVAL_MS = 2000;

interface WelcomeInfo {
  runtimeInstanceId: string;
  sessionId: string;
  capabilities: string[];
  maxPromptBytes: number;
}

/** Defensive prompt cap until the welcome frame supplies the real limit. */
const FALLBACK_MAX_PROMPT_BYTES = 6 * 1024 * 1024;

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
  composerMode: ComposerMode;
  composerImages: ComposerImage[];
  pendingRequest: { requestId: string; kind: "message" | "shell" | "abort" } | null;
  requestError: { code: string; message: string } | null;
  serverError: { code: string; message: string } | null;
  notice: string | null;
}

type OrbPageAction =
  | { type: "history_loaded"; view: OrbHistoryView }
  | { type: "history_failed"; error: ApiError }
  | { type: "frame"; frame: ServerFrame }
  | { type: "connection_status"; status: LiveConnectionStatus }
  | { type: "composer_changed"; text: string; mode: ComposerMode }
  | { type: "image_added"; image: ComposerImage }
  | { type: "image_removed"; id: string }
  | { type: "notice"; message: string }
  | { type: "request_sent"; requestId: string; kind: "message" | "shell" | "abort" }
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
    composerMode: "message",
    composerImages: [],
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
    case "turn_notification":
      // Notification display is a browser side effect handled before reduction.
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

function applyFrame(state: OrbPageState, frame: ServerFrame): OrbPageState {
  switch (frame.type) {
    case "server.welcome":
      return {
        ...state,
        welcome: {
          runtimeInstanceId: frame.runtimeInstanceId,
          sessionId: frame.sessionId,
          capabilities: frame.capabilities,
          maxPromptBytes: frame.limits.maxPromptBytes,
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

/** Copies the device-login code; flips its label briefly as feedback. */
function CopyCodeButton({ code }: { code: string }) {
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (copyStatus === "idle") return;
    const timer = setTimeout(() => setCopyStatus("idle"), 1500);
    return () => clearTimeout(timer);
  }, [copyStatus]);
  return (
    <button
      type="button"
      className="copy-code"
      title={copyStatus === "failed" ? "Clipboard access is unavailable" : "Copy device code"}
      onClick={() => {
        copyToClipboard(code).then((result) => setCopyStatus(result.isOk() ? "copied" : "failed"));
      }}
    >
      {copyStatus === "copied" ? "copied" : copyStatus === "failed" ? "copy failed" : "copy"}
    </button>
  );
}

export function OrbPage({ orbId }: { orbId: string }) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const [orb, setOrb] = useState<OrbView | null>(null);
  const [orbError, setOrbError] = useState<ApiError | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameText, setRenameText] = useState("");
  const [notifications, setNotifications] = useState<BrowserNotificationPermission>(() =>
    notificationPermission(),
  );

  // Poll the orb resource every 2s (docs/control-plane-api.md).
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

  // Database-first history load (docs/history-replication.md).
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

  // Follow the tail: while the reader is at (or near) the bottom, new chat
  // content keeps the view pinned there; once they scroll up, their position
  // stays locked until they return to the bottom themselves.
  const pinnedRef = useRef(true);
  useEffect(() => {
    const onScroll = () => {
      pinnedRef.current = isPinnedToBottom({
        scrollY: window.scrollY,
        viewportHeight: window.innerHeight,
        contentHeight: document.documentElement.scrollHeight,
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  // No dependency array: any render may have grown the page (records, live
  // stream, tool chips). Scrolling to the bottom while already there is a
  // no-op, so running after every render is cheap and always correct.
  useEffect(() => {
    if (state.historyLoaded && pinnedRef.current) {
      window.scrollTo({ top: document.documentElement.scrollHeight });
    }
  });

  // Live connection while running; hello carries the latest applied cursor.
  const afterRecordIdRef = useRef<string | null>(null);
  useEffect(() => {
    afterRecordIdRef.current = state.afterRecordId;
  }, [state.afterRecordId]);

  const liveRef = useRef<LiveConnection | null>(null);
  const shouldConnect = orb?.state === "running" && state.historyLoaded;
  useEffect(() => {
    if (!shouldConnect) return;
    const isVisible = () => document.visibilityState === "visible";
    const connection = openLiveConnection({
      orbId,
      getAfterRecordId: () => afterRecordIdRef.current,
      onFrame: (frame) => {
        if (frame.type === "runtime.event" && frame.event.type === "turn_notification") {
          const result = showTurnNotification({
            orbId,
            operationId: frame.event.operationId,
            summary: frame.event.summary,
          });
          console.info("turn notification", {
            operationId: frame.event.operationId,
            result,
          });
          dispatch({ type: "notice", message: describeTurnNotificationResult(result) });
        }
        dispatch({ type: "frame", frame });
      },
      onStatus: (status) => dispatch({ type: "connection_status", status }),
      onRequestLost: (requestId) => dispatch({ type: "request_lost", requestId }),
      getVisible: isVisible,
    });
    // Only a visible tab counts as activity for idle auto-stop (docs/lifecycle.md).
    const onVisibilityChange = () => connection.sendPresence(isVisible());
    document.addEventListener("visibilitychange", onVisibilityChange);
    liveRef.current = connection;
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      liveRef.current = null;
      connection.dispose();
    };
  }, [orbId, shouldConnect]);

  const maxPromptBytes = state.welcome?.maxPromptBytes ?? FALLBACK_MAX_PROMPT_BYTES;

  const addImage = (mediaType: string, data: string) => {
    const pendingBytes =
      state.composerImages.reduce((sum, image) => sum + image.data.length, 0) + data.length;
    if (pendingBytes > maxPromptBytes) {
      dispatch({
        type: "notice",
        message: `Image too large — attachments are limited to ${Math.floor(maxPromptBytes / (1024 * 1024))} MiB per message.`,
      });
      return;
    }
    dispatch({ type: "image_added", image: { id: crypto.randomUUID(), mediaType, data } });
  };

  const sendComposer = () => {
    const connection = liveRef.current;
    const text = state.composerText.trim();
    const images = state.composerImages;
    if (connection === null) return;

    if (state.composerMode !== "message") {
      if (images.length > 0) {
        dispatch({
          type: "notice",
          message: "Remove image attachments before running a shell command.",
        });
        return;
      }
      if (text === "") return;
      const requestId = connection.sendRequest({
        type: "shell",
        expectedHeadId: state.headId,
        command: text,
        excludeFromContext: state.composerMode === "excluded_shell",
      });
      if (requestId === null) dispatch({ type: "send_unavailable" });
      else dispatch({ type: "request_sent", requestId, kind: "shell" });
      return;
    }

    if (text === "" && images.length === 0) return;
    if (
      images.length > 0 &&
      !(state.welcome?.capabilities.includes(CAPABILITY_INPUT_IMAGE) ?? false)
    ) {
      dispatch({ type: "notice", message: "This runtime does not accept image input." });
      return;
    }
    const content: MessageInputBlock[] = [
      ...images.map(
        (image): MessageInputBlock => ({
          type: "image",
          mediaType: image.mediaType,
          data: image.data,
        }),
      ),
      ...(text !== "" ? [{ type: "text", text } satisfies MessageInputBlock] : []),
    ];
    const requestId = connection.sendRequest({
      type: "message",
      expectedHeadId: state.headId,
      content,
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

  const saveName = async () => {
    const result = await updateOrb(orbId, { name: renameText });
    if (result.isOk()) {
      setOrb(result.value);
      setOrbError(null);
      setRenaming(false);
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
    <>
      <header className="app-header orb-header">
        <a href="#/" className="app-title">
          pi-orb
        </a>
        <div className="orb-header-identity">
          {renaming ? (
            <form
              className="orb-rename-form"
              onSubmit={(event) => {
                event.preventDefault();
                void saveName();
              }}
            >
              <input
                aria-label="orb name"
                value={renameText}
                maxLength={80}
                onChange={(event) => setRenameText(event.target.value)}
              />
              <button type="submit">save</button>
              <button type="button" onClick={() => setRenaming(false)}>
                cancel
              </button>
            </form>
          ) : (
            <h1 className="orb-title" title={`orb ${orbId}`}>
              {orb?.name ?? "untitled orb"}
              <button
                type="button"
                className="orb-rename-button"
                onClick={() => {
                  setRenameText(orb?.name ?? "");
                  setRenaming(true);
                }}
              >
                rename
              </button>
            </h1>
          )}
          <div className="orb-header-meta">
            {orb === null ? (
              <span>loading…</span>
            ) : (
              <>
                <span>orb {orbId.slice(0, 8)}</span>
                <span>v{orb.stateVersion}</span>
                {orb.checkoutCommit !== undefined && (
                  <span className="orb-header-checkout">checkout {orb.checkoutCommit}</span>
                )}
                {orb.previewHost !== undefined && (
                  <span
                    className="orb-header-preview"
                    title="Any port a server listens on inside the orb is reachable at this host over your tailnet"
                  >
                    Ports: http://<span className="orb-preview-host">{orb.previewHost}</span>:
                    {"<port>"}
                  </span>
                )}
              </>
            )}
          </div>
        </div>
        {orb !== null && (
          <span className={`state-badge state-${orb.state}`}>
            {orb.stopReason === "idle" && (orb.state === "stopping" || orb.state === "stopped")
              ? `${orb.state} (idle)`
              : orb.state}
          </span>
        )}
        <span className="orb-header-live">
          {orb?.state === "running" && (
            <>
              {state.connection}
              {state.activity !== null && ` · ${state.activity}`}
            </>
          )}
        </span>
        <div className="orb-header-actions">
          <button
            type="button"
            title={
              notifications === "unsupported"
                ? "Notifications require a secure browser context (HTTPS or localhost)"
                : notifications === "denied"
                  ? "Notifications are blocked in browser settings"
                  : notifications === "granted"
                    ? "Desktop notifications are enabled"
                    : "Enable a desktop notification whenever an agent turn finishes"
            }
            disabled={notifications !== "default"}
            onClick={() => void requestNotificationPermission().then(setNotifications)}
          >
            {notifications === "unsupported"
              ? "notify unavailable"
              : notifications === "denied"
                ? "notify blocked"
                : notifications === "granted"
                  ? "notifications on"
                  : "enable notifications"}
          </button>
          <button type="button" onClick={() => runLifecycle(startOrb)} disabled={!canStart}>
            start
          </button>
          <button type="button" onClick={() => runLifecycle(stopOrb)} disabled={!canStop}>
            stop
          </button>
        </div>
      </header>

      <main className="app-main page orb-page">
        {orb?.stateDetail?.type === "draining_history" && (
          <div className="banner banner-info">
            Stopping: draining history…
            {orb.stateDetail.retrying && " (retrying)"}
            {orb.stateDetail.message !== undefined && ` — ${orb.stateDetail.message}`}
          </div>
        )}
        {orb?.stateDetail?.type === "waiting_for_runtime" && (
          <div className="banner banner-info">
            Waiting for the runtime…
            {orb.stateDetail.hostState !== null && ` host ${orb.stateDetail.hostState}`}
            {orb.stateDetail.secondsSinceHostRunning !== null &&
              ` for ${orb.stateDetail.secondsSinceHostRunning}s`}
            {` — ${orb.stateDetail.probeAttempts} probes`}
            {orb.stateDetail.lastProbeError !== undefined &&
              ` — last error: ${orb.stateDetail.lastProbeError}`}
          </div>
        )}
        {orb?.actionRequired !== undefined && (
          <div className="banner banner-action">
            <strong>
              {orb.actionRequired.type === "github_device_login"
                ? "GitHub device login required."
                : "OpenAI device login required."}
            </strong>{" "}
            Visit{" "}
            <a href={orb.actionRequired.verificationUri} target="_blank" rel="noreferrer">
              {orb.actionRequired.verificationUri}
            </a>{" "}
            and enter code <span className="user-code">{orb.actionRequired.userCode}</span>
            <CopyCodeButton code={orb.actionRequired.userCode} />
            <span className="muted"> (expires {orb.actionRequired.expiresAt})</span>
          </div>
        )}
        {orb?.lastError !== undefined && <div className="banner banner-error">{orb.lastError}</div>}
        {orbError !== null && (
          <div className="banner banner-error">{describeApiError(orbError)}</div>
        )}

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
          mode={state.composerMode}
          onValueChange={(text, mode) => dispatch({ type: "composer_changed", text, mode })}
          images={state.composerImages}
          onImageAdd={addImage}
          onImageRemove={(id) => dispatch({ type: "image_removed", id })}
          canSend={canSend}
          onSend={sendComposer}
          canAbort={canAbort}
          onAbort={sendAbort}
          pending={state.pendingRequest !== null}
          onShellAttachmentBlocked={() =>
            dispatch({
              type: "notice",
              message: "Remove image attachments before running a shell command.",
            })
          }
        />
      </main>
    </>
  );
}
