import { expect, it } from "vitest";
import {
  ComposedClaudeFixture,
  childEdge,
  rootResult,
  submitReceipt,
} from "../testkit/claude-composed.ts";
import { runDst } from "../testkit/sim.ts";

it("bounds affected-query diagnostics without dropping ownership or the drain summary", async () => {
  await runDst({ name: "claude-continuation-observation-bounds", iterations: 3 }, async (sim) => {
    const f = new ComposedClaudeFixture();
    try {
      expect((await f.attach()).isOk()).toBe(true);
      const result = await sim.runTasks([
        {
          name: "native",
          f: async (task) => {
            await submitReceipt(task, f);
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
            await f.query.emit(task, childEdge("task_started"));
            for (let i = 0; i < 40; i++) await f.query.emit(task, rootResult);
            expect(f.query.closeRequested).toBe(false);
            expect(f.journal().ownedTasks).toHaveProperty("child");
            await f.query.emit(task, childEdge("task_notification"));
            expect(f.query.closeRequested).toBe(false);
            await f.query.emit(task, rootResult);
            f.query.exit();
            f.query.endOutput();
            await f.agent.closeExtensions();
            await task.checkpoint("bounded observations and drain summary committed");
            expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
            const edges = f.history.view
              .filter((record) => record.type === "event")
              .filter((record) => record.eventType.startsWith("claude.continuation."));
            expect(edges).toHaveLength(33);
            expect(edges.at(-1)).toMatchObject({
              eventType: "claude.continuation.drain_finished",
              overflow: { stdoutEOF: true },
            });
            expect(Number(edges.at(-1)?.overflow.suppressedEdges)).toBeGreaterThan(0);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    } finally {
      f.dispose();
    }
  });
});
