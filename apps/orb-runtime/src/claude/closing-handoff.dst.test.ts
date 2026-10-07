import { expect, it } from "vitest";
import {
  background,
  ComposedClaudeFixture,
  childEdge,
  childHook,
  rootResult,
  submitReceipt,
} from "../testkit/claude-composed.ts";
import { runDst } from "../testkit/sim.ts";
import { qualifyClaudeRestart } from "./restore.ts";

it.each(
  (["completed", "failed", "stopped"] as const).flatMap((status) =>
    (
      ["none", "before-start", "between-bookends", "after-terminal", "trailing-results"] as const
    ).map((results) => ({ status, results })),
  ),
)(
  "disposes a matched $status task handoff with $results after query shutdown without replay",
  async ({ status, results }) => {
    await runDst(
      { name: `claude-closing-handoff-${status}-${results}`, iterations: 20 },
      async (sim) => {
        const f = new ComposedClaudeFixture();
        let terminal = false;
        try {
          expect((await f.attach()).isOk()).toBe(true);
          const result = await sim.runTasks([
            {
              name: "native-stdout",
              f: async (task) => {
                await submitReceipt(task, f);
                await f.query.emit(task, rootResult);
                expect(f.query.closeRequested).toBe(true);
                if (results === "before-start") await f.query.emit(task, rootResult);
                await f.query.emit(task, childEdge("task_started"));
                if (results === "between-bookends") await f.query.emit(task, rootResult);
                await f.query.emit(task, {
                  ...childEdge("task_notification"),
                  status,
                } as ReturnType<typeof childEdge>);
                if (results === "after-terminal" || results === "trailing-results")
                  await f.query.emit(task, rootResult);
                if (results === "trailing-results")
                  await f.query.emit(task, {
                    ...rootResult,
                    uuid: "33333333-3333-4333-8333-333333333333",
                  });
                terminal = true;
                expect(f.journal().pendingHandoffs).toEqual({
                  child: "Awaiting native result handoff",
                });
                expect(f.journal().handoffTerminals?.child).toMatchObject({
                  startedId: "task_started-event",
                  notificationId: "task_notification-event",
                  sessionId: "session",
                  status,
                  phase: "closing",
                  lifetime: f.journal().guardLifetime,
                });
                expect(f.agent.gateView().activity).toBe("busy");
                await task.checkpoint("matched terminal persisted before independent stdout EOF");
                f.query.endOutput();
              },
            },
            {
              name: "native-exit",
              f: async (task) => {
                while (!terminal) await task.sleep(1, "wait for terminal notification");
                await task.checkpoint("process exit independent of stdout EOF");
                f.query.exit();
                await f.agent.closeExtensions();
                await task.checkpoint("handoff disposition precedes operation retirement");
                expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
                expect(f.journal().pendingHandoffs).toEqual({});
                expect(f.journal().handoffTerminals).toEqual({});
                const disposition = f.history.view.filter(
                  (record) =>
                    record.type === "event" && record.eventType === "claude.handoff_interrupted",
                );
                expect(disposition).toHaveLength(1);
                expect(disposition[0]).toMatchObject({
                  custom: { display: true },
                  overflow: {
                    taskId: "child",
                    terminalStatus: status,
                    phase: "closing",
                    disposition: "interrupted",
                    automaticReplay: false,
                  },
                });
                expect(
                  f.history.view.find(
                    (record) =>
                      record.type === "event" && record.eventType === "claude.operation_finished",
                  ),
                ).toMatchObject({ overflow: { outcome: "aborted" } });
                expect(f.queries).toHaveLength(2);
                expect(f.agent.gateView().acceptingWork).toBe(true);
                expect(
                  qualifyClaudeRestart(
                    f.journal(),
                    f.history.view,
                    f.journal().guardLifetime!,
                  ).isOk(),
                ).toBe(true);
                const admitted = await f.agent.deliverInboxMessage(
                  "next",
                  ["next"],
                  [{ type: "text", text: "next input" }],
                );
                expect(admitted.isOk()).toBe(true);
                expect(f.queries).toHaveLength(3);
                const next = await f.query.input.next();
                expect(next.done).toBe(false);
                expect(next.value?.message.content).toEqual([{ type: "text", text: "next input" }]);
                f.receipt(next.value!);
                await f.query.emit(task, rootResult);
                f.query.exit();
                f.query.endOutput();
                await f.agent.closeExtensions();
                await task.checkpoint("next inbox input retires without replaying the old turn");
                expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
                expect(
                  f.history.view.filter(
                    (record) =>
                      record.type === "event" && record.eventType === "claude.handoff_interrupted",
                  ),
                ).toHaveLength(1);
              },
            },
          ]);
          expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        } finally {
          f.dispose();
        }
      },
    );
  },
);

it("keeps a known pre-result task handoff until a subsequent root result", async () => {
  await runDst({ name: "claude-normal-child-handoff", iterations: 20 }, async (sim) => {
    const f = new ComposedClaudeFixture();
    try {
      expect((await f.attach()).isOk()).toBe(true);
      const result = await sim.runTasks([
        {
          name: "native",
          f: async (task) => {
            await submitReceipt(task, f);
            await f.query.emit(task, childEdge("task_started"));
            await f.query.emit(task, rootResult);
            await f.query.emit(task, childEdge("task_notification"));
            expect(f.query.closeRequested).toBe(false);
            expect(f.agent.gateView().activity).toBe("busy");
            expect(Object.keys(f.journal().pendingHandoffs ?? {})).toEqual(["child"]);
            await f.query.emit(task, rootResult);
            f.query.exit();
            f.query.endOutput();
            await f.agent.closeExtensions();
            await task.checkpoint("normal root handoff fully retired");
            expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
            expect(
              f.history.view.some(
                (record) =>
                  record.type === "event" && record.eventType === "claude.handoff_interrupted",
              ),
            ).toBe(false);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    } finally {
      f.dispose();
    }
  });
});

it.each(["missing-start", "other-session"] as const)(
  "does not qualify a closing terminal with %s evidence",
  async (kind) => {
    await runDst({ name: `claude-closing-unproved-${kind}`, iterations: 20 }, async (sim) => {
      const f = new ComposedClaudeFixture();
      try {
        expect((await f.attach()).isOk()).toBe(true);
        const result = await sim.runTasks([
          {
            name: "native",
            f: async (task) => {
              await submitReceipt(task, f);
              await f.query.emit(task, rootResult);
              if (kind === "missing-start")
                await f.query.emit(
                  task,
                  background([{ task_id: "child", description: "inventory-only" }]),
                );
              else await f.query.emit(task, childEdge("task_started"));
              await f.query.emit(task, {
                ...childEdge("task_notification"),
                session_id: kind === "other-session" ? "other-session" : "session",
              } as ReturnType<typeof childEdge>);
              await f.query.emit(task, rootResult);
              await f.query.emit(task, {
                ...rootResult,
                uuid: "33333333-3333-4333-8333-333333333333",
              });
              f.query.exit();
              f.query.endOutput();
              await f.agent.closeExtensions();
              await task.checkpoint("unproved terminal cannot dispose the handoff");
              expect(f.journal().pendingHandoffs).toEqual({
                child: "Awaiting native result handoff",
              });
              expect(f.journal().handoffTerminals).toEqual({});
              expect(f.agent.getHealth()).toMatchObject({
                status: "failed",
                error: { code: "claude_child_recovery_required" },
              });
              expect(
                f.history.view.some(
                  (record) =>
                    record.type === "event" && record.eventType === "claude.handoff_interrupted",
                ),
              ).toBe(false);
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      } finally {
        f.dispose();
      }
    });
  },
);

it.each(["unmatched-child", "same-id-child", "background"] as const)(
  "retains uncertain %s ownership after a proved task terminal",
  async (kind) => {
    await runDst({ name: `claude-closing-uncertain-${kind}`, iterations: 20 }, async (sim) => {
      const f = new ComposedClaudeFixture();
      try {
        expect((await f.attach()).isOk()).toBe(true);
        const result = await sim.runTasks([
          {
            name: "native",
            f: async (task) => {
              await submitReceipt(task, f);
              await f.query.emit(task, rootResult);
              if (kind !== "background") {
                await childHook(task, f);
                const taskId = kind === "same-id-child" ? "child" : "other";
                await f.query.emit(task, {
                  ...childEdge("task_started"),
                  task_id: taskId,
                } as ReturnType<typeof childEdge>);
                await f.query.emit(task, {
                  ...childEdge("task_notification"),
                  task_id: taskId,
                } as ReturnType<typeof childEdge>);
              } else {
                await f.query.emit(
                  task,
                  background([{ task_id: "child", description: "unconfirmed inventory" }]),
                );
                await f.query.emit(task, childEdge("task_started"));
                await f.query.emit(task, childEdge("task_notification"));
              }
              await f.query.emit(task, rootResult);
              await f.query.emit(task, {
                ...rootResult,
                uuid: "33333333-3333-4333-8333-333333333333",
              });
              f.query.exit();
              f.query.endOutput();
              await f.agent.closeExtensions();
              await task.checkpoint("uncertain ownership still fences recovery");
              expect(f.agent.getHealth()).toMatchObject({
                status: "failed",
                error: { code: "claude_child_recovery_required" },
              });
              expect(
                qualifyClaudeRestart(
                  f.journal(),
                  f.history.view,
                  f.journal().guardLifetime!,
                ).isErr(),
              ).toBe(true);
              expect(f.journal().pendingHandoffs).toEqual({});
              if (kind !== "background")
                expect(f.journal().ownedChildren).toEqual({ child: "Native Claude agent" });
              else
                expect(f.journal().ownedBackgroundTasks).toEqual({
                  child: "unconfirmed inventory",
                });
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      } finally {
        f.dispose();
      }
    });
  },
);
