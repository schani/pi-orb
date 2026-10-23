import { ActiveSubagentSchema } from "@pi-orb/protocol";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { ClaudeActivity } from "./activity.ts";

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
  activity.taskStart("shell", "HTTP server", false, "local_bash");
  expect(activity.children).toEqual([
    { id: "agent", description: "review", phase: "running" },
    { id: "shell", description: "HTTP server", phase: "running", kind: "shell" },
  ]);
});

it("uses SubagentStart admission as agent proof without task metadata", () => {
  const activity = new ClaudeActivity();
  activity.claim("operation");
  activity.childAdmitted("agent", "Native Claude agent");
  activity.taskStart("agent", "review", false);
  expect(activity.children).toEqual([
    { id: "agent", description: "Native Claude agent", phase: "running" },
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
    expect(activity.children).toEqual([
      { id: "shell", description: "handoff", phase: "finishing", kind: "shell" },
    ]);
  },
);

it.each(["local_bash", "local_agent", "unknown"] as const)(
  "retains %s classification through task handoff and cancellation",
  (taskType) => {
    const activity = new ClaudeActivity();
    activity.claim("operation");
    activity.taskStart("task", "task", false, taskType);
    activity.taskHandoff("task", "Awaiting native result handoff");
    activity.taskEnd("task");
    activity.replaceTasks([]);
    activity.cancel();
    expect(activity.children).toEqual(
      taskType === "unknown"
        ? []
        : [
            {
              id: "task",
              description: "Awaiting native result handoff",
              phase: "finishing",
              ...(taskType === "local_bash" ? { kind: "shell" } : {}),
            },
          ],
    );
    expect(activity.canDrain).toBe(false);
    expect(activity.busy).toBe(true);
    activity.rootRequested();
    expect(activity.rootFinished(true)).toEqual(["task"]);
    expect(activity.canDrain).toBe(true);
  },
);

it("unclassified work still owns independent edge and inventory drain holds", () => {
  const activity = new ClaudeActivity();
  activity.claim("operation");
  activity.rootFinished();
  activity.taskStart("unknown", "unknown", false);
  activity.replaceTasks([{ id: "unknown", description: "unknown", taskType: "future_type" }]);
  expect(activity.children).toEqual([]);
  expect(activity.drainHolds).toEqual(["inventory", "tasks"]);
  expect(activity.canDrain).toBe(false);
  activity.taskEnd("unknown");
  expect(activity.drainHolds).toEqual(["inventory"]);
  expect(activity.canDrain).toBe(false);
  activity.replaceTasks([]);
  expect(activity.canDrain).toBe(true);
});

it("the live protocol accepts shell rows and rejects other kind values", () => {
  const child = { id: "task", description: "task", phase: "running" };
  expect(Check(ActiveSubagentSchema, child)).toBe(true);
  expect(Check(ActiveSubagentSchema, { ...child, kind: "shell" })).toBe(true);
  expect(Check(ActiveSubagentSchema, { ...child, kind: "unknown" })).toBe(false);
});
