import { expect, it } from "vitest";
import {
  background,
  ComposedClaudeFixture,
  childEdge,
  rootResult,
  submitReceipt,
} from "../testkit/claude-composed.ts";
import { runDst } from "../testkit/sim.ts";

it.each(["before-result", "after-result"] as const)(
  "retains independent inventory and records continuation decisions with inventory removed %s",
  async (cut) => {
    await runDst(
      { name: `claude-continuation-observation-${cut}`, iterations: 20 },
      async (sim) => {
        const f = new ComposedClaudeFixture();
        try {
          expect((await f.attach()).isOk()).toBe(true);
          const result = await sim.runTasks([
            {
              name: "native",
              f: async (task) => {
                await submitReceipt(task, f);
                await task.checkpoint("nested dispatch policy before tool execution");
                const hook = f.query.options.hooks?.PreToolUse?.[0]?.hooks[0];
                if (hook === undefined) throw new Error("nested dispatch hook missing");
                await hook(
                  {
                    hook_event_name: "PreToolUse",
                    session_id: f.state.id,
                    transcript_path: f.nativePath,
                    cwd: f.state.cwd,
                    agent_id: "owner-child",
                    tool_name: "Agent",
                    tool_input: { run_in_background: true },
                    tool_use_id: "nested-call",
                  },
                  undefined,
                  { signal: new AbortController().signal },
                );
                const roster = background([
                  { task_id: "child", description: "private-description" },
                ]);
                await f.query.emit(task, childEdge("task_started"));
                await f.query.emit(task, roster);
                await f.query.emit(task, roster);
                await f.query.emit(task, rootResult);
                await f.query.emit(task, childEdge("task_notification"));
                expect(f.query.closeRequested).toBe(false);
                if (cut === "before-result") {
                  await f.query.emit(task, background([]));
                  expect(f.query.closeRequested).toBe(false);
                  expect(Object.keys(f.journal().pendingHandoffs ?? {})).toEqual(["child"]);
                }
                await f.query.emit(task, rootResult);
                if (cut === "after-result") {
                  expect(f.query.closeRequested).toBe(false);
                  expect(f.journal().ownedBackgroundTasks).toEqual({
                    child: "private-description",
                  });
                  await f.query.emit(task, background([]));
                }
                f.query.exit();
                f.query.endOutput();
                await f.agent.closeExtensions();
                await task.checkpoint("drain and observations committed");
                expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
                const observations = f.history.view
                  .filter((record) => record.type === "event")
                  .filter((record) => record.eventType.startsWith("claude.continuation."));
                expect(
                  observations.filter(
                    (record) => record.eventType === "claude.continuation.root_result",
                  ),
                ).toHaveLength(2);
                const inventories = observations.filter(
                  (record) => record.eventType === "claude.continuation.inventory",
                );
                expect(inventories).toHaveLength(2);
                expect(inventories[0]?.overflow).toMatchObject({
                  tasks: [{ taskId: "child", ambient: false }],
                });
                expect(
                  observations.some(
                    (record) => record.eventType === "claude.continuation.drain_started",
                  ),
                ).toBe(true);
                expect(
                  observations.some(
                    (record) =>
                      record.eventType === "claude.continuation.drain_finished" &&
                      record.overflow.stdoutEOF === true,
                  ),
                ).toBe(true);
                expect(
                  observations.every(
                    (record) =>
                      record.overflow.sessionId === f.state.id &&
                      typeof record.overflow.queryId === "string",
                  ),
                ).toBe(true);
                expect(JSON.stringify(observations)).not.toContain("private-description");
                expect(observations.every((record) => record.custom?.display === false)).toBe(true);
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
