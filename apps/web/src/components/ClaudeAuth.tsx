import type { ClaudeAuthView } from "@pi-orb/protocol";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { claudeAuthAction, getClaudeAuth } from "../lib/api.ts";
import {
  type ClaudeAuthAction,
  ClaudeAuthController,
  type ClaudeAuthSnapshot,
} from "../lib/claude-auth.ts";
import {
  type ConsentWindowError,
  consentUrl,
  describeConsentWindowError,
  reserveConsentWindow,
} from "../lib/claude-consent-window.ts";
import { Icon } from "./Icons.tsx";
import { TextFieldFrame } from "./TextFieldFrame.tsx";
export function ClaudeAuthViewPanel({
  view,
  pending,
  completing = false,
  error,
  launchError,
  code,
  onCode,
  onAction,
  onRetry,
}: {
  view: ClaudeAuthView | null;
  pending: boolean;
  completing?: boolean;
  error: string | null;
  launchError?: ConsentWindowError | null;
  code: string;
  onCode(value: string): void;
  onAction(action: ClaudeAuthAction): void;
  onRetry(): void;
}) {
  const url = consentUrl(view?.challenge?.url);
  return (
    <div className="claude-auth-panel">
      {error !== null && (
        <div className="banner banner-error" role="alert">
          {error}{" "}
          <button type="button" onClick={onRetry} disabled={pending}>
            Retry
          </button>
        </div>
      )}
      {launchError && (
        <div className="banner banner-error" role="alert">
          {describeConsentWindowError(launchError)}
        </div>
      )}
      {view?.error && (
        <div className="banner banner-error" role="alert">
          {view.error}
        </div>
      )}
      {completing ? (
        <div role="status">Completing connection…</div>
      ) : pending ? (
        <div role="status">Working…</div>
      ) : view?.status === "connecting" && !view.challenge ? (
        <div role="status">Connecting…</div>
      ) : null}
      {view?.status === "connecting" ? (
        <>
          {!completing && url !== null && (
            <a href={url} target="_blank" rel="noreferrer">
              Sign in with Anthropic
            </a>
          )}
          {!completing && view.challenge?.needsCode && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                onAction("code");
              }}
            >
              <TextFieldFrame>
                <input
                  type="password"
                  aria-label="Claude completion code"
                  value={code}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => onCode(event.target.value)}
                  disabled={pending}
                />
              </TextFieldFrame>
              <button type="submit" disabled={pending || code.trim() === ""}>
                Complete connection
              </button>
            </form>
          )}
          <button type="button" disabled={pending} onClick={() => onAction("cancel")}>
            Cancel connection
          </button>
        </>
      ) : view?.status === "connected" ? (
        <>
          <div role="status">Claude connected</div>
          <button type="button" disabled={pending} onClick={() => onAction("connect")}>
            Reconnect Claude
          </button>
          <button type="button" disabled={pending} onClick={() => onAction("disconnect")}>
            Disconnect Claude
          </button>
        </>
      ) : view !== null ? (
        <button type="button" disabled={pending} onClick={() => onAction("connect")}>
          Connect Claude subscription
        </button>
      ) : !pending && error === null ? (
        <div role="status">Loading…</div>
      ) : null}
    </div>
  );
}

function createClaudeAuthController(visible = () => document.visibilityState === "visible") {
  return new ClaudeAuthController({
    read: getClaudeAuth,
    write: claudeAuthAction,
    visible,
    schedule: (fn) => {
      const timer = window.setTimeout(fn, 1000);
      return () => window.clearTimeout(timer);
    },
  });
}

/** The owner pane only reads on entry; connection admission remains an explicit click. */
export function ClaudeAuthSettings({ active }: { active: boolean }) {
  const visible = useRef(active);
  visible.current = active;
  const [controller, setController] = useState<ClaudeAuthController | null>(null);
  useEffect(() => {
    const next = createClaudeAuthController(
      () => visible.current && document.visibilityState === "visible",
    );
    setController(next);
    return () => next.dispose();
  }, []);
  useEffect(() => {
    if (!controller) return;
    if (active) void controller.start();
    else controller.visibilityChanged();
  }, [active, controller]);
  return controller ? <ClaudeAuthContent controller={controller} active={active} /> : null;
}

function ClaudeAuthContent({
  controller,
  active = true,
}: {
  controller: ClaudeAuthController;
  active?: boolean;
}) {
  const [snapshot, setSnapshot] = useState<ClaudeAuthSnapshot>(controller.snapshot);
  const [code, setCode] = useState("");
  const pane = useRef<HTMLDivElement>(null);
  const activePane = useRef(active);
  activePane.current = active;
  useEffect(() => {
    const unsubscribe = controller.subscribe(() => setSnapshot(controller.snapshot));
    setSnapshot(controller.snapshot);
    const focusCode = () => {
      if (activePane.current && document.visibilityState === "visible")
        pane.current?.querySelector<HTMLInputElement>("input:not(:disabled)")?.focus();
    };
    const visibility = () => {
      setCode("");
      controller.visibilityChanged();
      focusCode();
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("focus", focusCode);
    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("focus", focusCode);
    };
  }, [controller]);
  useEffect(() => {
    if (
      active &&
      snapshot.view?.challenge?.needsCode &&
      !snapshot.completing &&
      !snapshot.pending &&
      document.visibilityState === "visible"
    )
      pane.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, [active, snapshot.view?.challenge?.needsCode, snapshot.completing, snapshot.pending]);
  return (
    <div ref={pane}>
      <ClaudeAuthViewPanel
        {...snapshot}
        code={code}
        onCode={setCode}
        onRetry={() => void controller.start()}
        onAction={(action) => {
          const completion = code.trim();
          setCode("");
          if (action === "connect") void controller.enter(reserveConsentWindow(), true);
          else void controller.act(action, action === "code" ? completion : undefined);
        }}
      />
    </div>
  );
}

function ClaudeAuthDialog({
  controller,
  onClose,
}: {
  controller: ClaudeAuthController;
  onClose(): void;
}) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => close.current?.focus(), []);
  return createPortal(
    <div className="project-secrets-backdrop">
      <section
        className="project-secrets-dialog claude-auth-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Claude subscription"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
          if (event.key === "Tab") {
            const items = Array.from(
              event.currentTarget.querySelectorAll<HTMLElement>(
                "button:not(:disabled), input:not(:disabled), a[href]",
              ),
            );
            const first = items[0],
              last = items.at(-1);
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <header className="personal-instructions-header">
          Claude subscription
          <button
            ref={close}
            type="button"
            className="icon-button modal-close"
            aria-label="Close Claude connection"
            onClick={onClose}
          >
            <Icon name="x" />
          </button>
        </header>
        <ClaudeAuthContent controller={controller} />
      </section>
    </div>,
    document.body,
  );
}
export function ClaudeAuthButton({ label = "Connect Claude" }: { label?: string }) {
  const [controller, setController] = useState<ClaudeAuthController | null>(null);
  const active = useRef<ClaudeAuthController | null>(null);
  const [knownConnected, setKnownConnected] = useState(false);
  const initialRead = useRef<AbortController | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const request = new AbortController();
    initialRead.current = request;
    void getClaudeAuth(request.signal).then((result) => {
      if (!request.signal.aborted)
        setKnownConnected(result.isOk() && result.value.status === "connected");
    });
    return () => {
      request.abort();
      active.current?.dispose();
    };
  }, []);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="text-action"
        title={knownConnected ? "Claude connection · connected" : "Claude connection"}
        onClick={() => {
          if (active.current !== null) return;
          initialRead.current?.abort();
          const popup = knownConnected ? null : reserveConsentWindow();
          const next = createClaudeAuthController();
          active.current = next;
          setController(next);
          if (popup !== null) void next.enter(popup);
          else void next.start();
        }}
      >
        {label}
      </button>
      {controller !== null && (
        <ClaudeAuthDialog
          controller={controller}
          onClose={() => {
            setKnownConnected(controller.snapshot.view?.status === "connected");
            controller.dispose();
            active.current = null;
            setController(null);
            trigger.current?.focus();
          }}
        />
      )}
    </>
  );
}
