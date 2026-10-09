import type { ClientAction, RequestResultFrame, ServerFrame } from "@pi-orb/protocol";
import { err, errAsync, ok, okAsync, ResultAsync } from "neverthrow";
import type { AgentSessionFacade, AgentSnapshot } from "../../domain/agent-ports.ts";
import type { RuntimeClientError } from "../../domain/errors.ts";

/** Process-local conversation identity; subscriptions never capture a replaceable Harness. */
export class StableAgentHandle implements AgentSessionFacade {
  readonly runtimeInstanceId: string;
  private loaded: AgentSessionFacade | null = null;
  private cached: AgentSnapshot | null = null;
  private detach: () => void = () => undefined;
  private readonly listeners = new Map<(frame: ServerFrame) => void, (() => void) | undefined>();
  private generation = 0;
  private disposed = false;
  private admissions: Promise<void> = Promise.resolve();
  private readonly load: () => ResultAsync<AgentSessionFacade, RuntimeClientError>;
  private readonly read: (() => ResultAsync<AgentSnapshot, RuntimeClientError>) | undefined;
  private readonly cancel:
    | ((
        operationId: string,
      ) => ResultAsync<"cancelled" | "active" | "missing" | undefined, RuntimeClientError>)
    | undefined;
  constructor(
    orbId: string,
    load: () => ResultAsync<AgentSessionFacade, RuntimeClientError>,
    read?: () => ResultAsync<AgentSnapshot, RuntimeClientError>,
    cancel?: (
      operationId: string,
    ) => ResultAsync<"cancelled" | "active" | "missing" | undefined, RuntimeClientError>,
  ) {
    this.load = load;
    this.read = read;
    this.cancel = cancel;
    this.runtimeInstanceId = `conversation:${orbId}`;
  }

  attach(session: AgentSessionFacade): void {
    if (this.disposed) return;
    this.detach();
    this.loaded = session;
    const generation = ++this.generation;
    const snapshot = session.snapshot();
    if (snapshot.isOk()) this.setSnapshot(snapshot.value);
    this.detach = session.subscribe(
      (frame) => {
        if (this.disposed || this.generation !== generation) return;
        const current = session.snapshot();
        if (current.isOk()) this.setSnapshot(current.value);
        for (const listener of this.listeners.keys()) listener(frame);
      },
      () => {
        if (this.generation === generation) this.unload();
      },
    );
  }

  unload(): void {
    this.generation++;
    this.detach();
    this.detach = () => undefined;
    this.loaded = null;
    if (this.cached) this.cached = { ...this.cached, activity: "idle" };
  }

  setSnapshot(snapshot: AgentSnapshot): void {
    this.cached = { ...snapshot, records: [] };
  }
  readSnapshot() {
    if (this.loaded) {
      const snapshot = this.loaded.snapshot();
      return snapshot.isOk()
        ? okAsync(snapshot.value)
        : errAsync<AgentSnapshot, RuntimeClientError>({
            type: "runtime_client_error",
            code: "history_unavailable",
            answered: true,
            retryable: true,
            message: snapshot.error.message,
          });
    }
    if (this.read) return this.read();
    return this.cached
      ? okAsync(this.cached)
      : errAsync<AgentSnapshot, RuntimeClientError>({
          type: "runtime_client_error",
          code: "history_unavailable",
          answered: true,
          retryable: true,
          message: "Conversation snapshot unavailable",
        });
  }
  snapshot() {
    return (
      this.loaded?.snapshot() ??
      (this.cached ? ok(this.cached) : err({ message: "conversation snapshot unavailable" }))
    );
  }
  liveView() {
    return this.loaded?.liveView() ?? null;
  }
  workActive() {
    return this.loaded?.workActive?.() ?? false;
  }
  subscribe(listener: (frame: ServerFrame) => void, onInvalidated?: () => void): () => void {
    if (this.disposed) {
      onInvalidated?.();
      return () => undefined;
    }
    this.listeners.set(listener, onInvalidated);
    return () => {
      this.listeners.delete(listener);
    };
  }
  admit<T>(
    operation: () => ResultAsync<T, RuntimeClientError>,
  ): ResultAsync<T, RuntimeClientError> {
    const result = this.admissions.then(() =>
      this.disposed
        ? err<T, RuntimeClientError>({
            type: "runtime_client_error",
            code: "cancelled",
            answered: true,
            retryable: false,
            message: "conversation disposed",
          })
        : operation(),
    );
    this.admissions = result.then(
      () => undefined,
      () => undefined,
    );
    return ResultAsync.fromPromise(
      result,
      (): RuntimeClientError => ({
        type: "runtime_client_error",
        code: "history_unavailable",
        answered: true,
        retryable: false,
        message: "conversation admission failed",
      }),
    ).andThen((value) => value);
  }

  request(
    requestId: string,
    action: ClientAction,
  ): ResultAsync<RequestResultFrame["result"], RuntimeClientError> {
    if (this.disposed)
      return errAsync({
        type: "runtime_client_error",
        code: "history_unavailable",
        answered: true,
        retryable: false,
        message: "conversation disposed",
      });
    if (action.type === "abort") {
      return (this.cancel?.(action.operationId) ?? okAsync(undefined)).andThen((outcome) => {
        if (outcome === "cancelled")
          return okAsync({
            type: "accepted" as const,
            operationId: action.operationId,
            duplicate: false,
          });
        if (outcome === "missing")
          return okAsync({
            type: "rejected" as const,
            error: {
              code: "stale_operation" as const,
              message: "Pending operation changed",
              retryable: false,
            },
          });
        return this.loaded
          ? this.loaded.request(requestId, action)
          : errAsync({
              type: "runtime_client_error" as const,
              code: "history_unavailable" as const,
              answered: true,
              retryable: true,
              message: "No active agent operation",
            });
      });
    }
    return this.admit(() =>
      this.load().andThen((session) => {
        if (this.disposed)
          return errAsync<RequestResultFrame["result"], RuntimeClientError>({
            type: "runtime_client_error",
            code: "cancelled",
            answered: true,
            retryable: false,
            message: "conversation disposed",
          });
        if (this.loaded !== session) this.attach(session);
        return session.request(requestId, action);
      }),
    );
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unload();
    for (const invalidate of this.listeners.values()) invalidate?.();
    this.listeners.clear();
    this.cached = null;
  }
}
