import { type AgentSessionEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ServerFrame } from "@pi-orb/protocol";
import { expect, it } from "vitest";
import { MemoryIdleStopFence } from "../testkit/idle-stop-fence.ts";
import { PiOrbAgent, type PiSession } from "./agent.ts";

function fixture(ready = true) {
  let resolve: (() => void) | undefined;
  let reject: ((error: Error) => void) | undefined;
  const drain = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  let aborts = 0;
  let instructions: string | undefined;
  let listener: ((event: AgentSessionEvent) => void) | undefined;
  const session = {
    isIdle: true,
    pendingMessageCount: 0,
    subscribe: (callback: (event: AgentSessionEvent) => void) => {
      listener = callback;
      return () => undefined;
    },
    compact: async (custom?: string) => {
      instructions = custom;
      await drain;
      return {};
    },
    abortCompaction: () => {
      aborts++;
    },
    waitForIdle: async () => {},
    abort: async () => {},
  } as unknown as PiSession;
  const manager = SessionManager.inMemory("/test");
  const agent = new PiOrbAgent({
    orbId: "compact",
    repositoryUrl: "https://example.com/repo",
    workDir: "/test",
    skillsDir: null,
    broker: null,
    executionId: "execution",
    idleStopFence: new MemoryIdleStopFence(),
  });
  if (ready)
    agent.attachSession(session, manager, {
      summarize: () => {
        throw new Error("no Luna for compact");
      },
    });
  const frames: ServerFrame[] = [];
  agent.subscribe((frame) => frames.push(frame));
  return {
    agent,
    session,
    manager,
    frames,
    resolve: () => resolve?.(),
    reject: () => reject?.(new Error("summary unavailable")),
    aborts: () => aborts,
    instructions: () => instructions,
    emit: (event: AgentSessionEvent) => listener?.(event),
  };
}

it("claims busy synchronously, fences every ingress and stays busy while Pi appears idle", async () => {
  const f = fixture();
  const completion = f.agent.compact("retain decisions", "operation");
  expect(f.agent.gateView()).toMatchObject({ activity: "busy", activeOperationId: "operation" });
  expect(f.agent.snapshot()._unsafeUnwrap()).toMatchObject({
    work: "compaction",
    compactionAfterId: null,
  });
  expect(f.agent.prepareIdleStop()._unsafeUnwrap()).toBe(false);
  expect(f.agent.admitSubagent("child").isErr()).toBe(true);
  expect(
    (await f.agent.submitMessage([{ type: "text", text: "parallel" }], "parallel")).isErr(),
  ).toBe(true);
  expect(
    (
      await f.agent.deliverInboxMessage("inbox", ["inbox"], [{ type: "text", text: "parallel" }])
    ).isErr(),
  ).toBe(true);
  expect((await f.agent.compact(undefined, "second"))._unsafeUnwrapErr()).toMatchObject({
    code: "busy",
  });
  f.resolve();
  expect((await completion).isOk()).toBe(true);
  expect(f.instructions()).toBe("retain decisions");
  expect(f.agent.gateView().activity).toBe("idle");
  expect(f.frames).toContainEqual(
    expect.objectContaining({
      event: { type: "operation_finished", operationId: "operation", outcome: "completed" },
    }),
  );
});
it("captures the published transcript frontier once at admission", async () => {
  const f = fixture();
  const before = f.manager.appendMessage({ role: "user", content: "before", timestamp: 1 });
  f.emit({ type: "entry_appended" } as AgentSessionEvent);
  const completion = f.agent.compact(undefined, "operation");
  expect(f.agent.snapshot()._unsafeUnwrap().compactionAfterId).toBe(before);
  f.manager.appendCustomEntry("pi-orb.test", { later: true });
  f.emit({ type: "entry_appended" } as AgentSessionEvent);
  expect(f.agent.snapshot()._unsafeUnwrap().compactionAfterId).toBe(before);
  expect(f.frames).toContainEqual(
    expect.objectContaining({
      event: {
        type: "status",
        activity: "busy",
        operationId: "operation",
        work: "compaction",
        compactionAfterId: before,
      },
    }),
  );
  f.resolve();
  await completion;
});

it("Abort explicitly cancels compaction but does not release ownership before its promise drains", async () => {
  const f = fixture();
  const completion = f.agent.compact(undefined, "operation");
  expect((await f.agent.abortOperation()).isOk()).toBe(true);
  expect(f.aborts()).toBe(1);
  // SDK compact() allocates its abort controller after its initial abort await.
  f.emit({ type: "compaction_start", reason: "manual" });
  expect(f.aborts()).toBe(2);
  f.emit({ type: "agent_settled" });
  await Promise.resolve();
  expect(f.agent.gateView().activity).toBe("busy");
  f.reject();
  expect((await completion)._unsafeUnwrapErr()).toEqual({
    code: "internal",
    message: "summary unavailable",
  });
  expect(f.agent.gateView().activity).toBe("idle");
  expect(f.agent.snapshot()._unsafeUnwrap().records).toContainEqual(
    expect.objectContaining({
      eventType: "agent.compaction",
      compaction: expect.objectContaining({ outcome: "aborted" }),
    }),
  );
});
it("settled SDK failure is durable and visible without leaving an invented assistant turn", async () => {
  const f = fixture();
  const completion = f.agent.compact(undefined, "operation");
  f.reject();
  expect((await completion)._unsafeUnwrapErr()).toEqual({
    code: "internal",
    message: "summary unavailable",
  });
  expect(f.agent.gateView().activity).toBe("idle");
  expect(f.agent.snapshot()._unsafeUnwrap().records).toContainEqual(
    expect.objectContaining({
      eventType: "agent.compaction",
      compaction: expect.objectContaining({ outcome: "failed" }),
    }),
  );
});
it("retains busy admission when compaction cannot be made durable", async () => {
  const f = fixture();
  f.manager.getSessionFile = () => "/missing/compact-session.jsonl";
  const completion = f.agent.compact(undefined, "operation");
  f.resolve();
  expect((await completion)._unsafeUnwrapErr()).toMatchObject({ code: "internal" });
  expect(f.agent.getHealth()).toMatchObject({
    status: "failed",
    error: { code: "compaction_persistence_failed" },
  });
  expect(f.agent.gateView().activity).toBe("busy");
  expect((await f.agent.submitMessage([{ type: "text", text: "unsafe" }], "new")).isErr()).toBe(
    true,
  );
  expect(
    f.frames.some(
      (frame) => frame.type === "runtime.event" && frame.event.type === "operation_finished",
    ),
  ).toBe(false);
});
it("native extension cancellation is a durable aborted outcome", async () => {
  const f = fixture();
  const completion = f.agent.compact(undefined, "operation");
  f.emit({
    type: "compaction_end",
    reason: "manual",
    result: undefined,
    aborted: true,
    willRetry: false,
  });
  f.reject();
  expect((await completion)._unsafeUnwrapErr()).toEqual({
    code: "internal",
    message: "summary unavailable",
  });
  expect(f.agent.snapshot()._unsafeUnwrap().records).toContainEqual(
    expect.objectContaining({ compaction: expect.objectContaining({ outcome: "aborted" }) }),
  );
});
it("does not compact a nominally idle SDK with pending native input", async () => {
  const f = fixture();
  Object.defineProperty(f.session, "pendingMessageCount", { value: 1 });
  expect((await f.agent.compact(undefined, "operation"))._unsafeUnwrapErr()).toMatchObject({
    code: "busy",
  });
  expect(f.agent.gateView().activity).toBe("idle");
});

it("retains unsupported admission without a ready session", async () => {
  const f = fixture(false);
  expect((await f.agent.compact(undefined, "operation"))._unsafeUnwrapErr()).toEqual({
    code: "unsupported",
    message: "Compaction requires a ready runtime.",
  });
});

it.each(["drain", "outcome", "session-file", "fsync", "publication"] as const)(
  "%s uncertainty emits one safe error and retains the compaction hold",
  async (failure) => {
    const f = fixture();
    const secret = "secret-provider-token-and-transcript";
    if (failure === "drain")
      f.session.waitForIdle = async () => {
        throw new Error(secret);
      };
    if (failure === "outcome")
      f.manager.appendCustomEntry = () => {
        throw new Error(secret);
      };
    if (failure === "session-file")
      f.manager.getSessionFile = () => {
        throw new Error(secret);
      };
    if (failure === "fsync") f.manager.getSessionFile = () => `/missing/${secret}.jsonl`;
    if (failure === "publication")
      f.manager.getEntries = () => {
        throw new Error(secret);
      };
    const completion = f.agent.compact(undefined, "operation");
    if (failure === "outcome") f.reject();
    else f.resolve();
    expect((await completion)._unsafeUnwrapErr()).toMatchObject({ code: "internal" });
    expect(f.frames.filter((frame) => frame.type === "server.error")).toEqual([
      {
        v: 1,
        type: "server.error",
        at: expect.any(String),
        error: {
          code: "internal",
          message: "Context compaction could not be safely completed; restart required.",
          retryable: false,
        },
      },
    ]);
    expect(f.agent.getHealth()).toMatchObject({
      status: "failed",
      error: {
        code: failure === "drain" ? "compaction_drain_failed" : "compaction_persistence_failed",
      },
    });
    expect(f.agent.gateView()).toMatchObject({ activity: "busy", activeOperationId: "operation" });
    expect(f.agent.prepareIdleStop().isErr()).toBe(true);
    expect(f.agent.admitSubagent("child").isErr()).toBe(true);
    expect((await f.agent.submitMessage([{ type: "text", text: "unsafe" }], "new")).isErr()).toBe(
      true,
    );
    expect(
      f.frames.some(
        (frame) => frame.type === "runtime.event" && frame.event.type === "operation_finished",
      ),
    ).toBe(false);
  },
);
