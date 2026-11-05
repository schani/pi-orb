import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  ConversationIdle,
  type Cursor,
  createRegistry,
  type EntryRecord,
  GenerationTask,
  Harness,
  LiveDoc,
  MemoryStorage,
  type Report,
  type Storage,
} from "@earendil-works/pi-durable";
import { expect, it } from "vitest";

const context = BACKGROUND_CONTEXT;

function retained(storage: MemoryStorage): Storage {
  return new Proxy(storage, {
    get(target, key) {
      if (key === "close") return async () => undefined;
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

it("observes memory-first progress before stored publication, then closes each native observer", async () => {
  const storage = new MemoryStorage();
  const harness = await Harness.open(
    storage,
    { models: createModels(), registry: createRegistry() },
    context,
  );
  try {
    const root = await harness.root(context);
    await root.commit(async (tx) => {
      await tx.doc(LiveDoc, root.id);
    }, context);
    const views: unknown[] = [];
    const graphs: unknown[] = [];
    const publications: unknown[] = [];
    const ends: unknown[] = [];
    const view = await harness.observeConversation(
      root.id,
      {
        advance: (call) => views.push(call),
        end: (end) => ends.push(end),
      },
      context,
    );
    const graph = await harness.observeTaskGraph(
      {
        advance: (call) => graphs.push(call),
        end: (end) => ends.push(end),
      },
      context,
    );
    const commits = harness.observeCommits({
      advance: (publication) => publications.push(publication),
      end: (end) => ends.push(end),
    });
    expect(view.value.conversation.id).toBe(root.id);
    expect(graph.value.tasks).toEqual({});
    await root.commit(
      async (tx) => {
        (await tx.doc(LiveDoc, root.id)).generation = { attempt: 1 };
      },
      context,
      { persistence: { kind: "deferred", withinMs: Infinity } },
    );
    expect(views).toHaveLength(1);
    expect(publications).toHaveLength(0);
    expect(graphs).toHaveLength(0);
    await harness.close(context);
    expect(publications).toHaveLength(1);
    expect(ends).toHaveLength(3);
    expect(await harness.closed).toEqual({ kind: "closed" });
    view.detach();
    graph.detach();
    commits.detach();
  } finally {
    await harness.close(context);
  }
});

it.each([1, 2])(
  "charges interrupted request attempt %i against native retry policy without resending",
  async (attempt) => {
    const backend = new MemoryStorage();
    const storage = retained(backend);
    const models = createModels();
    const faux = fauxProvider();
    let calls = 0;
    faux.setResponses([
      () => {
        calls++;
        return fauxAssistantMessage("retried answer");
      },
    ]);
    models.setProvider(faux.provider);
    let now = 1000;
    const timers = new Map<() => void, number>();
    const reports: Report[] = [];
    let terminated!: () => void;
    const interruptionReported = new Promise<void>((resolve) => {
      terminated = resolve;
    });
    let sleeping!: () => void;
    const asleep = new Promise<void>((resolve) => {
      sleeping = resolve;
    });
    const options = {
      models,
      registry: createRegistry(),
      now: () => now,
      settings: {
        retry: { enabled: true, maxRetries: 1, baseDelayMs: 100 },
        afterFailedRun: "continue" as const,
      },
      setTimer: (callback: () => void, delay: number) => {
        timers.set(callback, now + delay);
        return () => {
          timers.delete(callback);
        };
      },
      onReport: (report: Report) => {
        reports.push(report);
        if (report.kind === "task_interrupted") terminated();
      },
    };
    let harness = await Harness.open(storage, options, context);
    try {
      const root = await harness.root(context, {
        agent: { model: { provider: "faux", modelId: "faux-1" } },
      });
      const seeded = await root.commit(async (tx) => {
        const entry = await tx.appendEntry(root.id, {
          kind: "pi.user",
          data: {},
          model: [{ role: "user", content: "question", timestamp: now }],
        });
        const submission = await tx.createSubmission({
          conversationId: root.id,
          requestId: "interrupted-input",
          type: "input",
          status: "placed",
          entry: entry.id,
        });
        const taskId = await tx.createTask(
          GenerationTask,
          {},
          { ownership: { kind: "conversation" } },
        );
        (await tx.doc(LiveDoc, root.id)).run = {
          taskId,
          inputs: [submission.id],
          turns: 0,
          first: entry.id,
        };
        return { taskId, entryId: entry.id, submissionId: submission.id };
      }, context);
      await harness.close(context);
      const record = (await backend.task(seeded.taskId, context))!;
      await backend.commit(
        [
          [
            {
              type: "task",
              value: {
                ...record,
                version: 1,
                restarts: 0,
                state: {
                  status: "running",
                  checkpoint: {
                    phase: "request",
                    attempt,
                    model: { provider: "faux", modelId: "faux-1" },
                    thinkingLevel: "off",
                    streamOptions: {},
                    cutoff: seeded.entryId,
                  },
                },
              },
            },
          ],
        ],
        () => undefined,
        context,
      );
      harness = await Harness.open(storage, options, context);
      const reopened = (await harness.conversation(root.id, context))!;
      const graph = await harness.observeTaskGraph(
        {
          advance: (call) => {
            if (
              call.kind === "value" &&
              Object.values(call.value.tasks).some((task) => task.state.status === "sleeping")
            )
              sleeping();
          },
          end: () => undefined,
        },
        context,
      );
      harness.resume();
      if (attempt === 1) {
        await asleep;
        expect(calls).toBe(0);
        expect(await backend.task(seeded.taskId, context)).toMatchObject({
          state: { status: "sleeping", until: 1100, checkpoint: { phase: "retry", attempt: 1 } },
        });
        expect(await backend.submission(seeded.submissionId, context)).toMatchObject({
          status: "placed",
        });
        now = 1099;
        for (const [callback, at] of timers)
          if (at <= now) {
            timers.delete(callback);
            callback();
          }
        expect(calls).toBe(0);
        now = 1100;
        for (const [callback, at] of timers)
          if (at <= now) {
            timers.delete(callback);
            callback();
          }
        await reopened.waitForIdle(context);
        expect(calls).toBe(1);
        expect(await backend.submission(seeded.submissionId, context)).toMatchObject({
          status: "done",
        });
      } else {
        await interruptionReported;
        await reopened.waitForIdle(context);
        expect(calls).toBe(0);
        expect(await backend.task(seeded.taskId, context)).toMatchObject({
          state: {
            status: "terminal",
            outcome: { status: "failed", error: { detail: { reason: "interrupted" } } },
          },
        });
        expect(await backend.submission(seeded.submissionId, context)).toMatchObject({
          status: "unanswered",
          reason: "interrupted",
        });
        expect(reports).toContainEqual(
          expect.objectContaining({ kind: "task_interrupted", reason: "interrupted" }),
        );
      }
      expect(await backend.task(seeded.taskId, context)).toMatchObject({ version: 2 });
      expect((await backend.entry(seeded.entryId, context))?.entry).toMatchObject({
        model: [{ role: "user", content: "question", timestamp: 1000 }],
      });
      graph.detach();
      await harness.close(context);
      harness = await Harness.open(storage, options, context);
      expect(
        await backend.submissionByRequest(root.id, "interrupted-input", context),
      ).toMatchObject({
        id: seeded.submissionId,
        status: attempt === 1 ? "done" : "unanswered",
      });
    } finally {
      await harness.close(context);
      await backend.close(context);
    }
  },
);

it("keeps the complete transcript and native model context outside the bounded live window", async () => {
  const storage = new MemoryStorage();
  const harness = await Harness.open(
    storage,
    { models: createModels(), registry: createRegistry() },
    context,
  );
  try {
    const root = await harness.root(context);
    await root.commit(async (tx) => {
      for (let index = 0; index < 125; index++)
        await tx.appendEntry(root.id, {
          kind: "pi.message",
          model: [{ role: "user", content: `entry-${index}`, timestamp: index }],
        });
    }, context);
    const watch = await root.watch(context);
    expect(watch.value.entries).toHaveLength(50);
    expect(watch.value.before).toBeDefined();
    const entries: EntryRecord[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await root.entries({ order: "ascending" }, 32, cursor, context);
      entries.push(...page.items);
      cursor = page.next;
    } while (cursor !== undefined);
    expect(entries).toHaveLength(125);
    expect((await root.context(context)).messages).toHaveLength(125);
    await watch.stop();
  } finally {
    await harness.close(context);
  }
});

it("applies native whenIdle rejection only to new admissions and preserves duplicate receipt authority", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const answering = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const models = createModels();
  const faux = fauxProvider();
  let calls = 0;
  faux.setResponses([
    async () => {
      calls++;
      entered();
      await held;
      return fauxAssistantMessage("answer");
    },
  ]);
  models.setProvider(faux.provider);
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry: createRegistry() },
    context,
  );
  try {
    const root = await harness.root(context, {
      agent: { model: { provider: "faux", modelId: "faux-1" } },
    });
    await expect(
      root.submitMany(
        [{ type: "input", content: "reject", requestId: "rejected", whenIdle: "reject" }],
        context,
      ),
    ).rejects.toBeInstanceOf(ConversationIdle);
    const admitted = await root.submitMany(
      [{ type: "input", content: "question", requestId: "accepted" }],
      context,
    );
    await answering;
    const busyDuplicate = await root.submitMany(
      [{ type: "input", content: "question", requestId: "accepted", whenIdle: "reject" }],
      context,
    );
    expect(busyDuplicate.submissions[0]!.id).toBe(admitted.submissions[0]!.id);
    release();
    await root.waitForIdle(context);
    const settledDuplicate = await root.submitMany(
      [{ type: "input", content: "question", requestId: "accepted", whenIdle: "reject" }],
      context,
    );
    expect(settledDuplicate.submissions[0]!.id).toBe(admitted.submissions[0]!.id);
    expect(calls).toBe(1);
    expect((await harness.submission(admitted.submissions[0]!.id, context))!.id).toBe(
      admitted.submissions[0]!.id,
    );
  } finally {
    release();
    await harness.close(context);
  }
});

it("reads pi.live v1 through native migration and upgrades only its next mutation without rewriting receipts or entries", async () => {
  const backend = new MemoryStorage();
  const storage = retained(backend);
  const options = { models: createModels(), registry: createRegistry() };
  let harness = await Harness.open(storage, options, context);
  try {
    const root = await harness.root(context);
    const seeded = await root.commit(async (tx) => {
      const entry = await tx.appendEntry(root.id, {
        kind: "pi.message",
        model: [{ role: "user", content: "retained", timestamp: 0 }],
      });
      const submission = await tx.createSubmission({
        conversationId: root.id,
        requestId: "old-input",
        type: "input",
        status: "placed",
        entry: entry.id,
      });
      const taskId = await tx.createTask(
        GenerationTask,
        {},
        { ownership: { kind: "conversation" } },
      );
      return { entry, submission, taskId };
    }, context);
    await harness.close(context);
    const address = {
      kind: "pi.live",
      scope: { kind: "conversation" as const, conversationId: root.id },
    };
    const document = (await backend.findDocument(address, "current", context))!;
    await backend.commit(
      [
        [
          {
            type: "document.change",
            id: document.id,
            content: {
              kind: "base",
              version: 1,
              value: {
                run: {
                  taskId: seeded.taskId,
                  inputs: [seeded.submission.id],
                  first: seeded.entry.id,
                },
                compactionFailure: {
                  taskId: seeded.taskId,
                  reason: "manual",
                  error: "old failure",
                },
              },
            },
          },
        ],
      ],
      () => undefined,
      context,
    );
    expect(await backend.document(document.id, "current", context)).toMatchObject({ version: 1 });
    const originalEntry = await backend.entry(seeded.entry.id, context);
    harness = await Harness.open(storage, options, context);
    expect(await harness.snapshot(LiveDoc, root.id, context)).toMatchObject({
      run: { turns: 0 },
      compactionFailure: { trigger: "manual", error: "old failure" },
    });
    expect(await backend.document(document.id, "current", context)).toMatchObject({ version: 1 });
    await harness.commit(async (tx) => {
      (await tx.doc(LiveDoc, root.id)).generation = { attempt: 1 };
    }, context);
    expect(await backend.document(document.id, "current", context)).toMatchObject({
      version: LiveDoc.definition.version,
    });
    expect(await backend.entry(seeded.entry.id, context)).toEqual(originalEntry);
    expect(await backend.submissionByRequest(root.id, "old-input", context)).toEqual(
      seeded.submission,
    );
  } finally {
    await harness.close(context);
    await backend.close(context);
  }
});
