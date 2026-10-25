import { EventEmitter } from "node:events";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, it, vi } from "vitest";
import {
  background,
  ComposedClaudeFixture,
  childEdge,
  nativeHook,
  rootRequest,
  rootResult,
} from "../testkit/claude-composed.ts";

const processFixture = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: processFixture.spawn,
}));

function observeExit(f: ComposedClaudeFixture, code: number | null, signal: string | null) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: Object.assign(new EventEmitter(), { setEncoding() {} }),
  });
  processFixture.spawn.mockReturnValue(child);
  f.query.options.spawnClaudeCodeProcess?.({
    command: "controlled",
    args: [],
    cwd: f.dir,
    env: {},
    signal: new AbortController().signal,
  });
  child.emit("exit", code, signal);
  child.stdout.emit("end");
}

const content = [{ type: "text" as const, text: "hello" }];
const shutdowns = new WeakMap<object, Promise<void>>();
const failed = (subtype = "success", is_error = true) =>
  ({
    ...rootResult,
    uuid: "failed-result",
    subtype,
    is_error,
    errors: [],
    result: "API error",
  }) as unknown as SDKMessage;

async function start(f: ComposedClaudeFixture) {
  expect((await f.attach()).isOk()).toBe(true);
  expect((await f.agent.deliverInboxMessage("first", ["first"], content)).isOk()).toBe(true);
  const input = await f.query.input.next();
  if (input.done || input.value.uuid === undefined) throw new Error("Native input missing.");
  f.receipt(input.value);
  f.query.interruptReceipt = { still_queued: [], cancelled: [] };
  const request = f.query.requestShutdown.bind(f.query);
  shutdowns.set(
    f.query,
    new Promise<void>((resolve) => {
      vi.spyOn(f.query, "requestShutdown").mockImplementation(() => {
        const result = request();
        resolve();
        return result;
      });
    }),
  );
  return { ...input.value, uuid: input.value.uuid };
}
function requested(f: ComposedClaudeFixture) {
  return shutdowns.get(f.query);
}
async function drain(f: ComposedClaudeFixture) {
  f.query.exit();
  f.query.endOutput();
  await f.agent.closeExtensions();
}
function finished(f: ComposedClaudeFixture) {
  return f.history.view.filter(
    (r) => r.type === "event" && r.eventType === "claude.operation_finished",
  );
}
const interrupted = (f: ComposedClaudeFixture) =>
  f.history.view.filter((r) => r.type === "event" && r.eventType === "claude.handoff_interrupted");

it.each([
  ["success", true],
  ["error_during_execution", false],
  ["error_max_turns", false],
  ["error_max_budget_usd", false],
  ["error_max_structured_output_retries", false],
] as const)(
  "explicitly cancels terminal %s/%s without a quota-specific classifier",
  async (subtype, isError) => {
    const f = new ComposedClaudeFixture();
    try {
      await start(f);
      const interrupt = vi.spyOn(f.query, "interrupt");
      await f.query.emitUnscheduled(failed(subtype, isError));
      expect(interrupt).toHaveBeenCalledTimes(1);
      expect(interrupt).toHaveBeenCalledWith({ cancelQueued: true });
      await drain(f);
      expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
      expect(finished(f)).toMatchObject([
        {
          overflow: { outcome: "failed", cancellation: "drained", causeResultId: "failed-result" },
        },
      ]);
      expect(
        f.history.view.some(
          (r) =>
            r.type === "event" &&
            r.eventType === "claude.result_error" &&
            r.overflow.cancellation === "requested",
        ),
      ).toBe(true);
    } finally {
      await drain(f);
      f.dispose();
    }
  },
);

it("does not cancel a later successful steer merely because an earlier result failed", async () => {
  const f = new ComposedClaudeFixture();
  try {
    const first = await start(f);
    const interrupt = vi.spyOn(f.query, "interrupt");
    expect((await f.agent.deliverInboxMessage("steer", ["steer"], content)).isOk()).toBe(true);
    const next = await f.query.input.next();
    if (next.done) throw new Error("Steering input missing.");
    f.receipt(next.value);
    await f.query.emitUnscheduled({
      ...failed(),
      user_message_uuid: first.uuid,
      queued_turn_count: 1,
    } as SDKMessage);
    expect(interrupt).not.toHaveBeenCalled();
    expect(f.query.closeRequested).toBe(false);
    await f.query.emitUnscheduled(childEdge("task_started"));
    await f.query.emitUnscheduled(childEdge("task_notification"));
    await f.query.emitUnscheduled(rootRequest);
    await f.query.emitUnscheduled({
      ...rootResult,
      user_message_uuid: next.value.uuid,
    } as SDKMessage);
    expect(interrupt).not.toHaveBeenCalled();
    expect(interrupted(f)).toEqual([]);
    await drain(f);
    expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
    expect(finished(f)).toMatchObject([{ overflow: { outcome: "failed" } }]);
    expect(f.queries).toHaveLength(2);
  } finally {
    await drain(f);
    f.dispose();
  }
});

it("interrupts existing handoffs and those arriving while interrupt is pending, then admits a fresh turn", async () => {
  const f = new ComposedClaudeFixture();
  let release = () => {};
  const pending = new Promise<{ still_queued: string[]; cancelled: string[] }>((resolve) => {
    release = () => resolve({ still_queued: [], cancelled: [] });
  });
  try {
    await start(f);
    vi.spyOn(f.query, "interrupt").mockReturnValue(pending);
    await f.query.emitUnscheduled(childEdge("task_started"));
    await f.query.emitUnscheduled(childEdge("task_notification"));
    await f.query.emitUnscheduled({ ...childEdge("task_started"), task_id: "late" } as SDKMessage);
    await f.query.emitUnscheduled(failed());
    await f.query.emitUnscheduled({
      ...childEdge("task_notification"),
      task_id: "late",
    } as SDKMessage);
    expect(f.query.closeRequested).toBe(false);
    expect(f.agent.gateView().activity).toBe("busy");
    release();
    await pending;
    await drain(f);
    expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
    expect(f.journal().pendingHandoffs).toEqual({});
    expect(interrupted(f)).toHaveLength(2);
    expect((await f.agent.deliverInboxMessage("next", ["next"], content)).isOk()).toBe(true);
    expect(f.queries).toHaveLength(3);
    const next = await f.query.input.next();
    if (next.done) throw new Error("Next-turn input missing.");
    f.receipt(next.value);
    await f.query.emitUnscheduled(rootResult);
    await drain(f);
    expect(finished(f)).toMatchObject([
      { overflow: { outcome: "failed" } },
      { overflow: { outcome: "completed" } },
    ]);
  } finally {
    release();
    await drain(f);
    f.dispose();
  }
});

it.each(["inventory", "task", "hook"] as const)(
  "retains independent %s ownership with visible failure after cancellation",
  async (hold) => {
    const f = new ComposedClaudeFixture();
    try {
      await start(f);
      if (hold === "inventory")
        await f.query.emitUnscheduled(
          background([{ task_id: "independent", description: "child" }]),
        );
      if (hold === "task")
        await f.query.emitUnscheduled({
          ...childEdge("task_started"),
          task_id: "independent",
        } as SDKMessage);
      if (hold === "hook") await f.query.emitUnscheduled(nativeHook("independent"));
      await f.query.emitUnscheduled(failed());
      await drain(f);
      expect(f.agent.getHealth()).toMatchObject({
        status: "failed",
        error: {
          code:
            hold === "hook" ? "claude_hook_recovery_required" : "claude_child_recovery_required",
        },
      });
      expect(f.agent.gateView()).toMatchObject({ activity: "busy", acceptingWork: false });
      expect(finished(f)).toEqual([]);
      expect(
        f.history.view.some((r) => r.type === "event" && r.eventType === "claude.rotation_failed"),
      ).toBe(true);
      if (hold === "inventory")
        expect(f.journal().ownedBackgroundTasks).toHaveProperty("independent");
      if (hold === "task") expect(f.journal().ownedTasks).toHaveProperty("independent");
    } finally {
      await drain(f);
      f.dispose();
    }
  },
);

it("preserves explicit Abort precedence over failed-result cancellation", async () => {
  const f = new ComposedClaudeFixture();
  try {
    await start(f);
    const abort = f.agent.abortOperation();
    await f.query.emitUnscheduled(failed());
    await drain(f);
    expect((await abort).isOk()).toBe(true);
    expect(finished(f)).toMatchObject([{ overflow: { outcome: "aborted" } }]);
  } finally {
    await drain(f);
    f.dispose();
  }
});

it.each(["pending-steer", "native-queue"] as const)(
  "does not cancel while %s remains even when the other pending-input signal is empty",
  async (kind) => {
    const f = new ComposedClaudeFixture();
    try {
      await start(f);
      const interrupt = vi.spyOn(f.query, "interrupt");
      let steer: string | undefined;
      if (kind === "pending-steer") {
        expect((await f.agent.deliverInboxMessage("steer", ["steer"], content)).isOk()).toBe(true);
        const input = await f.query.input.next();
        if (input.done) throw new Error("Steering input missing.");
        f.receipt(input.value);
        steer = input.value.uuid;
      }
      await f.query.emitUnscheduled({
        ...failed(),
        queued_turn_count: kind === "native-queue" ? 1 : 0,
      } as SDKMessage);
      expect(interrupt).not.toHaveBeenCalled();
      expect(f.query.closeRequested).toBe(false);
      await f.query.emitUnscheduled({ ...rootResult, user_message_uuid: steer } as SDKMessage);
      expect(interrupt).not.toHaveBeenCalled();
      await drain(f);
      expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
      expect(finished(f)).toMatchObject([{ overflow: { outcome: "failed" } }]);
    } finally {
      await drain(f);
      f.dispose();
    }
  },
);

it("does not treat successful stop_sequence or an assistant error as a terminal failure", async () => {
  const f = new ComposedClaudeFixture();
  try {
    await start(f);
    const interrupt = vi.spyOn(f.query, "interrupt");
    await f.query.emitUnscheduled({
      type: "assistant",
      parent_tool_use_id: null,
      error: "rate_limit",
      uuid: "assistant-error",
      session_id: "session",
      message: { content: [{ type: "text", text: "API error" }] },
    } as unknown as SDKMessage);
    expect(interrupt).not.toHaveBeenCalled();
    await f.query.emitUnscheduled({ ...rootResult, stop_reason: "stop_sequence" } as SDKMessage);
    expect(interrupt).not.toHaveBeenCalled();
    await drain(f);
    expect(finished(f)).toMatchObject([{ overflow: { outcome: "completed" } }]);
  } finally {
    await drain(f);
    f.dispose();
  }
});

it.each(["unsupported", "still-queued", "rejected"] as const)(
  "fails visibly and retains ownership when cancellation is %s",
  async (kind) => {
    const f = new ComposedClaudeFixture();
    try {
      const input = await start(f);
      await f.query.emitUnscheduled(childEdge("task_started"));
      if (kind === "unsupported") f.query.interruptReceipt = undefined;
      if (kind === "still-queued")
        f.query.interruptReceipt = { still_queued: [input.uuid], cancelled: [] };
      if (kind === "rejected")
        vi.spyOn(f.query, "interrupt").mockRejectedValue(new Error("controlled failure"));
      await f.query.emitUnscheduled(failed());
      await drain(f);
      expect(f.agent.getHealth()).toMatchObject({
        status: "failed",
        error: { code: "claude_failure_cancellation_failed" },
      });
      expect(f.agent.gateView()).toMatchObject({ activity: "busy", acceptingWork: false });
      expect(f.journal().ownedTasks).toHaveProperty("child");
      expect(finished(f)).toEqual([]);
      expect(
        f.history.view.some(
          (r) =>
            r.type === "event" &&
            r.eventType === "claude.result_error" &&
            r.overflow.cancellation === "failed",
        ),
      ).toBe(true);
    } finally {
      await drain(f);
      f.dispose();
    }
  },
);

it("keeps late root work during failed-result shutdown fail closed", async () => {
  const f = new ComposedClaudeFixture();
  try {
    await start(f);
    await f.query.emitUnscheduled(failed());
    await requested(f);
    expect(f.query.closeRequested).toBe(true);
    await f.query.emitUnscheduled(rootRequest);
    await drain(f);
    expect(f.agent.getHealth()).toMatchObject({
      status: "failed",
      error: { code: "claude_rotation_uncertain" },
    });
    expect(f.agent.gateView()).toMatchObject({ activity: "busy", acceptingWork: false });
    expect(finished(f)).toEqual([]);
    expect(
      f.history.view.some((r) => r.type === "event" && r.eventType === "claude.rotation_failed"),
    ).toBe(true);
  } finally {
    await drain(f);
    f.dispose();
  }
});

it.each(["publication", "persistence"] as const)(
  "retains failed-operation handoffs when interruption %s fails",
  async (stage) => {
    const f = new ComposedClaudeFixture();
    try {
      await start(f);
      await f.query.emitUnscheduled(childEdge("task_started"));
      await f.query.emitUnscheduled(childEdge("task_notification"));
      await f.query.emitUnscheduled(failed());
      if (stage === "publication") f.failCommit = true;
      else f.failStateCommit = true;
      await drain(f);
      expect(f.agent.getHealth()).toMatchObject({ status: "failed" });
      expect(f.agent.gateView()).toMatchObject({ activity: "busy", acceptingWork: false });
      expect(f.journal().pendingHandoffs).toHaveProperty("child");
      expect(f.agent.liveView()?.subagents).toContainEqual(
        expect.objectContaining({ id: "child" }),
      );
      expect(finished(f)).toEqual([]);
    } finally {
      f.failCommit = false;
      f.failStateCommit = false;
      await drain(f);
      f.dispose();
    }
  },
);

it("lets explicit Abort override an in-flight failure cancellation without a second interrupt", async () => {
  const f = new ComposedClaudeFixture();
  let release = () => {};
  const pending = new Promise<{ still_queued: string[]; cancelled: string[] }>((resolve) => {
    release = () => resolve({ still_queued: [], cancelled: [] });
  });
  try {
    await start(f);
    const interrupt = vi.spyOn(f.query, "interrupt").mockReturnValue(pending);
    await f.query.emitUnscheduled(failed());
    const abort = f.agent.abortOperation();
    release();
    await pending;
    await drain(f);
    expect((await abort).isOk()).toBe(true);
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(finished(f)).toMatchObject([{ overflow: { outcome: "aborted" } }]);
  } finally {
    release();
    await drain(f);
    f.dispose();
  }
});

it.each([
  { errorClass: "process_exited_nonzero", exitCode: 1, signal: null, settled: true },
  { errorClass: "process_exited_nonzero", exitCode: 2, signal: null, settled: false },
  { errorClass: "process_exited_nonzero", exitCode: 139, signal: null, settled: false },
  { errorClass: "process_exited_nonzero", exitCode: 1, signal: "SIGTERM", settled: false },
  { errorClass: "process_killed_by_signal", exitCode: 1, signal: null, settled: false },
  { errorClass: "unrelated", exitCode: 1, signal: null, settled: false },
])(
  "accepts only expected exit1 after confirmed cancellation: $errorClass/$exitCode/$signal",
  async ({ settled, ...fields }) => {
    const f = new ComposedClaudeFixture();
    try {
      await start(f);
      await f.query.emitUnscheduled(failed());
      await requested(f);
      observeExit(f, fields.exitCode, fields.signal);
      f.query.failOutput(Object.assign(new Error("controlled iterator failure"), fields));
      f.query.exit();
      await f.agent.closeExtensions();
      expect(f.agent.getHealth()).toMatchObject(
        settled
          ? { status: "ready", activity: "idle" }
          : { status: "failed", error: { code: "claude_stream_failed" } },
      );
      expect(finished(f)).toHaveLength(settled ? 1 : 0);
    } finally {
      await drain(f);
      f.dispose();
    }
  },
);

it("does not swallow tagged exit1 thrown by message processing during cancellation", async () => {
  const f = new ComposedClaudeFixture();
  try {
    await start(f);
    await f.query.emitUnscheduled(failed());
    await requested(f);
    observeExit(f, 1, null);
    f.agent.subscribe((frame) => {
      if (frame.type === "runtime.event" && frame.event.type === "subagents")
        throw Object.assign(new Error("controlled listener failure"), {
          errorClass: "process_exited_nonzero",
          exitCode: 1,
        });
    });
    const consumed = f.query.enqueue(childEdge("task_started"));
    await f.agent.waitForStream();
    void consumed;
    await drain(f);
    expect(f.agent.getHealth()).toMatchObject({
      status: "failed",
      error: {
        code: "claude_stream_failed",
        message: expect.stringContaining("message processing"),
      },
    });
    expect(finished(f)).toEqual([]);
  } finally {
    await drain(f);
    f.dispose();
  }
});

it.each([
  { code: 1, signal: null, observed: true, settled: true },
  { code: 2, signal: null, observed: true, settled: false },
  { code: null, signal: "SIGTERM", observed: true, settled: false },
  { code: 1, signal: null, observed: false, settled: false },
])(
  "accepts wrapped error_result only with observed direct exit1: $code/$signal/$observed",
  async ({ code, signal, observed, settled }) => {
    const f = new ComposedClaudeFixture();
    try {
      await start(f);
      await f.query.emitUnscheduled(failed());
      await requested(f);
      if (observed) observeExit(f, code, signal);
      f.query.failOutput(
        Object.assign(new Error("controlled wrapped result"), { errorClass: "error_result" }),
      );
      f.query.exit();
      await f.agent.closeExtensions();
      expect(f.agent.getHealth()).toMatchObject(
        settled
          ? { status: "ready", activity: "idle" }
          : { status: "failed", error: { code: "claude_stream_failed" } },
      );
      expect(finished(f)).toHaveLength(settled ? 1 : 0);
    } finally {
      await drain(f);
      f.dispose();
    }
  },
);
