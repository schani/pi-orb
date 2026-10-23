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

it.each(["before", "after"] as const)(
  "shell and unknown task ownership survives inventory removal %s notifications",
  async (inventory) => {
    await runDst({ name: `claude-shell-roster-${inventory}`, iterations: 20 }, async (sim) => {
      const f = new ComposedClaudeFixture();
      let finished = false;
      const tasks = [
        { task_id: "shell", description: "HTTP server", task_type: "local_bash" },
        { task_id: "unknown", description: "other work", task_type: "future_task" },
      ];
      try {
        expect((await f.attach()).isOk()).toBe(true);
        const scheduled = await sim.runTasks([
          {
            name: "native-tasks",
            f: async (task) => {
              await submitReceipt(task, f);
              await f.query.emit(task, background(tasks));
              for (const entry of tasks)
                await f.query.emit(task, {
                  type: "system",
                  subtype: "task_started",
                  task_id: entry.task_id,
                  description: entry.description,
                  uuid:
                    entry.task_id === "shell"
                      ? "11111111-1111-4111-8111-111111111111"
                      : "22222222-2222-4222-8222-222222222222",
                  session_id: "session",
                } satisfies SDKTaskStartedMessage);
              expect(f.agent.liveView()?.subagents).toEqual([
                { id: "shell", description: "HTTP server", kind: "shell", phase: "running" },
              ]);
              expect(f.journal().ownedTasks).toEqual({
                shell: "HTTP server",
                unknown: "other work",
              });
              await f.query.emit(task, rootResult);
              expect(f.query.closeRequested).toBe(false);
              expect(f.agent.prepareIdleStop().unwrapOr(false)).toBe(false);
              if (inventory === "before") await f.query.emit(task, background([]));
              for (const entry of tasks)
                await f.query.emit(task, {
                  ...childEdge("task_notification"),
                  ...entry,
                } as SDKMessage);
              if (inventory === "after") await f.query.emit(task, background([]));
              expect(f.agent.liveView()?.subagents).toEqual([
                {
                  id: "shell",
                  description: "Awaiting native result handoff",
                  kind: "shell",
                  phase: "finishing",
                },
              ]);
              expect(Object.keys(f.journal().pendingHandoffs ?? {}).sort()).toEqual([
                "shell",
                "unknown",
              ]);
              expect(f.query.closeRequested).toBe(false);
              await f.query.emit(task, rootRequest);
              await f.query.emit(task, rootResult);
              expect(f.journal().pendingHandoffs).toEqual({});
              expect(f.agent.liveView()?.subagents).toEqual([]);
              expect(f.agent.getHealth()).toMatchObject({ activity: "busy" });
              expect(f.agent.prepareIdleStop().unwrapOr(false)).toBe(false);
              finished = true;
              await task.checkpoint("roster cleared before physical drain");
              f.query.endOutput();
            },
          },
          {
            name: "supervisor",
            f: async (task) => {
              while (!finished) await task.sleep(1, "wait for native handoff result");
              await task.checkpoint("native process exit independent of output EOF");
              f.query.exit();
              await f.agent.closeExtensions();
              await task.checkpoint("final history commits before idle");
              expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
              expect(f.journal().ownedTasks).toEqual({});
              expect(f.journal().ownedBackgroundTasks).toEqual({});
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
  },
);
