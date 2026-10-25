import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  ComposedClaudeFixture,
  childEdge,
  childHook,
  nativeHook,
  rootResult,
  submitReceipt,
} from "../testkit/claude-composed.ts";
import { runDst } from "../testkit/sim.ts";

const key = `v2:${"a".repeat(64)}`;
const result = `${JSON.stringify({ type: "result", key, agentId: "child", result: false })}\n`;
const failedParent = { ...rootResult, is_error: true } as typeof rootResult;
it.each([
  ["current-result", 30],
  ["independent", 30],
  ["late-partial", 30],
  ["preexisting", 1],
  ["duplicate", 1],
  ["resumed", 1],
  ["retained", 1],
  ["failed-only", 1],
  ["publication", 1],
  ["state", 1],
  ["fsync", 1],
] as const)("%s preserves invocation ownership", async (mode, iterations) => {
  await runDst({ name: `claude-workflow-result-${mode}`, iterations }, async (sim) => {
    const f = new ComposedClaudeFixture();
    const directory = join(f.nativeDir, f.state.id, "subagents", "workflows", "wf_run");
    const write = (text: string) => {
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "journal.jsonl"), text);
    };
    const terminals = () =>
      f.history.view.filter(
        (r) => r.type === "event" && r.eventType === "claude.workflow_child_terminal",
      );
    const cut = ["publication", "state", "fsync"].includes(mode);
    const released = ["current-result", "independent", "late-partial"].includes(mode);
    let polling = false,
      complete = false;
    try {
      expect((await f.attach()).isOk()).toBe(true);
      const tasks = await sim.runTasks([
        {
          name: "native-result",
          f: async (task) => {
            await submitReceipt(task, f);
            if (!released) await f.query.emit(task, nativeHook("hold"));
            if (mode === "preexisting") write(result);
            if (mode === "retained") {
              f.state.ownedChildren = { child: "retained" };
              f.files.commit(join(f.dir, "claude", "session.json"), JSON.stringify(f.state));
            } else await childHook(task, f);
            if (mode === "duplicate") await childHook(task, f);
            if (mode === "resumed") {
              write(result);
              expect(f.agent.replicationSnapshot().isOk()).toBe(true);
              expect(f.journal().ownedChildren).toEqual({});
              await childHook(task, f);
            }
            if (mode === "independent") {
              await childHook(task, f, "other");
              await f.query.emit(task, childEdge("task_started"));
            }
            if (mode === "late-partial") write(result.trimEnd());
            await f.query.emit(task, failedParent);
            expect(f.journal().ownedChildren).toHaveProperty("child");
            expect(f.query.closeRequested).toBe(false);
            polling = !cut;
            await task.checkpoint("snapshots race a new result or an incomplete tail");
            if (mode === "publication") f.failCommit = true;
            if (mode === "state") f.failStateCommit = true;
            if (mode === "fsync") f.failSync = true;
            write(mode === "failed-only" ? '{"type":"failed","agentId":"child"}\n' : result);
            complete = true;
          },
        },
        {
          name: "existing-history-snapshots",
          f: async (task) => {
            while (!complete) {
              await task.checkpoint("ordinary history snapshot before or after proof append");
              if (polling) expect(f.agent.replicationSnapshot().isOk()).toBe(true);
              await task.sleep(1, "existing history poll cadence");
            }
            expect(f.agent.replicationSnapshot().isOk()).toBe(!cut);
          },
        },
      ]);
      expect(tasks.isErr() ? tasks.error : null).toBeNull();
      expect(Object.hasOwn(f.journal().ownedChildren ?? {}, "child")).toBe(!released);
      if (mode !== "retained")
        expect(f.agent.liveView()?.subagents.some((c) => c.id === "child")).toBe(
          !released || mode === "independent",
        );
      expect(terminals()).toHaveLength(released || mode === "resumed" || mode === "state" ? 1 : 0);
      if (released) {
        expect(f.agent.replicationSnapshot().isOk()).toBe(true);
        expect(terminals()).toHaveLength(1);
      }
      if (mode === "independent") {
        expect(f.journal().ownedChildren).toEqual({ other: "Native Claude agent" });
        expect(f.journal().ownedTasks).toEqual({ child: "child" });
      }
      if (cut)
        expect(f.agent.getHealth()).toMatchObject({
          status: "failed",
          error: { code: "claude_workflow_child_terminal_failed" },
        });
      expect(f.query.closeRequested).toBe(released && mode !== "independent");
    } finally {
      f.query.exit();
      f.query.endOutput();
      await f.agent.closeExtensions();
      f.dispose();
    }
  });
});
