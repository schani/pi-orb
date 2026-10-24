import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type ConversationId,
  createSession,
  type DocumentWatch,
  InboxDoc,
  type InboxState,
  MemoryStorage,
  type Session,
  type SubmissionId,
  type TaskId,
  type TaskRecord,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
  type WatchEnd,
} from "@earendil-works/pi-durable";
import { expect } from "vitest";
import { ChildReceipts, createSubagentTools } from "../subagents.ts";

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

export const wait = createSubagentTools(() => {
  expect.fail("Unexpected child cancellation");
}).find((tool) => tool.name === "get_subagent_result") as ToolRegistration;
export const waitArgs = { agent_id: "child", wait: true };
export function toolData(value: ToolExecutionResult) {
  return JSON.parse(value.output?.find((block) => block.type === "text")?.text ?? "");
}

/** Native inbox watch; only the child waiter and injected boundary failures are controlled. */
export class WaitBoundary {
  private readonly session: Session;

  private constructor(session: Session, conversationId: ConversationId) {
    this.session = session;
    this.api = { ...this.api, conversationId };
    this.child = { ...this.child, conversationId };
  }

  static async open() {
    const session = createSession(new MemoryStorage(), { now: () => 0 });
    const conversationId = await session.commit(async (tx) => {
      const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
      await tx.doc(InboxDoc, conversation.id);
      return conversation.id;
    }, BACKGROUND_CONTEXT);
    return new WaitBoundary(session, conversationId);
  }

  async [Symbol.asyncDispose]() {
    this.complete();
    await this.session.close(BACKGROUND_CONTEXT);
  }

  child: Child = {
    id: 7 as TaskId<JsonValue>,
    conversationId: 0 as ConversationId,
    kind: "orb.child",
    version: 1,
    input: null,
    background: true,
    abortRequested: false,
    state: { status: "running", checkpoint: { phase: "run", child: 2 } },
  };
  readonly watches = new Map<DocumentWatch<InboxState>, (end: WatchEnd) => void>();
  readonly waiters = new Set<ReturnType<typeof deferred<Child>>>();
  readonly registered = deferred();
  acquisitions = 0;
  waitCalls = 0;
  cancelCalls = 0;
  afterAcquire: () => Promise<void> = async () => {};
  acquireFailure: unknown;
  startFailure: unknown;
  stopFailure: unknown;
  stopEnd: WatchEnd = { reason: "stopped" };
  readFailure: unknown;
  waitFailure: unknown;

  readonly api = {
    now: () => 0,
    conversationId: 0 as ConversationId,
    taskId: 9 as TaskId,
    callId: "wait",
    models: createModels(),
    output: () => {},
    snapshot: async (token: unknown, id: unknown) => {
      expect(id).toBe(this.api.conversationId);
      expect(token).toBe(ChildReceipts);
      return { children: { child: { anchor: 7, prompt: "work", description: "leaf" } } };
    },
    getTask: async (id: TaskId) => {
      expect(id).toBe(this.child.id);
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
      expect(id).toBe(this.api.conversationId);
      if (this.acquireFailure) throw this.acquireFailure;
      this.acquisitions++;
      const native = await this.session.watchDoc(InboxDoc, this.api.conversationId, ctx);
      if (!native) throw new Error("Missing native inbox watch");
      const closed = deferred<WatchEnd>();
      void native.closed.then(closed.resolve);
      const watch: DocumentWatch<InboxState> = {
        get value() {
          return native.value;
        },
        closed: closed.promise,
        start: (callback) => {
          if (this.startFailure) throw this.startFailure;
          native.start(callback);
        },
        stop: async () => {
          closed.resolve(this.stopEnd);
          await native.stop();
          if (this.stopFailure) throw this.stopFailure;
          return closed.promise;
        },
      };
      this.watches.set(watch, (reason) => {
        closed.resolve(reason);
        void native.stop();
      });
      void closed.promise.then(() => this.watches.delete(watch));
      await this.afterAcquire();
      return watch;
    },
  } as unknown as ToolExecutionApi;

  async queue(mode: "steer" | "followUp" | "write") {
    await this.session.commit(async (tx) => {
      const inbox = await tx.doc(InboxDoc, this.api.conversationId);
      const id = (inbox.items.length + 1) as SubmissionId;
      inbox.items.push(
        mode === "write"
          ? { id, mode, entry: { kind: "passive" } }
          : { id, mode, content: [{ type: "text", text: "input" }] },
      );
    }, BACKGROUND_CONTEXT);
  }

  get inbox() {
    return this.session.snapshot(InboxDoc, this.api.conversationId, BACKGROUND_CONTEXT);
  }

  close(reason: WatchEnd) {
    for (const end of this.watches.values()) end(reason);
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
