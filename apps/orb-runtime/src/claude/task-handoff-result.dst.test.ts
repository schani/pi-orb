import type { SDKMessage, SDKTaskStartedMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, it } from "vitest";
import {
  background,
  ComposedClaudeFixture,
  childEdge,
  rootRequest,
  rootResult,
  submitReceipt,
} from "../testkit/claude-composed.ts";
import { runDst } from "../testkit/sim.ts";

const acknowledgment = {
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 0,
  stop_reason: null,
  result: "",
  queued_turn_count: 0,
  uuid: "command-ack",
  session_id: "session",
} as unknown as SDKMessage;

it.each(
  (["before", "after"] as const).flatMap((inventory) =>
    (["acknowledged", "buffered"] as const).flatMap((delivery) =>
      (["after-result", "during-response"] as const).map((release) => ({
        inventory,
        delivery,
        release,
      })),
    ),
  ),
)(
  "$delivery command results cannot finish task handoffs released $release with inventory removed $inventory notifications",
  async ({ inventory, delivery, release }) => {
    await runDst(
      { name: `claude-task-command-ack-${inventory}-${delivery}-${release}`, iterations: 30 },
      async (sim) => {
        const f = new ComposedClaudeFixture();
        const tasks = [
          { task_id: "first", description: "first", task_type: "local_bash" },
          { task_id: "second", description: "second", task_type: "future_task" },
        ];
        let finished = false;
        let ackState: { closing: boolean; handoffs: string[]; canStop: boolean } | undefined;
        try {
          expect((await f.attach()).isOk()).toBe(true);
          const scheduled = await sim.runTasks([
            {
              name: "native-producer",
              f: async (task) => {
                await submitReceipt(task, f);
                const { task_type: _taskType, ...taskStarted } = childEdge(
                  "task_started",
                ) as SDKTaskStartedMessage;
                for (const id of ["first", "second"])
                  await f.query.emit(task, {
                    ...taskStarted,
                    task_id: id,
                  } as SDKMessage);
                await f.query.emit(task, background(tasks));
                expect(f.agent.liveView()?.subagents).toEqual([
                  { id: "first", description: "child", kind: "shell", phase: "running" },
                ]);
                expect(f.journal().ownedTasks).toEqual({ first: "child", second: "child" });
                await f.query.emit(task, {
                  type: "system",
                  subtype: "status",
                  status: "requesting",
                } as SDKMessage);
                if (release === "after-result")
                  await f.query.emit(task, { ...rootResult, num_turns: 3 } as SDKMessage);
                if (inventory === "before") await f.query.emit(task, background([]));
                for (const id of ["first", "second"])
                  await f.query.emit(task, {
                    ...childEdge("task_notification"),
                    task_id: id,
                  } as SDKMessage);
                if (inventory === "after") await f.query.emit(task, background([]));
                expect(f.agent.liveView()?.subagents).toEqual([
                  {
                    id: "first",
                    description: "Awaiting native result handoff",
                    kind: "shell",
                    phase: "finishing",
                  },
                ]);
                if (release === "during-response")
                  await f.query.emit(task, { ...rootResult, num_turns: 3 } as SDKMessage);
                f.append({
                  type: "assistant",
                  uuid: "handoff-answer",
                  message: { content: "Handoff complete." },
                });
                const continuation = [
                  { type: "system", subtype: "status", status: "requesting" },
                  {
                    type: "assistant",
                    parent_tool_use_id: null,
                    uuid: "handoff-answer",
                    message: { content: [{ type: "text", text: "Handoff complete." }] },
                  },
                  { ...rootResult, num_turns: 2 },
                ] as SDKMessage[];
                if (delivery === "buffered") {
                  await task.checkpoint(
                    "producer queues acknowledgment and continuation without consumer backpressure",
                  );
                  const receipts = [acknowledgment, ...continuation].map((message) =>
                    f.query.enqueue(message),
                  );
                  expect(await Promise.all(receipts)).toEqual([true, true, true, true]);
                } else {
                  await f.query.emit(task, acknowledgment);
                  ackState = {
                    closing: f.query.closeRequested,
                    handoffs: Object.keys(f.journal().pendingHandoffs ?? {}).sort(),
                    canStop: f.agent.prepareIdleStop().unwrapOr(false),
                  };
                  for (const message of continuation) await f.query.emit(task, message);
                }
                expect(f.agent.liveView()?.subagents).toEqual([]);
                expect(f.agent.getHealth()).toMatchObject({ activity: "busy" });
                expect(f.agent.prepareIdleStop().unwrapOr(false)).toBe(false);
                finished = true;
                await task.checkpoint("final root result before independent stdout EOF");
                f.query.endOutput();
              },
            },
            {
              name: "supervisor",
              f: async (task) => {
                while (!finished) await task.sleep(1, "wait for actual root handoff result");
                await task.checkpoint("native exit independent of stdout EOF");
                f.query.exit();
                await f.agent.closeExtensions();
                await task.checkpoint("completion and durable diagnostic");
                if (delivery === "acknowledged")
                  expect(ackState).toEqual({
                    closing: false,
                    handoffs: ["first", "second"],
                    canStop: false,
                  });
                expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
                expect(f.journal().pendingHandoffs).toEqual({});
                expect(f.journal().ownedTasks).toEqual({});
                expect(f.journal().ownedBackgroundTasks).toEqual({});
                expect(
                  f.history.view.find(
                    (record) =>
                      record.type === "event" && record.eventType === "claude.operation_finished",
                  ),
                ).toMatchObject({ overflow: { outcome: "completed" } });
                expect(
                  f.history.view.find(
                    (record) =>
                      record.type === "event" &&
                      record.eventType === "claude.handoff_result" &&
                      record.overflow?.["resultId"] === "command-ack",
                  ),
                ).toMatchObject({
                  custom: { display: false },
                  overflow: {
                    resultId: "command-ack",
                    numTurns: 0,
                    pendingHandoffs: ["first", "second"],
                  },
                });
                expect(
                  f.history.view.some(
                    (record) =>
                      record.type === "event" && record.eventType === "claude.rotation_failed",
                  ),
                ).toBe(false);
              },
            },
          ]);
          expect(scheduled.isErr() ? scheduled.error : null).toBeNull();
        } finally {
          f.query.exit();
          f.query.endOutput();
          await f.agent.closeExtensions();
          f.dispose();
        }
      },
    );
  },
);

it("a zero-turn local command without task handoffs still completes", async () => {
  const f = new ComposedClaudeFixture();
  try {
    expect((await f.attach()).isOk()).toBe(true);
    expect(
      (
        await f.agent.deliverInboxMessage("inbox", ["inbox"], [{ type: "text", text: "/help" }])
      ).isOk(),
    ).toBe(true);
    const input = await f.query.input.next();
    if (input.done) throw new Error("SDK input missing.");
    f.receipt(input.value);
    await f.query.emitUnscheduled(acknowledgment);
    expect(f.query.closeRequested).toBe(true);
    f.query.exit();
    f.query.endOutput();
    await f.agent.closeExtensions();
    expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
    expect(
      f.history.view.some(
        (record) =>
          record.type === "event" &&
          record.eventType === "claude.handoff_result" &&
          record.overflow?.["resultId"] === "command-ack",
      ),
    ).toBe(false);
  } finally {
    f.query.exit();
    f.query.endOutput();
    await f.agent.closeExtensions();
    f.dispose();
  }
});

it("a failed acknowledgment publication retains handoff ownership and blocks admission", async () => {
  const f = new ComposedClaudeFixture();
  try {
    expect((await f.attach()).isOk()).toBe(true);
    expect(
      (
        await f.agent.deliverInboxMessage("inbox", ["inbox"], [{ type: "text", text: "hello" }])
      ).isOk(),
    ).toBe(true);
    const input = await f.query.input.next();
    if (input.done) throw new Error("SDK input missing.");
    f.receipt(input.value);
    await f.query.emitUnscheduled(childEdge("task_started"));
    await f.query.emitUnscheduled(rootResult);
    await f.query.emitUnscheduled(childEdge("task_notification"));
    f.failCommit = true;
    await f.query.emitUnscheduled(acknowledgment);
    expect(f.agent.getHealth()).toMatchObject({
      status: "failed",
      error: { code: "history_unavailable" },
    });
    expect(f.agent.gateView()).toMatchObject({ activity: "busy", acceptingWork: false });
    expect(f.query.closeRequested).toBe(false);
    expect(Object.keys(f.journal().pendingHandoffs ?? {})).toEqual(["child"]);
    expect(f.agent.prepareIdleStop().isErr()).toBe(true);
  } finally {
    f.query.exit();
    f.query.endOutput();
    await f.agent.closeExtensions();
    f.dispose();
  }
});

it("a handoff arriving during synthesis survives the earlier handoff's result in both ownership layers", async () => {
  await runDst({ name: "claude-handoff-request-snapshot", iterations: 20 }, async (sim) => {
    const f = new ComposedClaudeFixture();
    try {
      expect((await f.attach()).isOk()).toBe(true);
      const scheduled = await sim.runTasks([
        {
          name: "native",
          f: async (task) => {
            await submitReceipt(task, f);
            for (const id of ["first", "second"])
              await f.query.emit(task, { ...childEdge("task_started"), task_id: id } as SDKMessage);
            await f.query.emit(task, rootResult);
            await f.query.emit(task, {
              ...childEdge("task_notification"),
              task_id: "first",
            } as SDKMessage);
            await f.query.emit(task, rootRequest);
            await f.query.emit(task, {
              ...childEdge("task_notification"),
              task_id: "second",
            } as SDKMessage);
            await f.query.emit(task, rootResult);
            expect(Object.keys(f.journal().pendingHandoffs ?? {})).toEqual(["second"]);
            expect(f.agent.liveView()?.subagents.map((child) => child.id)).toEqual(["second"]);
            expect(f.query.closeRequested).toBe(false);
            await f.query.emit(task, acknowledgment);
            expect(Object.keys(f.journal().pendingHandoffs ?? {})).toEqual(["second"]);
            await f.query.emit(task, rootRequest);
            await f.query.emit(task, rootResult);
            expect(f.query.closeRequested).toBe(true);
            f.query.exit();
            f.query.endOutput();
            await f.agent.closeExtensions();
            expect(f.journal().pendingHandoffs).toEqual({});
            expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
          },
        },
      ]);
      expect(scheduled.isErr() ? scheduled.error : null).toBeNull();
    } finally {
      f.query.exit();
      f.query.endOutput();
      await f.agent.closeExtensions();
      f.dispose();
    }
  });
});
