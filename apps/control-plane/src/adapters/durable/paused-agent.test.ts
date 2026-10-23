import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineTask, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { expect, it } from "vitest";
import { DurableAgent } from "./agent.ts";
import { MemoryAgentPersistence } from "./memory-persistence.testkit.ts";

it("a read-only reopen preserves unfinished work without advertising or dispatching it", async () => {
  const path = await mkdtemp(join(tmpdir(), "durable-paused-agent-"));
  let effects = 0;
  const pending = defineTask<null, { phase: "run" }, null>({
    name: "paused-work",
    version: 1,
    initial: () => ({ phase: "run" }),
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
    phases: {
      run: async (_task, runtime, ctx) => {
        effects++;
        await runtime.commit(
          () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
          ctx,
        );
      },
    },
  });
  const registry = () => {
    const value = createRegistry();
    value.install({ name: "paused-work", tasks: [pending] });
    return value;
  };
  const authority = new MemoryAgentPersistence();
  const storage = (await authority.openOrb("orb", false))._unsafeUnwrap().storage;
  const seed = await Harness.open(
    storage,
    { models: createModels(), registry: registry() },
    BACKGROUND_CONTEXT,
  );
  const root = await seed.root(BACKGROUND_CONTEXT, {
    agent: { model: { provider: "openai-codex", modelId: "gpt-6.1" } },
  });
  await root.commit(
    (tx) => tx.createTask(pending, null, { ownership: { kind: "conversation" } }),
    BACKGROUND_CONTEXT,
  );
  await seed.close(BACKGROUND_CONTEXT);
  await authority.close();
  const reopened = authority;
  const agent = (
    await DurableAgent.open({
      orbId: "orb",
      storage: (await reopened.openOrb("orb", true))._unsafeUnwrap().storage,
      models: createModels(),
      registry: registry(),
      env: new NodeExecutionEnv({ cwd: "/tmp" }),
      instructions: "CP; pending",
      checkoutCommit: null,
      resume: false,
    })
  )._unsafeUnwrap();
  try {
    expect(effects).toBe(0);
    expect(agent.workActive()).toBe(false);
    expect(agent.health()).toMatchObject({ status: "ready", activity: "idle" });
    expect(agent.liveView()).toBeNull();
    expect(agent.snapshot()._unsafeUnwrap().settings?.writable).toBe(false);
    expect((await agent.prepareIdleStop())._unsafeUnwrap().prepared).toBe(true);
    expect(
      (
        await agent.deliver({
          baseUrl: "central",
          messageId: "bypass",
          messageIds: [],
          content: [{ type: "text", text: "bypass" }],
        })
      ).isErr(),
    ).toBe(true);
    // A stale health read cannot activate this read-only ownership scope.
    agent.resume();
    expect(agent.workActive()).toBe(false);
    expect(effects).toBe(0);
    await agent.close();
    const active = (
      await DurableAgent.open({
        orbId: "orb",
        storage: (await reopened.openOrb("orb", true))._unsafeUnwrap().storage,
        models: createModels(),
        registry: registry(),
        env: new NodeExecutionEnv({ cwd: "/tmp" }),
        instructions: "CP",
        checkoutCommit: null,
      })
    )._unsafeUnwrap();
    try {
      await active.waitForIdle();
      expect(effects).toBe(1);
    } finally {
      await active.close();
    }
  } finally {
    await agent.close();
    await reopened.close();
    await rm(path, { recursive: true, force: true });
  }
});

it("keeps sleeping recovery demand across reopen until its controlled wake", async () => {
  let now = 1000;
  let sleeping!: () => void;
  let wakes = 0;
  const authority = new MemoryAgentPersistence();
  const storage = (await authority.openOrb("sleeping", false))._unsafeUnwrap().storage;
  const work = defineTask<null, { phase: "run" | "wake" }, null>({
    name: "sleeping-work",
    version: 1,
    initial: () => ({ phase: "run" }),
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
    phases: {
      run: async (_task, runtime, ctx) => {
        await runtime.commit(
          () => ({ status: "sleeping", until: now + 5000, checkpoint: { phase: "wake" } }),
          ctx,
        );
        sleeping();
      },
      wake: async (_task, runtime, ctx) => {
        wakes++;
        await runtime.commit(
          () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
          ctx,
        );
      },
    },
  });
  const registry = createRegistry();
  registry.install({ name: "sleeping-work", tasks: [work] });
  const timers = new Map<() => void, number>();
  const options = {
    models: createModels(),
    registry,
    now: () => now,
    setTimer: (callback: () => void, delay: number) => {
      timers.set(callback, now + delay);
      return () => {
        timers.delete(callback);
      };
    },
  };
  let harness = await Harness.open(storage, options, BACKGROUND_CONTEXT);
  try {
    const root = await harness.root(BACKGROUND_CONTEXT);
    const id = await root.commit(
      async (tx) => await tx.createTask(work, null, { ownership: { kind: "conversation" } }),
      BACKGROUND_CONTEXT,
    );
    const asleep = new Promise<void>((resolve) => {
      sleeping = resolve;
    });
    harness.resume();
    await asleep;
    await harness.close(BACKGROUND_CONTEXT);
    expect(await storage.task(id, BACKGROUND_CONTEXT)).toMatchObject({
      state: { status: "sleeping", until: 6000, checkpoint: { phase: "wake" } },
    });
    harness = await Harness.open(storage, options, BACKGROUND_CONTEXT);
    harness.resume();
    expect((await harness.inspect(BACKGROUND_CONTEXT)).tasks).toEqual([
      expect.objectContaining({ state: { kind: "sleeping", until: 6000 } }),
    ]);
    const { NoSimulationTask } = await import("determined");
    const { makeOrbRow } = await import("../../testkit/fixtures.ts");
    const task = new NoSimulationTask("sleeping-demand", false);
    const orb = makeOrbRow("sleeping", "project", "stopped");
    const ctx = { signal: new AbortController().signal };
    expect((await authority.recoveryDemand(task, orb, ctx))._unsafeUnwrap()).toBe(true);
    now = 5999;
    for (const [callback, until] of timers)
      if (until <= now) {
        timers.delete(callback);
        callback();
      }
    expect(wakes).toBe(0);
    expect((await harness.inspect(BACKGROUND_CONTEXT)).tasks[0]?.state.kind).toBe("sleeping");
    now = 6000;
    for (const [callback, until] of timers)
      if (until <= now) {
        timers.delete(callback);
        callback();
      }
    await (await harness.conversation(root.id, BACKGROUND_CONTEXT))!.waitForIdle(
      BACKGROUND_CONTEXT,
    );
    expect(wakes).toBe(1);
    expect((await authority.recoveryDemand(task, orb, ctx))._unsafeUnwrap()).toBe(false);
    expect(await storage.task(id, BACKGROUND_CONTEXT)).toMatchObject({
      state: {
        status: "terminal",
        outcome: { status: "completed" },
      },
    });
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
    await authority.close();
  }
});

it("reports a parked background task without failing root health or leaking private facts", async () => {
  const { okAsync } = await import("neverthrow");
  const authority = new MemoryAgentPersistence();
  const storage = (await authority.openOrb("parked", false))._unsafeUnwrap().storage;
  const work = defineTask<null, { phase: "run" }, null>({
    name: "parked-work",
    version: 1,
    initial: () => ({ phase: "run" }),
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
    phases: {
      run: async () => {
        throw new Error("PRIVATE: parked work must not run");
      },
    },
  });
  const registry = createRegistry();
  registry.install({ name: "parked-work", tasks: [work] });
  const seed = await Harness.open(
    storage,
    { models: createModels(), registry },
    BACKGROUND_CONTEXT,
  );
  const root = await seed.root(BACKGROUND_CONTEXT);
  const id = await root.commit(
    (tx) => tx.createTask(work, null, { ownership: { kind: "conversation" }, background: true }),
    BACKGROUND_CONTEXT,
  );
  await seed.close(BACKGROUND_CONTEXT);
  const record = (await storage.task(id, BACKGROUND_CONTEXT))!;
  await storage.commit(
    [
      {
        type: "task",
        value: {
          ...record,
          restarts: 5,
          state: { status: "pending", checkpoint: { phase: "run" } },
        },
      },
    ],
    BACKGROUND_CONTEXT,
  );
  const edges: unknown[] = [];
  const agent = (
    await DurableAgent.open({
      orbId: "parked",
      storage,
      models: createModels(),
      registry,
      env: new NodeExecutionEnv({ cwd: "/tmp" }),
      checkoutCommit: null,
      instructions: "test",
      edge: (code, facts) => {
        edges.push({ code, ...facts });
        return okAsync(undefined);
      },
    })
  )._unsafeUnwrap();
  try {
    expect(agent.health()).toMatchObject({ status: "ready", activity: "busy" });
    expect(agent.snapshot()._unsafeUnwrap().notice).toMatchObject({
      code: "central_agent_paused",
      message: "Background task paused after five consecutive interruptions without progress",
    });
    expect(edges).toContainEqual(
      expect.objectContaining({
        code: "harness.execution_blocked",
        type: "task_parked",
        task: id,
        conversation: root.id,
        kind: "parked-work",
        restarts: 5,
        limit: 5,
      }),
    );
    expect(JSON.stringify(edges)).not.toContain("PRIVATE");
  } finally {
    await agent.close();
    await authority.close();
  }
});
