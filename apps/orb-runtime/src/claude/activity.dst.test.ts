import { ActiveSubagentSchema } from "@pi-orb/protocol";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { runDst } from "../testkit/sim.ts";
import { ClaudeActivity } from "./activity.ts";

it("root completion cannot retire an operation before owned children and process/history drain", async () => {
  await runDst({ name: "claude-root-child-drain", iterations: 1 }, async (sim) => {
    const activity = new ClaudeActivity();
    activity.claim("operation");
    activity.taskStart("child", "child", false);
    expect(activity.busy).toBe(true);
    const result = await sim.runTasks([
      {
        name: "root-child-drain",
        f: async (task) => {
          await task.checkpoint("root result before child terminal");
          activity.rootFinished();
          expect(activity.busy).toBe(true);
          expect(activity.canDrain).toBe(false);
          activity.taskEnd("child");
          activity.replaceTasks([]);
          expect(activity.canDrain).toBe(true);
          expect(activity.busy).toBe(true);
          activity.beginDrain();
          await task.checkpoint("close returned but native child has not exited");
          expect(activity.busy).toBe(true);
          expect(activity.claim("second")).toBe(false);
          activity.processExited(false);
          expect(activity.busy).toBe(true);
          await task.checkpoint("native exit before final history publication");
          activity.processExited(true);
          expect(activity.busy).toBe(false);
        },
      },
    ]);
    expect(result.isErr() ? result.error : null).toBeNull();
  });
});
it("duplicate root results during drain preserve handoffs and independent child holds", () => {
  const activity = new ClaudeActivity();
  activity.claim("operation");
  activity.rootFinished();
  activity.beginDrain();
  activity.childAdmitted("independent", "child");
  activity.taskHandoff("late", "Awaiting native result handoff");
  activity.rootFinished();
  activity.rootFinished();
  expect(activity.children.map((child) => child.id)).toEqual(["independent"]);
  expect(activity.drainHolds).toContain("handoffs");
  activity.handoffInterrupted("late");
  expect(activity.children.map((child) => child.id)).toEqual(["independent"]);
});
it("unclassified task edges and inventories cannot release each other's holds", () => {
  const activity = new ClaudeActivity();
  activity.claim("op");
  activity.rootFinished();
  activity.taskStart("edge", "edge", false);
  activity.replaceTasks([]);
  expect(activity.children).toEqual([]);
  expect(activity.drainHolds).toEqual(["tasks"]);
  expect(activity.canDrain).toBe(false);
  activity.taskEnd("edge");
  activity.replaceTasks([{ id: "level", description: "level", taskType: "future_type" }]);
  activity.taskEnd("level");
  expect(activity.children).toEqual([]);
  expect(activity.drainHolds).toEqual(["inventory"]);
  expect(activity.canDrain).toBe(false);
  activity.replaceTasks([]);
  expect(activity.canDrain).toBe(true);
});
it("replacement inventories cannot release an independently admitted native child", () => {
  const activity = new ClaudeActivity();
  activity.claim("op");
  activity.childAdmitted("agent", "child");
  activity.rootFinished();
  activity.replaceTasks([]);
  expect(activity.canDrain).toBe(false);
  activity.childTerminal("agent");
  expect(activity.canDrain).toBe(true);
});
it("native hook drain matches hook IDs, not event UUIDs, and cannot erase unmatched starts", () => {
  const activity = new ClaudeActivity();
  activity.claim("operation");
  activity.rootFinished();
  activity.beginDrain();
  activity.hookStart("setup");
  activity.hookStart("setup");
  activity.hookStart("resume");
  expect(activity.hookCount).toBe(2);
  activity.hookEnd("unrelated");
  activity.hookEnd("resume");
  expect(activity.hookCount).toBe(1);
  activity.processExited(true);
  expect(activity.busy).toBe(true);
  expect(activity.hookCount).toBe(1);
  activity.hookEnd("setup");
  activity.processExited(false);
  expect(activity.busy).toBe(true);
  activity.processExited(true);
  expect(activity.busy).toBe(false);
  expect(activity.hookCount).toBe(0);
});
it("Stop continuation and cancellation cleanup retain ownership; ambient servers do not", () => {
  const activity = new ClaudeActivity();
  activity.claim("operation");
  activity.hookStart("stop");
  activity.rootFinished();
  expect(activity.canDrain).toBe(false);
  activity.hookEnd("stop");
  activity.replaceTasks([{ id: "server", description: "dev server", ambient: true }]);
  expect(activity.canDrain).toBe(true);
  activity.cancel();
  expect(activity.busy).toBe(true);
  activity.beginDrain();
  activity.processExited(true);
  expect(activity.busy).toBe(false);
});

it("a result for inference started before a task notification cannot finish its handoff", () => {
  const activity = new ClaudeActivity();
  activity.claim("operation");
  activity.rootStarted();
  activity.taskHandoff("task", "Awaiting native result handoff");
  activity.rootFinished(true);
  expect(activity.canDrain).toBe(false);
  expect(activity.drainHolds).toContain("handoffs");
  activity.rootRequested();
  activity.rootFinished(false);
  expect(activity.canDrain).toBe(false);
  expect(activity.drainHolds).toContain("handoffs");
  expect(activity.rootFinished(true)).toEqual(["task"]);
  expect(activity.canDrain).toBe(true);
});

it("a requesting snapshot releases only handoffs already present when inference started", () => {
  const activity = new ClaudeActivity();
  activity.claim("operation");
  activity.taskHandoff("first", "first");
  activity.rootRequested();
  activity.taskHandoff("second", "second");
  activity.rootStarted();
  expect(activity.rootFinished(true)).toEqual(["first"]);
  expect(activity.drainHolds).toContain("handoffs");
  expect(activity.canDrain).toBe(false);
  activity.rootRequested();
  expect(activity.rootFinished(true)).toEqual(["second"]);
  expect(activity.canDrain).toBe(true);
});

it("late requesting and inference results during drain cannot consume retained handoffs", () => {
  const activity = new ClaudeActivity();
  activity.claim("operation");
  activity.rootFinished();
  activity.beginDrain();
  activity.taskHandoff("late", "late");
  activity.rootRequested();
  expect(activity.rootFinished(true)).toEqual([]);
  expect(activity.drainHolds).toContain("handoffs");
});

it("projects only positively identified agents and shells from task edges and inventory", () => {
  const activity = new ClaudeActivity();
  activity.claim("operation");
  activity.replaceTasks([
    { id: "agent", description: "review", taskType: "local_agent" },
    { id: "shell", description: "HTTP server", taskType: "local_bash" },
    { id: "monitor", description: "watch", taskType: "local_monitor" },
    { id: "workflow", description: "workflow", taskType: "local_workflow" },
    { id: "mcp", description: "MCP task", taskType: "mcp_task" },
    { id: "unknown", description: "unknown" },
    { id: "ambient", description: "ambient", taskType: "local_bash", ambient: true },
  ]);
  activity.childAdmitted("admitted", "Native Claude agent");
  activity.taskStart("admitted", "review", false);
  activity.taskStart("shell", "HTTP server", false, "local_bash");
  expect(activity.children).toEqual([
    { id: "agent", description: "review", phase: "running" },
    { id: "shell", description: "HTTP server", phase: "running", kind: "shell" },
    { id: "admitted", description: "Native Claude agent", phase: "running" },
  ]);
});

it.each(["before", "after"] as const)(
  "retains inventory metadata received %s an untyped task edge through handoff",
  (inventory) => {
    const activity = new ClaudeActivity();
    const tasks = [{ id: "shell", description: "server", taskType: "local_bash" }];
    if (inventory === "before") activity.replaceTasks(tasks);
    activity.taskStart("shell", "server", false);
    if (inventory === "after") activity.replaceTasks(tasks);
    activity.replaceTasks([]);
    expect(activity.children).toEqual([
      { id: "shell", description: "server", phase: "running", kind: "shell" },
    ]);
    activity.taskHandoff("shell", "handoff");
    activity.taskEnd("shell");
    activity.cancel();
    expect(activity.children).toEqual([
      { id: "shell", description: "handoff", phase: "finishing", kind: "shell" },
    ]);
  },
);

it("the live protocol accepts shell rows and rejects other kind values", () => {
  const child = { id: "task", description: "task", phase: "running" };
  expect(Check(ActiveSubagentSchema, child)).toBe(true);
  expect(Check(ActiveSubagentSchema, { ...child, kind: "shell" })).toBe(true);
  expect(Check(ActiveSubagentSchema, { ...child, kind: "unknown" })).toBe(false);
});
