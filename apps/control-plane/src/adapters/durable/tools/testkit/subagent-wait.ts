import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type DocumentWatch,
  InboxDoc,
  type InboxState,
  ROOT_CONVERSATION_ID,
  type TaskId,
  type TaskRecord,
  type ToolExecutionApi,
  type WatchEnd,
} from "@earendil-works/pi-durable";
import { expect } from "vitest";
import { ChildReceipts } from "../subagents.ts";

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

type Child = TaskRecord<JsonValue, JsonValue, JsonValue>;
type Listener = Parameters<DocumentWatch<InboxState>["start"]>[0];

/**
 * Exact pi-durable 1.1 watch boundary: acquisition atomically attaches and
 * snapshots; later revisions buffer until start; listeners never run inline.
 * No task cancellation is coupled to cancellation of an observing context.
 */
export class WaitBoundary {
  inbox: InboxState = { items: [] };
  child: Child = {
    id: 7 as TaskId<JsonValue>,
    conversationId: ROOT_CONVERSATION_ID,
    kind: "orb.child",
    version: 1,
    input: null,
    background: true,
    abortRequested: false,
    state: { status: "running", checkpoint: { phase: "run", child: 2 } },
  };
  readonly watches = new Set<DocumentWatch<InboxState>>();
  readonly waiters = new Set<ReturnType<typeof deferred<Child>>>();
  readonly registered = deferred();
  readonly acquired = deferred();
  readonly started = deferred();
  readonly localCancelled = deferred();
  readonly diagnostics: unknown[] = [];
  acquisitions = 0;
  stops = 0;
  taskReads = 0;
  waitCalls = 0;
  cancelCalls = 0;
  beforeAcquire: () => Promise<void> = async () => {};
  afterAcquire: () => Promise<void> = async () => {};
  beforeRead: () => Promise<void> = async () => {};
  acquireFailure: unknown;
  startFailure: unknown;
  stopFailure: unknown;
  stopEnd: WatchEnd = { reason: "stopped" };
  readFailure: unknown;
  waitFailure: unknown;
  private readonly publications = new Map<DocumentWatch<InboxState>, (value: InboxState) => void>();
  private readonly ends = new Map<DocumentWatch<InboxState>, (end: WatchEnd) => void>();

  readonly api = {
    conversationId: ROOT_CONVERSATION_ID,
    taskId: 9 as TaskId,
    callId: "wait",
    models: createModels(),
    output: () => {},
    diagnostic: (value: unknown) => this.diagnostics.push(value),
    snapshot: async (token: unknown, id: unknown) => {
      expect(id).toBe(ROOT_CONVERSATION_ID);
      if (token === ChildReceipts)
        return { children: { child: { anchor: 7, prompt: "work", description: "leaf" } } };
      expect(token).toBe(InboxDoc);
      return structuredClone(this.inbox);
    },
    // Codemode's ordinary store boundary, not a yield propagation mechanism.
    commit: async (change: (tx: unknown) => unknown) => change({ doc: async () => ({}) }),
    getTask: async (id: TaskId) => {
      expect(id).toBe(this.child.id);
      this.taskReads++;
      await this.beforeRead();
      if (this.readFailure) throw this.readFailure;
      return this.child;
    },
    waitForTask: async (id: TaskId, ctx: Context) => {
      expect(id).toBe(this.child.id);
      this.waitCalls++;
      this.registered.resolve();
      if (this.waitFailure) throw this.waitFailure;
      if (this.child.state.status === "terminal") return this.child;
      const waiter = deferred<Child>();
      const cancel = () => {
        this.cancelCalls++;
        this.localCancelled.resolve();
        waiter.reject(ctx.abortSignal?.reason ?? new Error("cancelled"));
      };
      this.waiters.add(waiter);
      ctx.abortSignal?.addEventListener("abort", cancel, { once: true });
      if (ctx.abortSignal?.aborted) cancel();
      try {
        return await waiter.promise;
      } finally {
        this.waiters.delete(waiter);
        ctx.abortSignal?.removeEventListener("abort", cancel);
      }
    },
    watchDoc: async (token: unknown, id: unknown, ctx: Context) => {
      expect(token).toBe(InboxDoc);
      expect(id).toBe(ROOT_CONVERSATION_ID);
      await this.beforeAcquire();
      if (this.acquireFailure) throw this.acquireFailure;
      this.acquisitions++;
      let value = structuredClone(this.inbox);
      let listener: Listener | undefined;
      let ended = false;
      let draining = false;
      const pending: InboxState[] = [];
      const closed = deferred<WatchEnd>();
      const end = (reason: WatchEnd) => {
        if (ended) return;
        ended = true;
        pending.length = 0;
        this.watches.delete(watch);
        this.publications.delete(watch);
        this.ends.delete(watch);
        ctx.abortSignal?.removeEventListener("abort", cancel);
        closed.resolve(reason);
      };
      const cancel = () => end({ reason: "cancelled" });
      const drain = async () => {
        if (draining || !listener || ended) return;
        draining = true;
        try {
          while (pending.length && !ended) {
            const next = pending.shift();
            if (!next) break;
            value = next;
            await listener(value, [["r", value]], BACKGROUND_CONTEXT);
          }
        } catch (error) {
          end({ reason: "listener_error", error: error as Error });
        } finally {
          draining = false;
        }
      };
      const schedule = () => queueMicrotask(() => void drain());
      const watch: DocumentWatch<InboxState> = {
        get value() {
          return value;
        },
        closed: closed.promise,
        start: (callback) => {
          if (this.startFailure) throw this.startFailure;
          if (ended || listener) throw new Error("watch cannot start");
          listener = callback;
          this.started.resolve();
          schedule();
        },
        stop: async () => {
          this.stops++;
          end(this.stopEnd);
          if (this.stopFailure) throw this.stopFailure;
          return closed.promise;
        },
      };
      // No await between the acquisition value and registration.
      this.watches.add(watch);
      this.publications.set(watch, (revision) => {
        pending.push(structuredClone(revision));
        if (listener) schedule();
      });
      this.ends.set(watch, end);
      ctx.abortSignal?.addEventListener("abort", cancel, { once: true });
      if (ctx.abortSignal?.aborted) cancel();
      this.acquired.resolve();
      await this.afterAcquire();
      return watch;
    },
  } as unknown as ToolExecutionApi;

  queue(mode: "steer" | "followUp" | "write") {
    const id = this.inbox.items.length + 1;
    this.inbox = {
      items: [
        ...this.inbox.items,
        mode === "write"
          ? { id, mode, entry: { kind: "passive" } }
          : { id, mode, content: [{ type: "text", text: "input" }] },
      ],
    } as InboxState;
    for (const publish of this.publications.values()) publish(this.inbox);
  }

  close(reason: WatchEnd) {
    for (const end of [...this.ends.values()]) end(reason);
  }

  complete() {
    const { memos: _memos, ...record } = this.child;
    this.child = {
      ...record,
      state: {
        status: "terminal",
        outcome: { status: "completed", result: { output: "later receipt" } },
      },
    };
    for (const waiter of this.waiters) waiter.resolve(this.child);
  }
}
