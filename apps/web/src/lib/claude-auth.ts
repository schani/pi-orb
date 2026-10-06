import type { ClaudeAuthView } from "@pi-orb/protocol";
import type { Result } from "neverthrow";
import { type ApiError, describeApiError } from "./api.ts";
import {
  type ConsentWindow,
  type ConsentWindowError,
  consentUrl,
} from "./claude-consent-window.ts";

export type ClaudeAuthAction = "connect" | "code" | "cancel" | "disconnect";
export interface ClaudeAuthSnapshot {
  view: ClaudeAuthView | null;
  pending: boolean;
  completing: boolean;
  error: string | null;
  launchError?: ConsentWindowError | null;
}
interface Dependencies {
  read(signal: AbortSignal): Promise<Result<ClaudeAuthView, ApiError>>;
  write(
    action: ClaudeAuthAction,
    code: string | undefined,
    signal: AbortSignal,
  ): Promise<Result<ClaudeAuthView, ApiError>>;
  visible(): boolean;
  schedule(callback: () => void): () => void;
}

/** One owner-scoped flow; reads never overlap mutations or survive their fence. */
export class ClaudeAuthController {
  snapshot: ClaudeAuthSnapshot = {
    view: null,
    pending: false,
    completing: false,
    error: null,
  };
  private listeners = new Set<() => void>();
  private epoch = 0;
  private disposed = false;
  private request: AbortController | null = null;
  private cancelTimer: (() => void) | null = null;
  private writing = false;
  private entering = false;
  private consentWindow: ConsentWindow | null = null;
  private launched = false;
  private readonly deps: Dependencies;
  constructor(deps: Dependencies) {
    this.deps = deps;
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private publish(update: Partial<ClaudeAuthSnapshot>) {
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) listener();
  }
  private fence() {
    this.epoch++;
    this.request?.abort();
    this.request = null;
    this.cancelTimer?.();
    this.cancelTimer = null;
  }
  private awaitingConsentWindow() {
    return this.consentWindow !== null && !this.launched;
  }
  private schedule() {
    if (
      !this.disposed &&
      (this.deps.visible() || this.awaitingConsentWindow()) &&
      this.snapshot.view?.status === "connecting" &&
      this.snapshot.error === null
    )
      this.cancelTimer = this.deps.schedule(() => {
        this.cancelTimer = null;
        void this.start();
      });
  }
  private closeConsentWindow() {
    this.consentWindow?.close();
    this.consentWindow = null;
  }
  private updateConsentWindow() {
    const view = this.snapshot.view;
    if (this.snapshot.error !== null) {
      this.closeConsentWindow();
      return;
    }
    if (view?.status !== "connecting") {
      if (!this.entering) {
        this.closeConsentWindow();
        this.publish({ launchError: null });
      }
      return;
    }
    if (this.launched || this.snapshot.completing || !view.challenge?.url) return;
    this.launched = true;
    const url = consentUrl(view.challenge.url);
    if (url === null) {
      this.closeConsentWindow();
      this.publish({ launchError: { type: "invalid_consent_url" } });
      return;
    }
    const result = this.consentWindow?.navigate(url);
    if (result?.isErr()) {
      this.closeConsentWindow();
      this.publish({ launchError: result.error });
    }
  }
  /** Only an explicit click supplies a reserved tab and admits a connection. */
  async enter(popup: Result<ConsentWindow, ConsentWindowError>, replace = false) {
    if (this.disposed || this.writing || this.request || this.entering) {
      if (popup.isOk()) popup.value.close();
      return;
    }
    this.closeConsentWindow();
    this.consentWindow = popup.isOk() ? popup.value : null;
    this.launched = false;
    this.entering = true;
    this.publish({ error: null, launchError: popup.isErr() ? popup.error : null });
    const epoch = this.epoch;
    if (!replace) await this.start(true);
    if (this.disposed || epoch !== this.epoch) return;
    if (
      this.snapshot.error === null &&
      (replace ||
        this.snapshot.view?.status === "disconnected" ||
        this.snapshot.view?.status === "failed")
    ) {
      await this.act("connect");
    }
    if (this.disposed) return;
    this.entering = false;
    this.updateConsentWindow();
  }
  async start(explicitEntry = false) {
    if (
      this.disposed ||
      this.writing ||
      this.request ||
      (!explicitEntry && !this.deps.visible() && !this.awaitingConsentWindow())
    )
      return;
    this.cancelTimer?.();
    this.cancelTimer = null;
    const epoch = this.epoch;
    const request = new AbortController();
    this.request = request;
    this.publish({ pending: this.snapshot.view === null });
    const result = await this.deps.read(request.signal);
    if (this.disposed || epoch !== this.epoch) return;
    this.request = null;
    this.publish(
      result.isOk()
        ? {
            view: result.value,
            pending: false,
            completing: this.snapshot.completing && result.value.status === "connecting",
            error: null,
          }
        : { pending: false, error: describeApiError(result.error) },
    );
    this.updateConsentWindow();
    this.schedule();
  }
  async act(action: ClaudeAuthAction, code?: string) {
    if (this.disposed || this.writing || (action === "code" && this.snapshot.completing)) return;
    if (action === "cancel" || action === "disconnect") {
      this.entering = false;
      this.closeConsentWindow();
    }
    this.fence();
    const epoch = this.epoch;
    this.writing = true;
    const request = new AbortController();
    this.request = request;
    this.publish({
      pending: true,
      completing: action === "code",
      error: null,
      view:
        action === "connect" || action === "cancel" || action === "disconnect"
          ? null
          : this.snapshot.view,
    });
    const result = await this.deps.write(action, code, request.signal);
    if (this.disposed || epoch !== this.epoch) return;
    this.writing = false;
    this.request = null;
    this.publish(
      result.isOk()
        ? {
            view: result.value,
            pending: false,
            completing: action === "code" && result.value.status === "connecting",
            error: null,
          }
        : { pending: false, completing: false, error: describeApiError(result.error) },
    );
    this.updateConsentWindow();
    this.schedule();
  }
  visibilityChanged() {
    if (this.writing || this.entering || this.awaitingConsentWindow()) return;
    if (!this.deps.visible()) {
      this.fence();
      this.publish({ pending: false });
    } else void this.start();
  }
  dispose() {
    this.disposed = true;
    this.closeConsentWindow();
    this.fence();
    this.listeners.clear();
  }
}
