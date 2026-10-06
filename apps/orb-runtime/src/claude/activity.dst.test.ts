import { expect, it } from "vitest";
import { runDst } from "../testkit/sim.ts";
import { ClaudeActivity } from "./activity.ts";

it("root completion cannot retire an operation before owned children and process/history drain", async () => {
  await runDst({ name: "claude-root-child-drain" }, async (sim) => {
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
it("background levels and task edges cannot release each other's holds", () => {
  const activity = new ClaudeActivity();
  activity.claim("op");
  activity.rootFinished();
  activity.taskStart("edge", "edge", false);
  activity.replaceTasks([]);
  expect(activity.canDrain).toBe(false);
  activity.taskEnd("edge");
  activity.replaceTasks([{ id: "level", description: "level" }]);
  activity.taskEnd("level");
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
