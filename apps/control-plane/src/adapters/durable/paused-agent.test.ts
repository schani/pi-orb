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

it.each(["retry", "abort"] as const)(
  "parks five interrupted starts and permits %s without trace persistence",
  async (action) => {
    const { MemoryStorage } = await import("@earendil-works/pi-durable");
    const backend = new MemoryStorage();
    let dropCloseWrites = false;
    const storage = new Proxy(backend, {
      get(target, key) {
        if (key === "close") return async () => undefined;
        if (key === "commit")
          return async (...args: Parameters<typeof backend.commit>) =>
            dropCloseWrites ? 1 : target.commit(...args);
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    let finish = false;
    let started!: () => void;
    const reports: unknown[] = [];
    const work = defineTask<null, { phase: "run" }, null>({
      name: "interrupted-work",
      version: 1,
      initial: () => ({ phase: "run" }),
      abort: (_task, runtime, ctx) =>
        runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
      phases: {
        run: async (_task, runtime, ctx) => {
          started();
          if (finish) {
            await runtime.commit(
              () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
              ctx,
            );
          } else {
            await new Promise<void>((resolve) => {
              if (ctx.abortSignal?.aborted) resolve();
              else ctx.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
            });
          }
        },
      },
    });
    const registry = createRegistry();
    registry.install({ name: "interrupted-work", tasks: [work] });
    const open = () =>
      Harness.open(
        storage,
        {
          models: createModels(),
          registry,
          now: () => 1000,
          onReport: (_error, info) => reports.push(info),
        },
        BACKGROUND_CONTEXT,
      );
    let harness = await open();
    try {
      const root = await harness.root(BACKGROUND_CONTEXT);
      const id = await root.commit(
        async (tx) => await tx.createTask(work, null, { ownership: { kind: "conversation" } }),
        BACKGROUND_CONTEXT,
      );
      for (let cut = 0; cut < 5; cut++) {
        const running = new Promise<void>((resolve) => {
          started = resolve;
        });
        harness.resume();
        await running;
        const record = await backend.task(id, BACKGROUND_CONTEXT);
        expect(record?.state.status).toBe("running");
        expect(record).not.toHaveProperty("trace");
        expect(record).not.toHaveProperty("links");
        // Process cutoff: discard only the graceful-close restoration write.
        dropCloseWrites = true;
        await harness.close(BACKGROUND_CONTEXT);
        dropCloseWrites = false;
        harness = await open();
      }
      expect(await backend.task(id, BACKGROUND_CONTEXT)).toMatchObject({
        restarts: 5,
        state: { status: "pending" },
      });
      expect((await harness.inspect(BACKGROUND_CONTEXT)).tasks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            record: expect.objectContaining({ id, restarts: 5 }),
            state: expect.objectContaining({ kind: "blocked", reason: "restart_limit" }),
          }),
        ]),
      );
      expect(reports).toEqual([
        expect.objectContaining({ type: "task_parked", task: expect.objectContaining({ id }) }),
      ]);
      finish = true;
      started = () => undefined;
      if (action === "retry") await harness.retryTask(id, BACKGROUND_CONTEXT);
      else await harness.abortTask(id, BACKGROUND_CONTEXT);
      harness.resume();
      await (await harness.conversation(root.id, BACKGROUND_CONTEXT))!.waitForIdle(
        BACKGROUND_CONTEXT,
      );
      expect(await backend.task(id, BACKGROUND_CONTEXT)).toMatchObject({
        state: {
          status: "terminal",
          outcome: { status: action === "retry" ? "completed" : "aborted" },
        },
      });
      expect(await backend.task(id, BACKGROUND_CONTEXT)).not.toHaveProperty("restarts");
      await (await harness.conversation(root.id, BACKGROUND_CONTEXT))!.submit(
        { type: "write", entry: { kind: "test.receipt", data: null } },
        BACKGROUND_CONTEXT,
      );
      const submissions = await backend.scanSubmissions({}, 100, undefined, BACKGROUND_CONTEXT);
      expect(submissions.items).toHaveLength(1);
      for (const submission of submissions.items) expect(submission).not.toHaveProperty("trace");
    } finally {
      dropCloseWrites = false;
      await harness.close(BACKGROUND_CONTEXT);
      await backend.close(BACKGROUND_CONTEXT);
    }
  },
);

it.each(["abort", "wake"] as const)(
  "keeps sleeping checkpoints across reopen until controlled %s",
  async (action) => {
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
      if (action === "abort") await harness.abortTask(id, BACKGROUND_CONTEXT);
      else {
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
      }
      await (await harness.conversation(root.id, BACKGROUND_CONTEXT))!.waitForIdle(
        BACKGROUND_CONTEXT,
      );
      expect(wakes).toBe(action === "wake" ? 1 : 0);
      expect((await authority.recoveryDemand(task, orb, ctx))._unsafeUnwrap()).toBe(false);
      expect(await storage.task(id, BACKGROUND_CONTEXT)).toMatchObject({
        state: {
          status: "terminal",
          outcome: { status: action === "wake" ? "completed" : "aborted" },
        },
      });
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
      await authority.close();
    }
  },
);

it.each([
  ["running", false],
  ["pending", false],
  ["running", true],
  ["pending", true],
] as const)(
  "shows the interruption pause after reopening %s work (background=%s)",
  async (status, background) => {
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
      (tx) => tx.createTask(work, null, { ownership: { kind: "conversation" }, background }),
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
            restarts: status === "running" ? 4 : 5,
            state: { status, checkpoint: { phase: "run" } },
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
      expect(agent.health()).toMatchObject({ status: "ready" });
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
  },
);
