import {
  CAPABILITY_ABORT,
  type HostedFilesResponse,
  type MessageInputBlock,
  type OrbMessageView,
  type OrbView,
  type SettingsAction,
} from "@pi-orb/protocol";
import {
  canRepairFromReplica,
  createMutationEpoch,
  hasDeliveredMessageAwaitingHistory,
  initialState,
  isLiveBusy,
  messagesAwaitingHistory,
  reducer,
  type TranscriptCache,
  type TranscriptOwner,
  withQueuedMessage,
} from "@pi-orb/transcript";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { Composer } from "../components/Composer.tsx";
import { HistoryView } from "../components/HistoryView.tsx";
import { HostedFiles } from "../components/HostedFiles.tsx";
import { Icon } from "../components/Icons.tsx";
import { OrbFailureBanner } from "../components/OrbFailureBanner.tsx";
import { OrbIndex } from "../components/OrbIndex.tsx";
import { OrbNotice } from "../components/OrbNotice.tsx";
import { OrbTerminal } from "../components/OrbTerminal.tsx";
import { StateTile } from "../components/StateTile.tsx";
import { SubagentRail } from "../components/SubagentRail.tsx";
import { useWorkspaceUploads } from "../components/useWorkspaceUploads.tsx";
import {
  type ApiError,
  archiveOrb,
  deleteOrb,
  describeApiError,
  enqueueOrbMessage,
  getOrb,
  getOrbHistory,
  listHostedFiles,
  listOrbMessages,
  startOrb,
  stopOrb,
  updateOrb,
} from "../lib/api.ts";
import { loadComposerDraft, saveComposerDraft } from "../lib/composer-draft.ts";
import { copyToClipboard } from "../lib/copy-to-clipboard.ts";
import { deriveOrbFaviconStatus, setOrbFavicon } from "../lib/favicon.ts";
import { type LiveConnection, openLiveConnection } from "../lib/live.ts";
import { isMissing, type OrbLoad, startOrbLoad } from "../lib/orb-load.ts";
import { DEFAULT_PAGE_TITLE, orbPageTitle, setPageTitle } from "../lib/page-title.ts";
import { formatTimeRemaining, projectOrbGlyph } from "../lib/project-orbs.ts";
import { isPinnedAfterScroll } from "../lib/scroll-pin.ts";
import {
  type BrowserNotificationPermission,
  notificationPermission,
  requestNotificationPermission,
  showTurnNotification,
} from "../lib/turn-notifications.ts";
import { usePhoneLayout } from "../lib/use-phone-layout.ts";
import { usePhoneViewport } from "../lib/use-phone-viewport.ts";
import { generateUuid } from "../lib/uuid.ts";
import { NotFoundPage } from "./NotFoundPage.tsx";

const POLL_INTERVAL_MS = 2000;

/** Defensive prompt cap until the welcome frame supplies the real limit. */
const FALLBACK_MAX_PROMPT_BYTES = 6 * 1024 * 1024;

/** Copies the device-login code without replacing the icon with text. */
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
      className="icon-button device-code-copy"
      data-state={copyStatus}
      aria-label={
        copyStatus === "copied"
          ? "Copied device code"
          : copyStatus === "failed"
            ? "Copy failed—try again"
            : "Copy device code"
      }
      aria-live="polite"
      title={copyStatus === "failed" ? "Clipboard access is unavailable" : "Copy device code"}
      onClick={() => {
        copyToClipboard(code).then((result) => setCopyStatus(result.isOk() ? "copied" : "failed"));
      }}
    >
      <Icon name="copy" />
    </button>
  );
}

export function OrbPage({ orbId, cache }: { orbId: string; cache: TranscriptCache }) {
  const pageRef = useRef<HTMLDivElement>(null);
  usePhoneViewport(pageRef);
  const [project, setProject] = useState<{ id: string; name: string } | null>(null);
  const [loaded, setLoaded] = useState<OrbLoad | null>(null);
  useEffect(() => {
    if (loaded?.orbId === orbId) return;
    const started = performance.now();
    const load = startOrbLoad({
      orbId,
      cache,
      getOrb,
      getHistory: getOrbHistory,
      diagnostic: (data) =>
        console.debug("transcript navigation", { ...data, loadMs: performance.now() - started }),
    });
    void load.result.then((value) => {
      const accepted = load.accept(value);
      if (accepted !== null) setLoaded(accepted);
    });
    return load.cancel;
  }, [orbId, loaded, cache]);
  const pending = loaded?.orbId !== orbId;
  return (
    <div className="orb-page" ref={pageRef}>
      <OrbIndex
        onProjectChange={setProject}
        projectId={loaded?.orb.isOk() ? loaded.orb.value.projectId : null}
        orbId={orbId}
        pending={pending}
      />
      {loaded === null ? (
        <div className="orb-main" aria-busy="true" />
      ) : (
        <OrbConversation
          key={loaded.orbId}
          initial={loaded}
          cache={cache}
          pending={pending}
          projectName={
            loaded.orb.isOk() && project?.id === loaded.orb.value.projectId ? project.name : null
          }
        />
      )}
    </div>
  );
}

function OrbConversation({
  initial,
  cache,
  pending,
  projectName,
}: {
  initial: OrbLoad;
  cache: TranscriptCache;
  pending: boolean;
  projectName: string | null;
}) {
  const orbId = initial.orbId;
  const phone = usePhoneLayout();
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollContentRef = useRef<HTMLDivElement>(null);
  const [state, dispatch] = useReducer(reducer, initial, (load) =>
    reducer(
      initialState(loadComposerDraft(load.orbId).unwrapOr(null)),
      load.history.isOk()
        ? { type: "history_restored", snapshot: load.history.value }
        : { type: "history_failed", message: describeApiError(load.history.error) },
    ),
  );
  const historyRecords = useMemo(() => [...state.records.values()], [state.records]);
  const liveBlocks = useMemo(() => [...state.liveBlocks.values()], [state.liveBlocks]);
  const tools = useMemo(() => [...state.tools.values()], [state.tools]);
  const draftStorageErrorShown = useRef(false);

  useEffect(() => {
    const saved = saveComposerDraft(orbId, {
      text: state.commandDraft?.text ?? state.composerText,
      mode: state.commandDraft?.mode ?? state.composerMode,
      images: state.composerImages,
    });
    if (saved.isErr() && !draftStorageErrorShown.current) {
      draftStorageErrorShown.current = true;
      dispatch({ type: "notice", message: saved.error.message });
    }
  }, [orbId, state.composerImages, state.composerMode, state.composerText, state.commandDraft]);
  const [orb, setOrb] = useState<OrbView | null>(() =>
    initial.orb.isOk() ? initial.orb.value : null,
  );
  const uploads = useWorkspaceUploads(orbId, orb?.state === "running");
  const [ageNow, setAgeNow] = useState(() => Date.now());
  const [orbError, setOrbError] = useState<ApiError | null>(() =>
    initial.orb.isErr() ? initial.orb.error : null,
  );
  const [hostedFiles, setHostedFiles] = useState<HostedFilesResponse | null>(null);
  const [hostedFilesError, setHostedFilesError] = useState<ApiError | null>(null);
  const [queuedMessages, setQueuedMessages] = useState<OrbMessageView[]>([]);
  // Invalidates queued-message reads that were already in flight when a
  // message mutation committed (see @pi-orb/transcript queued-messages).
  const [messageEpoch] = useState(createMutationEpoch);
  const transcriptRef = useRef(state);
  transcriptRef.current = state;
  const [orbNotFound, setOrbNotFound] = useState(
    () =>
      initial.orb.isErr() && initial.orb.error.type === "http" && initial.orb.error.status === 404,
  );
  const cacheOwner = useRef<TranscriptOwner | null>(null);
  const lifecycle = orb?.state ?? null;
  const resourceGone = orbNotFound || lifecycle === "deleting";
  const resourceProjectId = !resourceGone ? (orb?.projectId ?? null) : null;
  useLayoutEffect(() => {
    if (resourceGone) cache.invalidate(orbId);
    if (resourceProjectId === null) return;
    const owner = cache.acquire(orbId, resourceProjectId);
    cacheOwner.current = owner;
    return () => {
      owner.release();
      cacheOwner.current = null;
    };
  }, [cache, orbId, resourceProjectId, resourceGone]);
  const cacheAdmission = useRef<string | null>(null);
  useLayoutEffect(() => {
    const owner = cacheOwner.current;
    if (!owner || resourceProjectId === null) return;
    if (!state.cacheReady) {
      owner.clear();
      return;
    }
    const admission = owner.publish({
      sessionId: state.sessionId,
      records: state.records,
      afterRecordId: state.afterRecordId,
      headId: state.headId,
    });
    if (admission !== cacheAdmission.current) {
      cacheAdmission.current = admission;
      console.debug("transcript cache", { orbId, admission, ...cache.stats });
    }
  }, [
    cache,
    orbId,
    resourceProjectId,
    state.sessionId,
    state.records,
    state.afterRecordId,
    state.headId,
    state.cacheReady,
  ]);

  const refreshOwner = useRef<object | null>(null);
  useEffect(
    () => () => {
      refreshOwner.current = null;
    },
    [],
  );
  const refreshHistory = useCallback(() => {
    if (orbNotFound || refreshOwner.current !== null) return;
    const owner = {};
    const epoch = transcriptRef.current.historyEpoch;
    refreshOwner.current = owner;
    void getOrbHistory(orbId).then((history) => {
      if (refreshOwner.current !== owner) return;
      refreshOwner.current = null;
      if (history.isErr() && isMissing(history.error)) {
        cache.invalidate(orbId);
        setOrb(null);
        setOrbError(null);
        setOrbNotFound(true);
        return;
      }
      if (history.isOk() && history.value.orbId !== orbId) {
        dispatch({ type: "history_failed", message: "History identity mismatch" });
        return;
      }
      if (
        transcriptRef.current.historyEpoch !== epoch ||
        transcriptRef.current.connection === "open"
      )
        return;
      dispatch(
        history.isOk()
          ? { type: "history_refreshed", view: history.value, epoch }
          : { type: "history_failed", message: describeApiError(history.error) },
      );
    });
  }, [orbId, cache, orbNotFound]);
  const priorLifecycle = useRef(initial.orb.isOk() ? initial.orb.value.state : null);
  useEffect(() => {
    if (lifecycle === null || resourceGone) return;
    const lifecycleChanged = priorLifecycle.current !== lifecycle;
    priorLifecycle.current = lifecycle;
    if (lifecycle !== "running" && (initial.cacheHit || lifecycleChanged)) {
      if (lifecycleChanged) refreshOwner.current = null;
      refreshHistory();
    }
  }, [lifecycle, resourceGone, refreshHistory, initial.cacheHit]);
  const [mountedAt] = useState(() => performance.now());
  useEffect(() => {
    if (state.synced)
      console.debug("transcript live ready", {
        orbId,
        mountToLiveMs: performance.now() - mountedAt,
      });
  }, [state.synced, orbId, mountedAt]);

  const orbNameRef = useRef<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [phoneActions, setPhoneActions] = useState(false);
  const [renameText, setRenameText] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [notifications, setNotifications] = useState<BrowserNotificationPermission>(() =>
    notificationPermission(),
  );

  // Ask as soon as an orb page opens. The header button remains as a fallback for browsers that
  // require a user gesture or suppress the first prompt; denied permission still requires the
  // user to change browser site settings.
  useEffect(() => {
    if (notifications !== "default") return;
    let cancelled = false;
    void requestNotificationPermission().then((permission) => {
      if (!cancelled) setNotifications(permission);
    });
    return () => {
      cancelled = true;
    };
  }, [notifications]);

  const faviconStatus = deriveOrbFaviconStatus(
    orb?.state ?? null,
    state.connection,
    state.activity,
  );
  useEffect(() => setOrbFavicon(faviconStatus), [faviconStatus]);
  useEffect(() => () => setOrbFavicon("neutral"), []);

  const title =
    orb !== null && projectName !== null ? orbPageTitle(projectName, orb.name) : DEFAULT_PAGE_TITLE;
  useEffect(() => setPageTitle(title), [title]);
  useEffect(() => () => setPageTitle(DEFAULT_PAGE_TITLE), []);

  useEffect(() => {
    const timer = window.setInterval(() => setAgeNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);

  // Poll the orb resource every 2s (docs/control-plane-api.md).
  useEffect(() => {
    if (orbNotFound) return;
    let cancelled = false;
    const poll = async () => {
      const result = await getOrb(orbId);
      if (cancelled) return;
      if (result.isOk()) {
        setOrb(result.value);
        setOrbError(null);
        setOrbNotFound(false);
      } else {
        if (result.error.type === "http" && result.error.status === 404) {
          setOrb(null);
          setOrbError(null);
          setOrbNotFound(true);
          return;
        }
        setOrbError(result.error);
      }
    };
    poll();
    const timer = window.setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [orbId, orbNotFound]);

  useEffect(() => {
    if (orbNotFound) return;
    let cancelled = false;
    const poll = async () => {
      const result = await listHostedFiles(orbId);
      if (cancelled) return;
      if (result.isOk()) {
        setHostedFiles(result.value);
        setHostedFilesError(null);
      } else if (!(result.error.type === "http" && result.error.status === 404)) {
        setHostedFilesError(result.error);
      }
    };
    void poll();
    const timer = window.setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [orbId, orbNotFound]);

  useEffect(() => {
    let cancelled = false;
    if (resourceGone) return;
    const poll = () => {
      const token = messageEpoch.begin();
      void listOrbMessages(orbId).then((result) => {
        // Discard a snapshot taken before a message mutation committed: it
        // would clobber the optimistic append with a list that predates it.
        if (cancelled || messageEpoch.isStale(token) || result.isErr()) return;
        const transcript = transcriptRef.current;
        const records = [...transcript.records.values()];
        setQueuedMessages(messagesAwaitingHistory(result.value.items, records));

        // `delivered` and replicated history commit together. PostgreSQL can
        // repair a disconnected tab without hiding provisional turns. The
        // reducer fences responses against a socket that has since reopened.
        if (
          transcript.historyLoaded &&
          hasDeliveredMessageAwaitingHistory(result.value.items, records) &&
          canRepairFromReplica(lifecycle, transcript.connection)
        )
          refreshHistory();
      });
    };
    poll();
    const timer = window.setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [orbId, messageEpoch, refreshHistory, lifecycle, resourceGone]);

  useEffect(() => {
    orbNameRef.current = orb?.name ?? null;
  }, [orb?.name]);

  useEffect(() => {
    if (renaming) renameInputRef.current?.focus();
  }, [renaming]);

  // Follow the tail: while the reader is at (or near) the bottom, new chat
  // content keeps the view pinned there; once they scroll up, their position
  // stays locked until they return to the bottom themselves.
  const pinnedRef = useRef(true);
  const autoScrollYRef = useRef<number | null>(null);
  useEffect(() => {
    const onScroll = () => {
      pinnedRef.current = isPinnedAfterScroll(
        {
          scrollY: phone ? (scrollRef.current?.scrollTop ?? 0) : window.scrollY,
          viewportHeight: phone ? (scrollRef.current?.clientHeight ?? 0) : window.innerHeight,
          contentHeight: phone
            ? (scrollRef.current?.scrollHeight ?? 0)
            : document.documentElement.scrollHeight,
        },
        autoScrollYRef.current,
      );
      autoScrollYRef.current = null;
    };
    const target = phone ? scrollRef.current : window;
    const readerIntent = () => {
      pinnedRef.current = false;
      autoScrollYRef.current = null;
    };
    target?.addEventListener("scroll", onScroll, { passive: true });
    if (phone) {
      target?.addEventListener("pointerdown", readerIntent, { passive: true });
      target?.addEventListener("wheel", readerIntent, { passive: true });
      target?.addEventListener("pointerup", onScroll, { passive: true });
    }
    return () => {
      target?.removeEventListener("scroll", onScroll);
      target?.removeEventListener("pointerdown", readerIntent);
      target?.removeEventListener("wheel", readerIntent);
      target?.removeEventListener("pointerup", onScroll);
    };
  }, [phone]);
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!phone || !scroller) return;
    // Observe actual geometry, not React renders. Polling/typing must never write
    // scrollTop into an asynchronously scrolling WebKit layer, even at the same offset.
    const observer = new ResizeObserver(() => {
      if (!pinnedRef.current) return;
      const target = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      if (Math.abs(scroller.scrollTop - target) <= 1) return;
      scroller.scrollTop = target;
      autoScrollYRef.current = scroller.scrollTop;
    });
    observer.observe(scroller);
    if (scrollContentRef.current) observer.observe(scrollContentRef.current);
    return () => observer.disconnect();
  }, [phone]);
  // Preserve desktop document pinning. Phone scrolling is owned exclusively by
  // the geometry observer above, never by unrelated component renders.
  useLayoutEffect(() => {
    if (!phone && state.historyLoaded && pinnedRef.current) {
      const target = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      autoScrollYRef.current = target;
      window.scrollTo({ top: target });
      // Browsers can round the requested position; remember what was applied.
      autoScrollYRef.current = window.scrollY;
    }
  });

  // Live connection while running; hello carries the latest applied cursor.
  const afterRecordIdRef = useRef<string | null>(null);
  useEffect(() => {
    afterRecordIdRef.current = state.afterRecordId;
  }, [state.afterRecordId]);

  const liveRef = useRef<LiveConnection | null>(null);
  const shouldConnect = !orbNotFound && orb?.state === "running" && state.historyLoaded;
  useEffect(() => {
    if (!shouldConnect) return;
    let active = true;
    const isVisible = () => document.visibilityState === "visible";
    const connection = openLiveConnection({
      orbId,
      getAfterRecordId: () => afterRecordIdRef.current,
      sessionId: transcriptRef.current.sessionId,
      onFrame: (frame) => {
        if (!active) return;
        if (frame.type === "runtime.event" && frame.event.type === "turn_notification") {
          const event = frame.event;
          // Auto-naming runs concurrently with the first turn. Refresh once at notification time
          // so a just-committed display name wins even if the ordinary 2s orb poll has not seen it.
          void getOrb(orbId).then((latest) => {
            if (!active) return;
            const orbName = latest.isOk() ? (latest.value.name ?? null) : orbNameRef.current;
            if (latest.isOk()) {
              setOrb(latest.value);
              orbNameRef.current = orbName;
            }
            const result = showTurnNotification({
              orbId,
              orbName,
              operationId: event.operationId,
              summary: event.summary,
            });
            console.info("turn notification", { operationId: event.operationId, result });
          });
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
      active = false;
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
    dispatch({ type: "image_added", image: { id: generateUuid(), mediaType, data } });
  };

  const sendComposer = () => {
    const connection = liveRef.current;
    const text = state.composerText.trim();
    const images = state.composerImages;

    if (state.composerMode === "command" || state.pendingRequest?.kind === "settings") return;
    if (state.composerMode !== "message") {
      if (connection === null) return;
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
    const requestId = generateUuid();
    dispatch({ type: "request_sent", requestId, kind: "message" });
    void enqueueOrbMessage(orbId, requestId, { content }).then((result) => {
      if (result.isOk()) {
        const enqueued = result.value;
        // Commit before the append so any list request already in flight is
        // discarded rather than replacing the queue without this message.
        messageEpoch.commit();
        setQueuedMessages((current) => withQueuedMessage(current, enqueued));
        dispatch({ type: "message_enqueued", requestId });
      } else {
        dispatch({
          type: "message_enqueue_failed",
          requestId,
          message: describeApiError(result.error),
        });
      }
    });
  };

  const changeSettings = (action: SettingsAction) => {
    if (
      !state.synced ||
      !state.settings?.writable ||
      state.activity !== "idle" ||
      state.pendingRequest
    )
      return;
    const requestId = liveRef.current?.sendRequest(action);
    if (!requestId) dispatch({ type: "send_unavailable" });
    else dispatch({ type: "request_sent", requestId, kind: "settings" });
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

  const archive = async () => {
    if (
      !window.confirm(
        "Archive this orb? Its checkout, files, compute, and port access will be permanently deleted. Its conversation will remain readable, but the orb can never start again.",
      )
    )
      return;
    const result = await archiveOrb(orbId);
    if (result.isOk()) {
      setOrb(result.value);
      setOrbError(null);
      setRenaming(false);
    } else {
      setOrbError(result.error);
    }
  };

  const permanentlyDelete = async () => {
    if (
      !window.confirm(
        "Delete this orb permanently? Its checkout, files, and conversation history will be lost.",
      )
    )
      return;
    const result = await deleteOrb(orbId);
    if (result.isOk()) cache.invalidate(orbId);
    if (result.isOk()) {
      setOrb(result.value);
      setOrbError(null);
      setRenaming(false);
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
  const messageAccepting =
    orb !== null &&
    !["deleting", "archiving", "archived"].includes(orb.state) &&
    state.historyLoaded;
  const settingsAvailable =
    orb?.state === "running" &&
    state.connection === "open" &&
    state.synced &&
    state.settings !== null;
  const settingsDisabled =
    !settingsAvailable ||
    !state.settings?.writable ||
    state.activity !== "idle" ||
    state.pendingRequest !== null;
  const canSend =
    state.pendingRequest === null &&
    (state.settings?.writable ?? true) &&
    (state.composerMode === "message"
      ? messageAccepting
      : connected && state.activity === "idle" && state.historyLoaded);
  const canAbort =
    connected &&
    state.activity === "busy" &&
    state.operationId !== null &&
    state.pendingRequest === null &&
    (state.welcome?.capabilities.includes(CAPABILITY_ABORT) ?? false);

  if (orbNotFound) return <NotFoundPage resourceName="Orb" />;

  const glyph = orb === null ? null : projectOrbGlyph(orb.state, orb.activity);
  const lifecycleWord =
    orb === null
      ? null
      : orb.stopReason === "idle" && (orb.state === "stopping" || orb.state === "stopped")
        ? `${orb.state} (idle)`
        : orb.state;
  const busyLocked = orb?.state === "deleting" || orb?.state === "archiving";
  const expiresIn =
    orb?.actionRequired === undefined
      ? null
      : formatTimeRemaining(orb.actionRequired.expiresAt, ageNow);

  return (
    <main className="orb-main" inert={pending} aria-busy={pending}>
      <div className="orb-header-stack">
        <header className="orb-header" data-phone-actions={phoneActions}>
          <a className="orb-phone-home" href="#/" aria-label="Dashboard" title="dashboard">
            <Icon name="back" />
          </a>
          <div className="orb-identity">
            {renaming ? (
              <form
                className="orb-rename-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveName();
                }}
              >
                <input
                  ref={renameInputRef}
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
              <>
                <span className="orb-name">{orb?.name ?? "untitled orb"}</span>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Rename orb"
                  title="rename"
                  disabled={busyLocked}
                  onClick={() => {
                    setRenameText(orb?.name ?? "");
                    setRenaming(true);
                  }}
                >
                  <Icon name="pen" />
                </button>
              </>
            )}
          </div>
          {glyph !== null && lifecycleWord !== null && (
            <span className="orb-life">
              <StateTile glyph={glyph} decorative />
              <span className="orb-life-word">
                {orb?.activity === "busy" ? `${lifecycleWord} · busy` : lifecycleWord}
              </span>
            </span>
          )}
          <button
            type="button"
            className="icon-button orb-phone-menu"
            aria-label="Orb actions"
            aria-expanded={phoneActions}
            onClick={() => setPhoneActions((open) => !open)}
          >
            <Icon name="more" />
          </button>
          <div className="orb-settings">
            <button
              type="button"
              title="Change model"
              aria-label="Change model"
              disabled={!settingsAvailable || state.pendingRequest !== null}
              onClick={() => dispatch({ type: "open_settings", command: "model" })}
            >
              {settingsAvailable
                ? (state.settings?.models.find(
                    (model) =>
                      model.provider === state.settings?.settings.model.provider &&
                      model.id === state.settings?.settings.model.id,
                  )?.name ?? state.settings?.settings.model.id)
                : "—"}
            </button>
            <button
              type="button"
              title="Change thinking"
              aria-label="Change thinking"
              disabled={!settingsAvailable || state.pendingRequest !== null}
              onClick={() => dispatch({ type: "open_settings", command: "thinking" })}
            >
              {settingsAvailable ? state.settings?.settings.thinkingLevel : "—"}
            </button>
          </div>
          <div className="orb-header-actions">
            <OrbTerminal orbId={orbId} enabled={orb?.state === "running"} />
            {uploads.button}
            {canStart && (
              <button
                type="button"
                className="icon-button"
                aria-label="Start orb"
                title="start"
                onClick={() => runLifecycle(startOrb)}
              >
                <Icon name="start" />
              </button>
            )}
            {canStop && (
              <button
                type="button"
                className="icon-button"
                aria-label="Stop orb"
                title="stop"
                onClick={() => runLifecycle(stopOrb)}
              >
                <Icon name="stop" />
              </button>
            )}
            <button
              type="button"
              className="icon-button"
              aria-label="Archive orb"
              title="archive"
              disabled={
                orb === null ||
                orb.state === "deleting" ||
                orb.state === "archiving" ||
                orb.state === "archived"
              }
              onClick={() => void archive()}
            >
              <Icon name="archive" />
            </button>
            <button
              type="button"
              className="icon-button danger"
              aria-label="Delete orb"
              title="delete"
              disabled={orb?.state === "deleting"}
              onClick={() => void permanentlyDelete()}
            >
              <Icon name="bin" />
            </button>
          </div>
        </header>
        {orb?.state === "running" && connected && state.subagents.length > 0 && (
          <SubagentRail agents={state.subagents} />
        )}
      </div>
      <div className="orb-transcript-scroll" ref={scrollRef}>
        <div className="orb-transcript-content" ref={scrollContentRef}>
          {uploads.progress}

          {orb?.stateDetail?.type === "discarding_failed_compute" && (
            <OrbNotice>
              Discarding failed compute while preserving the workspace…
              {orb.stateDetail.retrying && " (retrying)"}
              {orb.stateDetail.message !== undefined && ` — ${orb.stateDetail.message}`}
            </OrbNotice>
          )}
          {orb?.stateDetail?.type === "replacing_stale_compute" && (
            <OrbNotice>
              Replacing compute for an updated host specification while preserving the workspace…
              {orb.stateDetail.retrying && " (retrying)"}
              {orb.stateDetail.message !== undefined && ` — ${orb.stateDetail.message}`}
            </OrbNotice>
          )}
          {orb?.stateDetail?.type === "deleting_resources" && (
            <OrbNotice>
              Permanently deleting orb resources…
              {orb.stateDetail.retrying && " (retrying)"}
              {orb.stateDetail.message !== undefined && ` — ${orb.stateDetail.message}`}
            </OrbNotice>
          )}
          {orb?.stateDetail?.type === "archiving_orb" && (
            <OrbNotice>
              {orb.stateDetail.phase === "waiting_for_idle"
                ? "Archiving: waiting for the agent to become idle…"
                : orb.stateDetail.phase === "sealing_history"
                  ? "Archiving: sealing complete history…"
                  : "Archiving: permanently removing runtime resources…"}
              {orb.stateDetail.retrying && " (retrying)"}
              {orb.stateDetail.message !== undefined && ` — ${orb.stateDetail.message}`}
            </OrbNotice>
          )}
          {orb?.stateDetail?.type === "draining_history" && (
            <OrbNotice>
              Stopping: draining history…
              {orb.stateDetail.retrying && " (retrying)"}
              {orb.stateDetail.message !== undefined && ` — ${orb.stateDetail.message}`}
            </OrbNotice>
          )}
          {orb?.stateDetail?.type === "waiting_for_runtime" && (
            <OrbNotice>
              Waiting for the runtime…
              {orb.stateDetail.hostState !== null && ` host ${orb.stateDetail.hostState}`}
              {orb.stateDetail.secondsSinceHostRunning !== null &&
                ` for ${orb.stateDetail.secondsSinceHostRunning}s`}
              {` — ${orb.stateDetail.probeAttempts} probes`}
              {orb.stateDetail.lastProbeError !== undefined &&
                ` — last error: ${orb.stateDetail.lastProbeError}`}
            </OrbNotice>
          )}
          {orb?.stateDetail?.type === "running_setup" && (
            <OrbNotice>
              Running the repository's <code>.agents/setup</code>…
              {` for ${orb.stateDetail.secondsRunning}s`}
            </OrbNotice>
          )}
          {orb?.stateDetail?.type === "setup_failed" && (
            <OrbNotice error>
              The repository's <code>.agents/{orb.stateDetail.hook}</code>{" "}
              {orb.stateDetail.reason === "timeout"
                ? "ran past its deadline and was stopped"
                : orb.stateDetail.reason === "hook_not_executable"
                  ? "is not executable"
                  : "failed"}
              . The orb started anyway; its log is at <code>{orb.stateDetail.logPath}</code>.
            </OrbNotice>
          )}
          {orb?.actionRequired !== undefined && (
            <OrbNotice>
              {orb.actionRequired.type === "github_device_login"
                ? "GitHub device login required."
                : "OpenAI device login required."}{" "}
              Visit{" "}
              <a href={orb.actionRequired.verificationUri} target="_blank" rel="noreferrer">
                {orb.actionRequired.verificationUri}
              </a>{" "}
              and enter <span className="user-code">{orb.actionRequired.userCode}</span>
              <CopyCodeButton code={orb.actionRequired.userCode} />
              {expiresIn !== null && <span className="muted"> expires in {expiresIn}</span>}
            </OrbNotice>
          )}
          <OrbFailureBanner message={orb?.lastError} />
          <HostedFiles inventory={hostedFiles} error={hostedFilesError} />
          {orbError !== null && <OrbNotice error>{describeApiError(orbError)}</OrbNotice>}
          <div className="orb-composer-feedback-original">
            {state.serverError !== null && (
              <OrbNotice error>
                runtime error {state.serverError.code}: {state.serverError.message}
              </OrbNotice>
            )}
            {state.requestError !== null && (
              <OrbNotice error>
                request rejected ({state.requestError.code}): {state.requestError.message}
              </OrbNotice>
            )}
            {state.notice !== null && <OrbNotice>{state.notice}</OrbNotice>}
          </div>
          {state.historyError !== null && (
            <OrbNotice error>
              history unavailable: {state.historyError}{" "}
              <button type="button" onClick={refreshHistory}>
                Retry
              </button>
            </OrbNotice>
          )}

          <HistoryView
            records={historyRecords}
            liveBlocks={liveBlocks}
            tools={tools}
            busy={isLiveBusy(orb?.state, state)}
            queuedMessages={queuedMessages}
          />
        </div>
      </div>
      {orb?.state !== "archived" && orb?.state !== "archiving" && (
        <Composer
          settings={settingsAvailable ? state.settings : null}
          settingsDisabled={settingsDisabled}
          settingsPending={state.pendingRequest?.kind === "settings"}
          onSettingsChange={changeSettings}
          feedback={[
            state.pendingRequest?.kind === "settings" ? "Applying settings…" : null,
            state.serverError === null
              ? null
              : `runtime error ${state.serverError.code}: ${state.serverError.message}`,
            state.requestError === null
              ? null
              : `request rejected (${state.requestError.code}): ${state.requestError.message}`,
            state.notice,
          ]
            .filter((message) => message !== null)
            .join(" · ")}
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
          onShellAttachmentBlocked={() =>
            dispatch({
              type: "notice",
              message: "Remove image attachments before running a shell command.",
            })
          }
        />
      )}
    </main>
  );
}
