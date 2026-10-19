import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  CompactionTask,
  createRegistry,
  Harness,
  hook,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { expect, it } from "vitest";

const ctx = BACKGROUND_CONTEXT;

it.each(["idle", "busy"] as const)(
  "admits a finite %s backlog before the next inference",
  async (state) => {
    const models = createModels();
    const faux = fauxProvider();
    const contexts: string[] = [];
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    faux.setResponses([
      async (request) => {
        contexts.push(JSON.stringify(request.messages));
        if (state === "busy") {
          started();
          await held;
        }
        return fauxAssistantMessage("answer");
      },
      (request) => {
        contexts.push(JSON.stringify(request.messages));
        return fauxAssistantMessage("backlog answer");
      },
    ]);
    models.setProvider(faux.provider);
    const storage = new MemoryStorage();
    const harness = await Harness.open(
      storage,
      {
        models,
        registry: createRegistry(),
        settings: { steeringMode: "all", followUpMode: "all" },
      },
      ctx,
    );
    try {
      const root = await harness.root(ctx, {
        agent: { model: { provider: "faux", modelId: "faux-1" } },
      });
      if (state === "busy") {
        await root.submit({ type: "input", content: "initial" }, ctx);
        await entered;
      }
      const drafts = ["peer A", "human", "peer B"].map((content, index) => ({
        type: "input" as const,
        content,
        requestId: `inbox:${index}`,
        whenBusy: "steer" as const,
        ...(index === 1 ? {} : { entry: { kind: "orb.peer-test", data: { sender: content } } }),
      }));
      const admitted = (await root.submitMany(drafts, ctx)).submissions;
      expect(new Set(admitted.map((submission) => submission.id)).size).toBe(3);
      release();
      await root.waitForIdle(ctx);
      expect(contexts).toHaveLength(state === "busy" ? 2 : 1);
      const next = contexts.at(-1)!;
      expect(next.indexOf("peer A")).toBeLessThan(next.indexOf("human"));
      expect(next.indexOf("human")).toBeLessThan(next.indexOf("peer B"));
      const entries = (await root.entries({ order: "ascending" }, 100, undefined, ctx)).items;
      expect(
        entries.filter((entry) => entry.kind === "orb.peer-test").map((entry) => entry.data),
      ).toEqual([{ sender: "peer A" }, { sender: "peer B" }]);
      const replay = (await root.submitMany(drafts, ctx)).submissions;
      expect(replay.map((submission) => submission.id)).toEqual(
        admitted.map((submission) => submission.id),
      );
      await root.waitForIdle(ctx);
      expect(contexts).toHaveLength(state === "busy" ? 2 : 1);
    } finally {
      release();
      await harness.close(ctx);
    }
  },
);

it("includes admitted steering snapshots in the next provider retry without resetting its attempt", async () => {
  const models = createModels();
  const faux = fauxProvider();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let retryContext = "";
  faux.setResponses([
    async () => {
      entered();
      await held;
      return fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit" });
    },
    (request) => {
      retryContext = JSON.stringify(request.messages);
      return fauxAssistantMessage("retried answer");
    },
  ]);
  models.setProvider(faux.provider);
  const storage = new MemoryStorage();
  const harness = await Harness.open(
    storage,
    {
      models,
      registry: createRegistry(),
      settings: {
        steeringMode: "all",
        followUpMode: "all",
        retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
      },
    },
    ctx,
  );
  try {
    const root = await harness.root(ctx, {
      agent: { model: { provider: "faux", modelId: "faux-1" } },
    });
    await root.submit({ type: "input", content: "initial", requestId: "initial" }, ctx);
    await started;
    const queued = (
      await root.submitMany(
        ["retry A", "retry B"].map((content) => ({
          type: "input" as const,
          content,
          requestId: content,
          whenBusy: "steer" as const,
        })),
        ctx,
      )
    ).submissions;
    release();
    await root.waitForIdle(ctx);
    expect(retryContext).toContain("retry A");
    expect(retryContext).toContain("retry B");
    expect(faux.state.callCount).toBe(2);
    for (const submission of queued)
      expect(await submission.status(ctx)).toMatchObject({ status: "done" });
    const tasks = await storage.scanTasks({}, 100, undefined, ctx);
    expect(tasks.items.filter((task) => task.kind === "pi.generation")).toHaveLength(1);
  } finally {
    release();
    await harness.close(ctx);
  }
});

it("starts queued input after overflow compaction declines without retrying failed input", async () => {
  const models = createModels();
  const faux = fauxProvider();
  let entered!: () => void;
  const compacting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let queuedContext = "";
  faux.setResponses([
    fauxAssistantMessage("first answer"),
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" }),
    (request) => {
      queuedContext = JSON.stringify(request.messages);
      return fauxAssistantMessage("queued answer");
    },
  ]);
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install({
    name: "decline-compaction",
    hooks: [
      hook(CompactionTask, {
        beforeCompact: async () => {
          entered();
          await held;
          return { decline: true as const };
        },
      }),
    ],
  });
  const harness = await Harness.open(
    new MemoryStorage(),
    {
      models,
      registry,
      settings: { steeringMode: "all", followUpMode: "all", compaction: { keepRecentTokens: 1 } },
    },
    ctx,
  );
  try {
    const root = await harness.root(ctx, {
      agent: { model: { provider: "faux", modelId: "faux-1" } },
    });
    await root.submit({ type: "input", content: "first" }, ctx);
    await root.waitForIdle(ctx);
    const failed = await root.submit({ type: "input", content: "overflow" }, ctx);
    await compacting;
    const queued = (
      await root.submitMany(
        [{ type: "input", content: "after compaction", whenBusy: "steer" }],
        ctx,
      )
    ).submissions;
    release();
    await root.waitForIdle(ctx);
    expect(await failed.status(ctx)).toMatchObject({ status: "unanswered", reason: "model_error" });
    expect(await queued[0]!.status(ctx)).toMatchObject({ status: "done" });
    expect(queuedContext).toContain("after compaction");
    expect(faux.state.callCount).toBe(3);
  } finally {
    release();
    await harness.close(ctx);
  }
});
