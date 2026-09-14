import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { RuntimeEvent } from "@pi-orb/protocol";
import { okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { OUTBOUND_CLOSE_CODE_BACKPRESSURE, OutboundWriter } from "../domain/outbound.ts";
import { decideRequest } from "../domain/requests.ts";
import { runDst } from "../testkit/sim.ts";
import { assertSubagentActivity } from "../testkit/subagent-contract.ts";
import { PiOrbAgent, type PiSession, type PiSessionManager } from "./agent.ts";

function fixture(promptResult?: Promise<void>) {
  const listeners: ((event: AgentSessionEvent) => void)[] = [];
  let idle = true;
  const events: RuntimeEvent[] = [];
  const entries: unknown[] = [];
  const records: { customType: string; data: unknown }[] = [];
  const deliveries: ("turn" | "steer")[] = [];
  let failHistoryRead = false;
  const session: PiSession = {
    get isIdle() {
      return idle;
    },
    subscribe: (fn) => {
      listeners.push(fn);
      return () => undefined;
    },
    sendUserMessage: async () => {
      idle = false;
      emit("agent_start");
      await promptResult;
    },
    sendCustomMessage: async (_message, options) => {
      deliveries.push(options?.deliverAs === "steer" ? "steer" : "turn");
      if (!idle) return;
      idle = false;
      emit("agent_start");
    },
    abort: async () => {
      idle = true;
      emit("agent_settled");
    },
    abortBash: () => undefined,
    executeBash: async () => ({ output: "", exitCode: 0, cancelled: false, truncated: false }),
  };
  function emit(type: "agent_start" | "agent_settled") {
    for (const fn of listeners) fn({ type } as AgentSessionEvent);
  }
  const manager: PiSessionManager = {
    getEntries: () => {
      if (failHistoryRead) throw new Error("injected SDK history read failure");
      return entries as ReturnType<PiSessionManager["getEntries"]>;
    },
    buildContextEntries: () => [],
    getLeafId: () => null,
    getHeader: () => ({
      type: "session",
      version: 3,
      id: "session",
      timestamp: new Date(0).toISOString(),
      cwd: "/test",
    }),
    getSessionId: () => "session",
    getSessionFile: () => undefined,
    appendCustomEntry: (customType, data) => {
      records.push({ customType, data });
      return "baseline";
    },
    appendCustomMessageEntry: () => "message",
  };
  const agent = new PiOrbAgent({
    orbId: "test",
    repositoryUrl: "https://example.com/repo",
    workDir: "/test",
    skillsDir: null,
    broker: null,
  });
  agent.subscribe((frame) => {
    if (frame.type === "runtime.event") events.push(frame.event);
  });
  agent.attachSession(session, manager, { summarize: () => okAsync("") });
  return {
    agent,
    events,
    records,
    deliveries,
    failHistoryRead: (fail: boolean) => {
      failHistoryRead = fail;
    },
    settle: () => {
      idle = true;
      emit("agent_settled");
    },
    wake: () => {
      idle = false;
      emit("agent_start");
    },
    settledWithContinuation: () => {
      idle = false;
      emit("agent_settled");
    },
  };
}

it("backpressure closes a slow peer without stranding child cleanup or changing the outcome", async () => {
  await runDst({ name: "subagent-outbound-backpressure", iterations: 50 }, async (sim) => {
    const h = fixture();
    await h.agent.submitMessage([], "op");
    const child = h.agent.admitSubagent("leaf")._unsafeUnwrap();
    h.settle();
    const closed: number[] = [];
    const writer = new OutboundWriter(
      {
        bufferedAmount: 1,
        send: () => {
          throw new Error("blocked sink must not send");
        },
        close: (code) => {
          closed.push(code);
        },
      },
      { highWaterMark: 0, maxCriticalBufferedBytes: 1 },
    );
    const unsubscribe = h.agent.subscribe((frame) => writer.enqueue(frame));
    let cancelledWhileBusy = false;
    const result = await sim.runTasks([
      {
        name: "terminal",
        f: async (task) => {
          await task.checkpoint("child cleanup complete");
          h.agent.releaseSubagent(child);
        },
      },
      {
        name: "abort",
        f: async (task) => {
          await task.checkpoint("abort races terminal and slow peer");
          cancelledWhileBusy = h.agent.gateView().activity === "busy";
          await h.agent.abortOperation();
        },
      },
    ]);
    unsubscribe();
    expect(result.isOk()).toBe(true);
    expect(closed).toEqual([OUTBOUND_CLOSE_CODE_BACKPRESSURE]);
    assertSubagentActivity(h.agent, "idle", null);
    expect(h.events.filter((event) => event.type === "operation_finished")).toEqual([
      {
        type: "operation_finished",
        operationId: "op",
        outcome: cancelledWhileBusy ? "aborted" : "completed",
      },
    ]);
  });
});

it("does not publish successful completion after a terminal history failure, even on a duplicate release", async () => {
  const h = fixture();
  await h.agent.submitMessage([], "op");
  const child = h.agent.admitSubagent("child")._unsafeUnwrap();
  h.settle();
  h.failHistoryRead(true);
  h.agent.releaseSubagent(child);
  expect(h.agent.getHealth()).toMatchObject({
    status: "failed",
    error: { code: "subagent_history_failed" },
  });
  expect(h.events.filter((e) => e.type === "operation_finished")).toEqual([]);
  h.failHistoryRead(false);
  h.agent.releaseSubagent(child);
  expect(h.events.filter((e) => e.type === "operation_finished")).toEqual([]);
  expect(h.agent.gateView().activity).toBe("busy");
});

it("arbitrates simultaneous child terminals, user input and abort without losing operation or inbox identity", async () => {
  await runDst({ name: "subagent-wake-inbox-abort", iterations: 200 }, async (sim) => {
    const h = fixture();
    await h.agent.submitMessage([], "op");
    const anchor = h.agent.admitSubagent("cleanup-anchor")._unsafeUnwrap();
    const a = h.agent.admitSubagent("a")._unsafeUnwrap();
    const b = h.agent.admitSubagent("b")._unsafeUnwrap();
    h.settle();
    let inboxRejected = false;
    let fenced = false;
    const busy = () => {
      assertSubagentActivity(h.agent, "busy", "op");
      expect(
        decideRequest(h.agent.gateView(), {
          type: "shell",
          command: "must not run",
          expectedHeadId: null,
          excludeFromContext: false,
        }),
      ).toMatchObject({ type: "reject", code: "busy" });
      expect(h.events.filter((e) => e.type === "operation_finished")).toEqual([]);
    };
    const result = await sim.runTasks([
      {
        name: "child-a",
        f: async (task) => {
          await task.checkpoint("child a terminal persistence and actual wake delivery");
          const wake = h.agent.mayWakeSubagent("a");
          if (fenced) expect(wake).toBe(false);
          if (wake) h.wake();
          h.agent.releaseSubagent(a);
          busy();
        },
      },
      {
        name: "child-b",
        f: async (task) => {
          await task.checkpoint("child b terminal and queue successor admission");
          const successor = h.agent.admitSubagent("successor");
          if (fenced) expect(successor.isErr()).toBe(true);
          h.agent.releaseSubagent(b);
          if (successor.isOk()) h.agent.releaseSubagent(successor.value);
          busy();
        },
      },
      {
        name: "inbox",
        f: async (task) => {
          await task.checkpoint("user input races automatic parent wake");
          const delivery = await h.agent.deliverInboxMessage("batch", ["batch"], []);
          inboxRejected = delivery.isErr();
          if (delivery.isOk()) expect(delivery.value.operationId).toBe("op");
          busy();
        },
      },
      {
        name: "abort",
        f: async (task) => {
          await task.checkpoint("whole-operation cancellation fence");
          const cancellation = h.agent.abortOperation();
          fenced = true;
          expect((await cancellation).isOk()).toBe(true);
          busy();
        },
      },
    ]);
    if (result.isErr()) throw result.error;
    expect(fenced).toBe(true);
    h.settle();
    h.agent.releaseSubagent(anchor);
    expect(h.events.filter((e) => e.type === "operation_finished")).toEqual([
      { type: "operation_finished", operationId: "op", outcome: "aborted" },
    ]);
    const retried = (await h.agent.deliverInboxMessage("batch", ["batch"], []))._unsafeUnwrap();
    expect(retried.duplicate).toBe(!inboxRejected);
    if (inboxRejected) expect(retried.operationId).not.toBe("op");
    else expect(retried.operationId).toBe("op");
    expect(h.deliveries).toHaveLength(1);
    // Neither an old terminal nor its withheld wake can affect a fresh operation.
    h.agent.releaseSubagent(a);
    h.agent.releaseSubagent(b);
    expect(h.agent.mayWakeSubagent("a")).toBe(false);
    if (inboxRejected)
      expect(h.agent.getHealth()).toMatchObject({
        activity: "busy",
        operationId: retried.operationId,
      });
  });
});

it("keeps health, snapshot and operation busy through a leaf-only interval and root wake", async () => {
  await runDst({ name: "subagent-runtime-activity", iterations: 100 }, async (sim) => {
    const h = fixture();
    await h.agent.submitMessage([{ type: "text", text: "work" }], "op");
    const child = h.agent.admitSubagent("child")._unsafeUnwrap();
    const run = await sim.runTasks([
      {
        name: "root",
        f: async (task) => {
          await task.checkpoint("root settles first");
          h.settle();
          expect(h.agent.getHealth()).toMatchObject({ activity: "busy", operationId: "op" });
          expect(h.agent.snapshot()._unsafeUnwrap()).toMatchObject({ activity: "busy" });
          expect(h.agent.gateView()).toMatchObject({ activity: "busy", activeOperationId: "op" });
          expect(h.agent.liveView()).toMatchObject({ operationId: "op" });
          await task.checkpoint("child cleanup and wake handoff");
          h.wake();
          h.agent.releaseSubagent(child);
          expect(h.agent.getHealth()).toMatchObject({ activity: "busy", operationId: "op" });
          h.settle();
          expect(h.agent.getHealth()).toMatchObject({ activity: "idle" });
          expect(h.events.filter((e) => e.type === "operation_started")).toHaveLength(1);
          expect(h.events.filter((e) => e.type === "operation_finished")).toEqual([
            { type: "operation_finished", operationId: "op", outcome: "completed" },
          ]);
        },
      },
    ]);
    if (run.isErr()) throw run.error;
  });
});

it("persists a withheld wake veto even after the child's execution hold has drained", async () => {
  const h = fixture();
  await h.agent.submitMessage([], "op");
  const child = h.agent.admitSubagent("child")._unsafeUnwrap();
  h.agent.releaseSubagent(child);
  await h.agent.abortOperation();
  expect(h.agent.mayWakeSubagent("child")).toBe(false);
  expect(h.records).toContainEqual({
    customType: "pi-orb.subagent-run",
    data: { childId: "child", operationId: "op", phase: "wake_suppressed" },
  });
});

it("retains the aborted outcome when the SDK prompt rejects during child cleanup", async () => {
  let rejectPrompt = (_error: unknown): void => {};
  const prompt = new Promise<void>((_resolve, reject) => {
    rejectPrompt = reject;
  });
  const h = fixture(prompt);
  const submitted = h.agent.submitMessage([], "op");
  const child = h.agent.admitSubagent("child")._unsafeUnwrap();
  await h.agent.abortOperation();
  rejectPrompt(new Error("SDK cancellation rejection"));
  expect((await submitted).isErr()).toBe(true);
  h.agent.releaseSubagent(child);
  expect(h.events.filter((e) => e.type === "operation_finished")).toEqual([
    { type: "operation_finished", operationId: "op", outcome: "aborted" },
  ]);
});

it("samples SDK readiness rather than clearing a continuation at an old settled event", async () => {
  const h = fixture();
  await h.agent.submitMessage([], "op");
  h.settledWithContinuation();
  expect(h.agent.getHealth()).toMatchObject({ activity: "busy" });
  h.settle();
  expect(h.agent.getHealth()).toMatchObject({ activity: "idle" });
});

it("turns child-only input into a root turn without changing the operation, then fences abort until drain", async () => {
  const h = fixture();
  await h.agent.submitMessage([], "op");
  const child = h.agent.admitSubagent("child")._unsafeUnwrap();
  h.settle();
  const delivery = await h.agent.deliverInboxMessage(
    "batch",
    ["batch"],
    [{ type: "text", text: "more" }],
  );
  expect(delivery._unsafeUnwrap()).toMatchObject({ delivery: "turn", operationId: "op" });
  await h.agent.abortOperation();
  expect(h.agent.mayWakeSubagent("child")).toBe(false);
  expect(h.agent.getHealth()).toMatchObject({ activity: "busy" });
  const pending = await h.agent.deliverInboxMessage("next", ["next"], []);
  expect(pending.isErr()).toBe(true);
  expect(h.agent.admitSubagent("late").isErr()).toBe(true);
  h.agent.releaseSubagent(child);
  expect(h.agent.getHealth()).toMatchObject({ activity: "idle" });
  expect(h.events.filter((e) => e.type === "operation_finished")).toEqual([
    { type: "operation_finished", operationId: "op", outcome: "aborted" },
  ]);
});
