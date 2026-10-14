import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import type { ToolExecutionResult, ToolRegistration, WatchEnd } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { CallableCatalog } from "./catalog.ts";
import { codemodeTool } from "./codemode.ts";
import { subagentTools } from "./subagents.ts";
import { deferred, WaitBoundary } from "./testkit/subagent-wait.ts";

const wait = subagentTools.find((tool) => tool.name === "get_subagent_result") as ToolRegistration;
const args = { agent_id: "child", wait: true };
const ctx = BACKGROUND_CONTEXT;
function data(value: ToolExecutionResult) {
  return JSON.parse(value.content?.find((block) => block.type === "text")?.text ?? "");
}
async function observe(boundary: WaitBoundary, execution: Promise<ToolExecutionResult>) {
  const first = await Promise.race([
    execution.then(() => "returned"),
    boundary.registered.promise.then(() => "waiting"),
  ]);
  if (first === "waiting")
    expect(boundary.acquisitions, "completion wait must observe parent inbox").toBe(1);
}

it("terminal child receipt takes precedence over parent input at the final task read", async () => {
  const boundary = new WaitBoundary();
  boundary.beforeRead = async () => {
    if (boundary.acquisitions && boundary.inbox.items.some((item) => item.mode === "steer"))
      boundary.complete();
  };
  const execution = wait.execute(args, boundary.api, ctx);
  try {
    await observe(boundary, execution);
    boundary.queue("steer");
    const output = data(await execution);
    expect(output).toMatchObject({
      status: "completed",
      receipt: {
        status: "completed",
        result: { output: "later receipt" },
      },
    });
    expect(output).not.toHaveProperty("interrupted");
    expect(boundary.taskReads).toBeGreaterThan(0);
    expect(boundary.watches.size).toBe(0);
    expect(boundary.waiters.size).toBe(0);
  } finally {
    boundary.complete();
    await execution;
  }
});

it("followUp and writes leave child completion and ordinary waits unchanged", async () => {
  const boundary = new WaitBoundary();
  boundary.queue("followUp");
  boundary.queue("write");
  const execution = wait.execute(args, boundary.api, ctx);
  try {
    await boundary.registered.promise;
    expect(boundary.waiters.size).toBe(1);
    boundary.queue("followUp");
    boundary.queue("write");
    expect(boundary.child.state.status).toBe("running");
    boundary.complete();
    expect(data(await execution)).toMatchObject({ status: "completed" });
    expect(boundary.cancelCalls).toBe(0);
    expect(boundary.watches.size).toBe(0);
    // An ordinary Harness-style join never watches the inbox.
    const ordinary = new WaitBoundary();
    ordinary.queue("steer");
    const join = ordinary.api.waitForTask(ordinary.child.id, ctx);
    expect(ordinary.acquisitions).toBe(0);
    expect(ordinary.waiters.size).toBe(1);
    ordinary.complete();
    expect((await join).state.status).toBe("terminal");
  } finally {
    boundary.complete();
    await execution;
  }
});

it("nonwaiting status does not acquire a watch or interrupt", async () => {
  const boundary = new WaitBoundary();
  boundary.queue("steer");
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
  const boundary = new WaitBoundary();
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
    const boundary = new WaitBoundary();
    boundary[failure] = new Error(failure);
    if (failure === "stopFailure") boundary.queue("steer");
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
  const boundary = new WaitBoundary();
  boundary.stopEnd = { reason: "session_closed" };
  boundary.queue("steer");
  const output = await wait.execute(args, boundary.api, ctx);
  expect(output.isError).toBe(true);
  expect(JSON.stringify(output)).not.toContain('"interrupted":"parent_input"');
  expect(boundary.child.state.status).toBe("running");
  expect(boundary.waiters.size).toBe(0);
  expect(boundary.watches.size).toBe(0);
});

it("caller cancellation cannot masquerade as parent input", async () => {
  const boundary = new WaitBoundary();
  const local = withCancel(ctx);
  const execution = wait.execute(args, boundary.api, local.context);
  try {
    await observe(boundary, execution);
    local.cancel();
    const output = await execution;
    expect(output.isError).toBe(true);
    expect(JSON.stringify(output)).not.toContain('"interrupted":"parent_input"');
    expect(boundary.child.state.status).toBe("running");
    expect(boundary.waiters.size).toBe(0);
    expect(boundary.watches.size).toBe(0);
  } finally {
    boundary.complete();
    await execution.catch(() => {});
  }
});

it.each(["framework", "codemode"] as const)(
  "%s returns interruption normally without codemode propagation",
  async (path) => {
    const boundary = new WaitBoundary();
    const catalog = new CallableCatalog(subagentTools);
    const code = codemodeTool(catalog, new Set());
    const entered = deferred();
    const release = deferred();
    boundary.beforeAcquire = async () => {
      entered.resolve();
      await release.promise;
    };
    boundary.queue("steer");
    const execution =
      path === "framework"
        ? (catalog
            .registrations()
            .find((tool) => tool.name === wait.name)
            ?.execute(args, boundary.api, ctx) as Promise<ToolExecutionResult>)
        : code.execute(
            {
              code: 'text(await tools.get_subagent_result({agent_id:"child",wait:true})); text("script continued");',
            },
            boundary.api,
            ctx,
          );
    try {
      const first = await Promise.race([
        entered.promise.then(() => "watch"),
        boundary.registered.promise.then(() => "waiting"),
        execution.then(() => "returned"),
      ]);
      expect(first, "nested wait must acquire the inbox watch").toBe("watch");
      release.resolve();
      const output = await execution;
      expect(output.isError).not.toBe(true);
      expect(JSON.stringify(output)).toContain("parent_input");
      if (path === "codemode") expect(JSON.stringify(output)).toContain("script continued");
      expect(boundary.child.state.status).toBe("running");
      expect(boundary.waiters.size).toBe(0);
      expect(boundary.watches.size).toBe(0);
    } finally {
      release.resolve();
      boundary.complete();
      await execution.catch(() => {});
    }
  },
);
