import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionResult, WatchEnd } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { waitArgs as args, toolData as data, WaitBoundary, wait } from "./testkit/subagent-wait.ts";

const ctx = BACKGROUND_CONTEXT;
async function observe(boundary: WaitBoundary, execution: Promise<ToolExecutionResult>) {
  const first = await Promise.race([
    execution.then(() => "returned"),
    boundary.registered.promise.then(() => "waiting"),
  ]);
  if (first === "waiting")
    expect(boundary.acquisitions, "completion wait must observe parent inbox").toBe(1);
}

it("followUp and writes do not interrupt child completion", async () => {
  await using boundary = await WaitBoundary.open();
  await boundary.queue("followUp");
  await boundary.queue("write");
  const execution = wait.execute(args, boundary.api, ctx);
  try {
    await boundary.registered.promise;
    expect(boundary.waiters.size).toBe(1);
    await boundary.queue("followUp");
    await boundary.queue("write");
    expect(boundary.child.state.status).toBe("running");
    boundary.complete();
    expect(data(await execution)).toMatchObject({ status: "completed" });
    expect(boundary.cancelCalls).toBe(0);
    expect(boundary.watches.size).toBe(0);
  } finally {
    boundary.complete();
    await execution;
  }
});

it("nonwaiting status does not acquire a watch or interrupt", async () => {
  await using boundary = await WaitBoundary.open();
  await boundary.queue("steer");
  const output = data(await wait.execute({ ...args, wait: false }, boundary.api, ctx));
  expect(output).toMatchObject({ status: "running" });
  expect(output).not.toHaveProperty("interrupted");
  expect(boundary.acquisitions).toBe(0);
  expect(boundary.waitCalls).toBe(0);
});

it.each([
  { reason: "cancelled" },
  { reason: "session_closed" },
  { reason: "retired" },
  { reason: "listener_error", error: new Error("listener failed") },
] satisfies WatchEnd[])("watch end $reason is not parent input", async (end) => {
  await using boundary = await WaitBoundary.open();
  const execution = wait.execute(args, boundary.api, ctx);
  try {
    await observe(boundary, execution);
    boundary.close(end);
    const output = await execution;
    expect(output.isError).toBe(true);
    expect(JSON.stringify(output)).not.toContain('"interrupted":"parent_input"');
    expect(boundary.child.state.status).toBe("running");
    expect(boundary.watches.size).toBe(0);
    expect(boundary.waiters.size).toBe(0);
  } finally {
    boundary.complete();
    await execution.catch(() => {});
  }
});

it.each(["acquireFailure", "startFailure", "stopFailure", "readFailure", "waitFailure"] as const)(
  "%s becomes a tool error, not input or an escaping exception",
  async (failure) => {
    await using boundary = await WaitBoundary.open();
    boundary[failure] = new Error(failure);
    if (failure === "stopFailure") await boundary.queue("steer");
    const execution = wait.execute(args, boundary.api, ctx);
    try {
      // Completion makes this finite even on the pre-feature implementation.
      boundary.complete();
      const output = await execution;
      expect(output.isError).toBe(true);
      expect(JSON.stringify(output)).not.toContain('"interrupted":"parent_input"');
      expect(boundary.watches.size).toBe(0);
      expect(boundary.waiters.size).toBe(0);
    } finally {
      boundary.complete();
      await execution.catch(() => {});
    }
  },
);

it("abnormal close during input-winner cleanup cannot masquerade as parent input", async () => {
  await using boundary = await WaitBoundary.open();
  boundary.stopEnd = { reason: "session_closed" };
  await boundary.queue("steer");
  const output = await wait.execute(args, boundary.api, ctx);
  expect(output.isError).toBe(true);
  expect(JSON.stringify(output)).not.toContain('"interrupted":"parent_input"');
  expect(boundary.child.state.status).toBe("running");
  expect(boundary.waiters.size).toBe(0);
  expect(boundary.watches.size).toBe(0);
});
