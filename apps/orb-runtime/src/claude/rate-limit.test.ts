import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, it, vi } from "vitest";
import {
  background,
  ComposedClaudeFixture,
  childEdge,
  childHook,
  rootResult,
  submitReceipt,
} from "../testkit/claude-composed.ts";
import { runDst } from "../testkit/sim.ts";

const rejection = {
  ...rootResult,
  uuid: "33333333-3333-4333-8333-333333333333",
  is_error: true,
  api_error_status: 429,
  result: "Usage limit reached.",
} as SDKMessage;
const content = [{ type: "text" as const, text: "hello" }];

async function start(f: ComposedClaudeFixture) {
  expect((await f.attach()).isOk()).toBe(true);
  expect((await f.agent.deliverInboxMessage("first", ["first"], content)).isOk()).toBe(true);
  const input = await f.query.input.next();
  if (input.done) throw new Error("Missing input");
  f.receipt(input.value);
  await f.query.emitUnscheduled(childEdge("task_started"));
}
async function dispose(f: ComposedClaudeFixture) {
  f.query.exit();
  f.query.endOutput();
  await f.agent.closeExtensions();
  f.dispose();
}

it.each([
  [{}, true],
  [{ is_error: false }, false],
  [{ api_error_status: undefined }, false],
  [{ api_error_status: 529 }, false],
  [{ api_error_status: undefined, result: "HTTP 429 usage_limit_reached" }, false],
  [{ subtype: "error_during_execution", errors: [] }, false],
  [{ queued_turn_count: 1 }, false],
])("contains only a terminal structured quota rejection: %j", async (fields, contains) => {
  const f = new ComposedClaudeFixture();
  try {
    await start(f);
    const interrupt = vi.spyOn(f.query, "interrupt");
    await f.query.emitUnscheduled({ ...rejection, ...fields } as SDKMessage);
    expect(interrupt).toHaveBeenCalledTimes(contains ? 1 : 0);
    expect(f.query.closeRequested).toBe(contains);
    expect(f.agent.getHealth().status).toBe(contains ? "failed" : "ready");
  } finally {
    await dispose(f);
  }
});

it("does not discard accepted steering on an earlier quota result", async () => {
  const f = new ComposedClaudeFixture();
  try {
    await start(f);
    expect((await f.agent.deliverInboxMessage("steer", ["steer"], content)).isOk()).toBe(true);
    const interrupt = vi.spyOn(f.query, "interrupt");
    await f.query.emitUnscheduled(rejection);
    expect(interrupt).not.toHaveBeenCalled();
    expect(f.query.closeRequested).toBe(false);
    expect(f.agent.getHealth().status).toBe("ready");
  } finally {
    await dispose(f);
  }
});

it("remains failed and closes even if native cancellation rejects", async () => {
  const f = new ComposedClaudeFixture();
  try {
    await start(f);
    vi.spyOn(f.query, "interrupt").mockRejectedValue(new Error("native rejection"));
    await f.query.emitUnscheduled(rejection);
    f.query.exit();
    f.query.endOutput();
    await f.agent.closeExtensions();
    expect(f.agent.getHealth()).toMatchObject({
      status: "failed",
      error: { code: "claude_rate_limit", retryable: false },
    });
    expect(f.query.closeRequested).toBe(true);
    expect(f.history.view).toContainEqual(
      expect.objectContaining({ type: "event", eventType: "claude.cleanup_failed" }),
    );
  } finally {
    await dispose(f);
  }
});

it("retains ownership across quota failure, late notification and zero-turn acknowledgment", async () => {
  await runDst({ name: "claude-rate-limit-containment", iterations: 20 }, async (sim) => {
    const f = new ComposedClaudeFixture();
    let outputComplete = false;
    const observations: { health: string; closing: boolean }[] = [];
    let release = () => {};
    const cancellation = new Promise<Awaited<ReturnType<typeof f.query.interrupt>>>((resolve) => {
      release = () => resolve(undefined);
    });
    try {
      expect((await f.attach()).isOk()).toBe(true);
      const scheduled = await sim.runTasks([
        {
          name: "native-output",
          f: async (task) => {
            await submitReceipt(task, f);
            vi.spyOn(f.query, "interrupt").mockReturnValue(cancellation);
            await f.query.emit(task, childEdge("task_started"));
            await f.query.emit(task, childEdge("task_notification"));
            await f.query.emit(task, {
              ...childEdge("task_started"),
              task_id: "independent",
            } as SDKMessage);
            await f.query.emit(
              task,
              background([{ task_id: "background", description: "running" }]),
            );
            await childHook(task, f, "independent-child");
            await f.query.emit(task, rejection);
            observations.push({
              health: f.agent.getHealth().status,
              closing: f.query.closeRequested,
            });
            await f.query.emit(task, {
              ...childEdge("task_notification"),
              task_id: "independent",
            } as SDKMessage);
            await f.query.emit(task, background([]));
            await f.query.emit(task, { ...rootResult, num_turns: 0 } as SDKMessage);
            observations.push({
              health: f.agent.getHealth().status,
              closing: f.query.closeRequested,
            });
            outputComplete = true;
            await task.checkpoint("failed output consumed; interrupt receipt still pending");
            f.query.endOutput();
          },
        },
        {
          name: "supervisor",
          f: async (task) => {
            while (!outputComplete) await task.sleep(1, "wait for terminal output");
            await task.checkpoint("process exit independent of cancellation receipt");
            f.query.exit();
            await f.agent.closeExtensions();
            release();
          },
        },
      ]);
      expect(scheduled.isErr() ? scheduled.error : null).toBeNull();
      expect(observations).toEqual([
        { health: "failed", closing: true },
        { health: "failed", closing: true },
      ]);
      expect(f.agent.getHealth()).toMatchObject({
        status: "failed",
        error: { code: "claude_rate_limit" },
      });
      expect(f.agent.gateView()).toMatchObject({ acceptingWork: false, activity: "busy" });
      expect(f.agent.prepareIdleStop().isErr()).toBe(true);
      expect((await f.agent.deliverInboxMessage("late", ["late"], content)).isErr()).toBe(true);
      expect(f.query.closeRequested).toBe(true);
      expect(f.query.interrupt).toHaveBeenCalledExactlyOnceWith({ cancelQueued: true });
      expect(f.journal().pendingHandoffs).toHaveProperty("child");
      expect(f.journal().pendingHandoffs).toHaveProperty("independent");
      expect(f.journal().ownedChildren).toHaveProperty("independent-child");
      expect(f.journal().ownedTasks).toEqual({});
      expect(f.journal().ownedBackgroundTasks).toEqual({});
      expect(
        f.history.view.some(
          (r) => r.type === "event" && r.eventType === "claude.operation_finished",
        ),
      ).toBe(false);
    } finally {
      release();
      await dispose(f);
    }
  });
});
