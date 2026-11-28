import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import {
  type CommitPublication,
  type Conversation,
  createRegistry,
  defineExtension,
  defineTask,
  type Extension,
  GenerationTask,
  Harness,
  hook,
  hookTask,
  MemoryStorage,
  type Storage,
  type SubmissionRecord,
} from "@earendil-works/pi-durable";
import { GOAL_OBJECTIVE_MAX_LENGTH, GOAL_REASON_MAX_LENGTH, type GoalView } from "@pi-orb/protocol";
import { err, ok } from "neverthrow";
import { expect, it } from "vitest";
import {
  changeGoal,
  GOAL_REQUEST_PREFIX,
  type GoalAction,
  type GoalAdmission,
  GoalDoc,
  GoalInput,
  goalExtension,
  MAX_GOAL_FOLLOWUPS,
  readGoal,
  recordGoalResult,
} from "./goal.ts";

const ctx = BACKGROUND_CONTEXT;
const objective = "Fixture objective";
const kick = "Fixture kickoff";
const follow = "Fixture follow-up";

let nextRequest = 0;
async function mutateGoal(conversation: Conversation, action: GoalAction, context = ctx) {
  return (await changeGoal(conversation, String(++nextRequest), action, context)).map(
    ({ goal }) => goal,
  );
}

function barrier() {
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reached, release };
}

async function setup(
  respond?: FauxResponseFactory,
  extensions: Extension[] = [],
  admission?: GoalAdmission,
  formatFollowUp = () => follow,
) {
  const fake = fauxProvider();
  const received: string[] = [];
  fake.setResponses(
    Array.from({ length: 12 }, () => async (...args: Parameters<FauxResponseFactory>) => {
      const user = args[0].messages.findLast((message) => message.role === "user");
      received.push(String(user?.content));
      return respond ? respond(...args) : fauxAssistantMessage("Fixture answer");
    }),
  );
  const registry = createRegistry();
  registry.install(goalExtension(formatFollowUp, admission));
  for (const extension of extensions) registry.install(extension);
  const models = createModels();
  models.setProvider(fake.provider);
  const backend = new MemoryStorage();
  const storage: Storage = new Proxy(backend, {
    get(target, key) {
      if (key === "close") return async () => undefined;
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const options = { models, registry };
  const harness = await Harness.open(storage, options, ctx);
  const root = await harness.root(ctx, {
    agent: { model: { provider: "faux", modelId: "faux-1" } },
  });
  const commits: CommitPublication[] = [];
  const nativeInputs = new Map<SubmissionRecord["id"], SubmissionRecord>();
  const followUpQueued = barrier();
  const observer = harness.observeCommits({
    advance(publication) {
      commits.push(publication);
      for (const change of publication.changes) {
        if (
          change.type !== "submission" ||
          !change.value.requestId?.startsWith(GOAL_REQUEST_PREFIX)
        )
          continue;
        nativeInputs.set(change.value.id, change.value);
        if (nativeInputs.size > 1 && change.value.status === "queued") followUpQueued.release();
      }
    },
    end() {},
  });
  const set = async () =>
    (
      await mutateGoal(root, { type: "goal_set", objective, input: kick }, ctx)
    )._unsafeUnwrap() as GoalView;
  return {
    root,
    harness,
    storage,
    options,
    commits,
    received,
    nativeInputs,
    followUpQueued,
    set,
    view: async () => (await readGoal(harness, ctx))._unsafeUnwrap(),
    close: async () => {
      observer.detach();
      await harness.close(ctx);
    },
  };
}

async function setupWithHeldAnswer() {
  const requesting = barrier();
  const answer = barrier();
  const test = await setup(async () => {
    requesting.release();
    await answer.reached;
    return fauxAssistantMessage("Fixture answer");
  });
  return {
    ...test,
    modelEntered: requesting.reached,
    releaseAnswer: answer.release,
    close: async () => {
      answer.release();
      await test.close();
    },
  };
}

it("commits the goal and typed kickoff together and stops at the fixed follow-up cap", async () => {
  const test = await setup();
  try {
    const started = await test.set();
    expect(started).toMatchObject({ objective, status: "active" });
    await test.root.waitForIdle(ctx);
    expect(test.received).toEqual([
      kick,
      ...Array.from({ length: MAX_GOAL_FOLLOWUPS }, () => follow),
    ]);
    const blocked = await test.view();
    assert(blocked);
    expect(blocked).toMatchObject({
      objective,
      status: "blocked",
      reason: "Automatic turn limit reached.",
    });
    expect(blocked.revision).not.toBe(started.revision);

    const startCommit = test.commits.find((publication) =>
      publication.changes.some((change) => change.type === "entry" && GoalInput.is(change.value)),
    );
    expect(startCommit?.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "document",
          record: expect.objectContaining({ kind: GoalDoc.definition.kind }),
        }),
        expect.objectContaining({
          type: "submission",
          value: expect.objectContaining({ type: "input", status: "placed" }),
        }),
      ]),
    );
    const entries = (await test.root.entries({}, 100, undefined, ctx)).items
      .filter(GoalInput.is)
      .reverse();
    expect(entries.map((entry) => entry.data)).toEqual(
      [0, ...Array.from({ length: MAX_GOAL_FOLLOWUPS }, (_, i) => i + 1)].map((turn) => ({
        revision: started.revision,
        turn,
      })),
    );
    const cleared = await mutateGoal(test.root, { type: "goal_clear", revision: blocked.revision });
    expect(cleared._unsafeUnwrap()).toBeUndefined();
    expect(await test.view()).toBeUndefined();
  } finally {
    await test.close();
  }
});

it.each(["input", "reset"] as const)("yields to a competing queued native %s", async (kind) => {
  const test = await setupWithHeldAnswer();
  try {
    await test.set();
    await test.modelEntered;
    if (kind === "input") {
      const human = await test.root.submit(
        { type: "input", whenBusy: "followUp", content: "Fixture human" },
        ctx,
      );
      test.releaseAnswer();
      expect(await human.wait(ctx)).toMatchObject({ status: "done" });
    } else {
      await test.root.reset(undefined, ctx);
      test.releaseAnswer();
    }
    await test.root.waitForIdle(ctx);
    expect(test.nativeInputs.size).toBe(1);
    expect(test.received).toEqual(kind === "input" ? [kick, "Fixture human"] : [kick]);
    expect(await test.view()).toMatchObject({
      status: "paused",
      reason: kind === "input" ? "Other input was queued." : "A context reset was queued.",
    });
  } finally {
    await test.close();
  }
});

it("a queued kickoff cannot continue from another run's answer", async () => {
  const test = await setupWithHeldAnswer();
  try {
    await test.root.submit({ type: "input", content: "Fixture human" }, ctx);
    await test.modelEntered;
    await test.set();
    test.releaseAnswer();
    await test.root.waitForIdle(ctx);
    expect(test.received.slice(0, 3)).toEqual(["Fixture human", kick, follow]);
    const [start, continuation] = [...test.nativeInputs.values()];
    expect(start?.status).toBe("done");
    const continuationAdmission = test.commits.find(({ changes }) =>
      changes.some(
        (change) => change.type === "submission" && change.value.id === continuation?.id,
      ),
    );
    // The kickoff must already have settled when its continuation is admitted.
    const kickoffSettlement = test.commits.find(({ changes }) =>
      changes.some(
        (change) =>
          change.type === "submission" &&
          change.value.id === start?.id &&
          change.value.status === "done",
      ),
    );
    expect(kickoffSettlement?.seq).toBeLessThan(continuationAdmission?.seq ?? 0);
  } finally {
    await test.close();
  }
});

it("pausing after the hook reads the goal but before its task commits prevents admission", async () => {
  const entered = barrier();
  const proceed = barrier();
  const test = await setup(undefined, [
    defineExtension({
      name: "test.after-run-hook",
      hooks: [
        hook(GenerationTask, {
          async afterRun() {
            entered.release();
            await proceed.reached;
            return undefined;
          },
        }),
      ],
    }),
  ]);
  try {
    const started = await test.set();
    await entered.reached;
    const paused = (
      await mutateGoal(test.root, { type: "goal_pause", revision: started.revision }, ctx)
    )._unsafeUnwrap();
    expect(paused?.status).toBe("paused");
    proceed.release();
    await test.root.waitForIdle(ctx);
    expect(test.nativeInputs.size).toBe(1);
    expect(test.received).toEqual([kick]);
    expect(await test.view()).toEqual(paused);
  } finally {
    proceed.release();
    await test.close();
  }
});

it("Pause withdraws exactly the admitted goal follow-up; only then may Clear remove the goal", async () => {
  const proceed = barrier();
  const Hold = defineTask<null, { phase: "hold" }, null>({
    name: "test.after-run-hold",
    version: 1,
    initial: () => ({ phase: "hold" }),
    phases: {
      async hold(_task, runtime, context) {
        await proceed.reached;
        await runtime.commit(
          () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
          context,
        );
      },
    },
    abort: async (_task, runtime, context) =>
      runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  });
  const test = await setup(undefined, [
    defineExtension({
      name: "test.after-run-task",
      hooks: [hook(GenerationTask, { afterRun: () => ({ tasks: [hookTask(Hold, null)] }) })],
      tasks: [Hold],
    }),
  ]);
  try {
    const started = await test.set();
    await test.followUpQueued.reached;
    const queued = [...test.nativeInputs.values()].find((record) => record.status === "queued");
    assert(queued);
    const human = await test.root.submit({ type: "input", content: "Fixture human" }, ctx);
    const clear = await mutateGoal(
      test.root,
      { type: "goal_clear", revision: started.revision },
      ctx,
    );
    expect(clear._unsafeUnwrapErr()).toMatchObject({ code: "invalid_status" });
    const stopped = (
      await mutateGoal(test.root, { type: "goal_pause", revision: started.revision }, ctx)
    )._unsafeUnwrap();
    assert(stopped);
    expect(stopped.status).toBe("paused");
    expect(
      (
        await mutateGoal(test.root, { type: "goal_clear", revision: stopped.revision }, ctx)
      )._unsafeUnwrap(),
    ).toBeUndefined();
    expect(test.nativeInputs.get(queued.id)).toMatchObject({
      status: "unanswered",
      reason: "aborted",
    });
    expect(await human.status(ctx)).toMatchObject({ status: "queued" });
    proceed.release();
    expect(await human.wait(ctx)).toMatchObject({ status: "done" });
    await test.root.waitForIdle(ctx);
    expect(test.received).toEqual([kick, "Fixture human"]);
  } finally {
    proceed.release();
    await test.close();
  }
});

it("a placed turn finishes after Pause; Resume starts a new activation, and stale actions fail", async () => {
  const test = await setupWithHeldAnswer();
  try {
    const started = await test.set();
    await test.modelEntered;
    const paused = (
      await mutateGoal(test.root, { type: "goal_pause", revision: started.revision }, ctx)
    )._unsafeUnwrap() as GoalView;
    expect([...test.nativeInputs.values()][0]?.status).toBe("placed");
    test.releaseAnswer();
    await test.root.waitForIdle(ctx);
    expect([...test.nativeInputs.values()][0]?.status).toBe("done");
    expect(test.nativeInputs.size).toBe(1);
    expect(
      (
        await mutateGoal(test.root, { type: "goal_clear", revision: started.revision }, ctx)
      )._unsafeUnwrapErr(),
    ).toMatchObject({ code: "stale_revision" });
    const resumed = (
      await mutateGoal(
        test.root,
        {
          type: "goal_resume",
          revision: paused.revision,
          input: (savedObjective) => {
            expect(savedObjective).toBe(objective);
            return "Fixture resume";
          },
        },
        ctx,
      )
    )._unsafeUnwrap();
    expect(resumed).toMatchObject({ objective, status: "active" });
    expect(resumed?.revision).not.toBe(started.revision);
    await test.root.waitForIdle(ctx);
    expect(test.received.slice(0, 2)).toEqual([kick, "Fixture resume"]);
  } finally {
    await test.close();
  }
});

it("hashes receipt keys without aliasing distinct raw request IDs", async () => {
  const test = await setup();
  try {
    const start = { type: "goal_set", objective, input: kick } as const;
    const setId = "receipt:\u0000\uD800";
    const pauseId = "receipt:\u0000\uFFFD";
    const { goal } = (await changeGoal(test.root, setId, start, ctx))._unsafeUnwrap();
    assert(goal);
    const pause = { type: "goal_pause", revision: goal.revision } as const;
    expect((await changeGoal(test.root, pauseId, pause, ctx))._unsafeUnwrap()).toMatchObject({
      duplicate: false,
      goal: { status: "paused" },
    });
    expect((await changeGoal(test.root, setId, start, ctx))._unsafeUnwrap().duplicate).toBe(true);
    expect((await changeGoal(test.root, pauseId, pause, ctx))._unsafeUnwrap().duplicate).toBe(true);
    const stored = await test.harness.snapshot(GoalDoc, test.root.id, ctx);
    const keys = Object.keys(stored?.receipts ?? {});
    expect(keys).toEqual([
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.stringMatching(/^[a-f0-9]{64}$/),
    ]);
  } finally {
    await test.close();
  }
});

it("stops only on an explicit result for the current placed goal input", async () => {
  const test = await setupWithHeldAnswer();
  try {
    const started = await test.set();
    await test.modelEntered;
    const [input] = test.nativeInputs.values();
    assert(input);
    const identity = {
      revision: started.revision,
      submissionId: input.id,
      status: "placed",
    } as const;
    expect(
      (
        await test.root.commit(
          (tx) =>
            recordGoalResult(
              tx,
              test.root.id,
              { ...identity, revision: "stale" },
              { status: "complete" },
            ),
          ctx,
        )
      )._unsafeUnwrapErr(),
    ).toMatchObject({ code: "stale_revision" });
    const reason = "🚧".repeat(GOAL_REASON_MAX_LENGTH);
    const complete = (
      await test.root.commit(
        (tx) =>
          recordGoalResult(tx, test.root.id, identity, {
            status: "complete",
            reason: `\u0000\uD800${reason}🚧\uDFFF`,
          }),
        ctx,
      )
    )._unsafeUnwrap();
    expect(complete).toMatchObject({ status: "complete", reason });
    test.releaseAnswer();
    await test.root.waitForIdle(ctx);
    expect(await test.view()).toEqual(complete);
    expect(test.received).toEqual([kick]);
  } finally {
    await test.close();
  }
});

it("exposes native abort as an interrupted goal without scheduling a follow-up", async () => {
  const requesting = barrier();
  const test = await setup(async (_request, options) => {
    requesting.release();
    await new Promise<void>((resolve) => {
      if (options?.signal?.aborted) resolve();
      else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return fauxAssistantMessage("Fixture answer");
  });
  try {
    await test.set();
    await requesting.reached;
    await test.root.abort(ctx);
    expect(await test.view()).toMatchObject({
      objective,
      status: "paused",
      reason: "Goal turn was aborted.",
    });
    expect([...test.nativeInputs.values()]).toEqual([
      expect.objectContaining({ status: "unanswered", reason: "aborted" }),
    ]);
  } finally {
    await test.close();
  }
});

it("keeps clear receipts after reload and detects same-ID conflicts before admission", async () => {
  const test = await setupWithHeldAnswer();
  const deny: GoalAdmission = () => err({ disposition: "denied", reason: "sleep" });
  let formats = 0;
  const format = () => {
    formats++;
    return kick;
  };
  try {
    const set = { type: "goal_set", objective, input: format } as const;
    const started = (await changeGoal(test.root, "set", set, ctx))._unsafeUnwrap();
    expect(started.duplicate).toBe(false);
    assert(started.goal);
    await test.modelEntered;
    const stopped = (
      await mutateGoal(test.root, { type: "goal_pause", revision: started.goal.revision })
    )._unsafeUnwrap();
    assert(stopped);
    const action = { type: "goal_clear", revision: stopped.revision } as const;
    expect((await changeGoal(test.root, "clear-request", action, ctx))._unsafeUnwrap()).toEqual({
      goal: undefined,
      duplicate: false,
    });
    test.releaseAnswer();
    await test.root.waitForIdle(ctx);
    await test.close();
    const reopened = await Harness.open(test.storage, test.options, ctx);
    try {
      const root = await reopened.root(ctx);
      expect((await changeGoal(root, "set", set, ctx, deny))._unsafeUnwrap()).toEqual({
        goal: undefined,
        duplicate: true,
      });
      expect((await changeGoal(root, "clear-request", action, ctx, deny))._unsafeUnwrap()).toEqual({
        goal: undefined,
        duplicate: true,
      });
      expect(
        (await changeGoal(root, "clear-request", set, ctx, deny))._unsafeUnwrapErr(),
      ).toMatchObject({ code: "request_conflict" });
      expect(
        (await changeGoal(root, "set-request", set, ctx, deny))._unsafeUnwrapErr(),
      ).toMatchObject({ code: "admission_denied", reason: "sleep" });
      expect(formats).toBe(1);
    } finally {
      await reopened.close(ctx);
    }
  } finally {
    await test.close();
  }
});

it("persists an automatic admission refusal without queueing input", async () => {
  let formats = 0;
  const test = await setup(
    undefined,
    [],
    () => err({ disposition: "denied", reason: "sleep" }),
    () => {
      formats++;
      return follow;
    },
  );
  try {
    await test.set();
    await test.root.waitForIdle(ctx);
    expect(test.received).toEqual([kick]);
    expect(await test.view()).toMatchObject({ status: "paused", reason: "sleep" });
    expect(test.nativeInputs.size).toBe(1);
    expect(formats).toBe(0);
  } finally {
    await test.close();
  }
});

it.each(["input", "cap"] as const)("records Sleep deferral before the %s gate", async (gate) => {
  let requests = 0;
  const sleepingAt = gate === "cap" ? MAX_GOAL_FOLLOWUPS + 1 : 1;
  const lastTurn = barrier();
  const answer = barrier();
  const test = await setup(
    async () => {
      if (++requests === sleepingAt) {
        lastTurn.release();
        await answer.reached;
      }
      return fauxAssistantMessage("Fixture answer");
    },
    [],
    () =>
      requests < sleepingAt
        ? ok(undefined)
        : err({ disposition: "sleep", reason: "Fixture sleep refusal" }),
  );
  try {
    const started = await test.set();
    await lastTurn.reached;
    if (gate === "input")
      await test.root.submit(
        { type: "input", content: "Already admitted", whenBusy: "followUp" },
        ctx,
      );
    answer.release();
    await test.root.waitForIdle(ctx);

    expect(test.received).toEqual([
      kick,
      ...Array<string>(sleepingAt - 1).fill(follow),
      ...(gate === "input" ? ["Already admitted"] : []),
    ]);
    expect(test.nativeInputs.size).toBe(sleepingAt);
    expect(await test.view()).toEqual(started);
    expect(
      test.commits.flatMap(({ changes }) =>
        changes.flatMap((change) =>
          change.type === "task" &&
          change.value.kind === "orb.goal-after-run" &&
          change.value.state.status === "terminal"
            ? [change.value.state.outcome]
            : [],
        ),
      ),
    ).toContainEqual({ status: "completed", result: "deferred_sleep" });
  } finally {
    answer.release();
    await test.close();
  }
});

it("reads a missing goal without a document and validates objective encoding and length", async () => {
  const test = await setup();
  try {
    expect(await test.view()).toBeUndefined();
    expect(await test.harness.snapshot(GoalDoc, test.root.id, ctx)).toBeUndefined();
    const set = (objective: string) =>
      mutateGoal(test.root, { type: "goal_set", objective, input: kick });
    for (const raw of ["Objective\u0000", "\uD800Objective", "Objective\uDFFF"]) {
      expect((await set(raw))._unsafeUnwrapErr()).toMatchObject({ code: "invalid_objective" });
    }
    expect(await test.harness.snapshot(GoalDoc, test.root.id, ctx)).toBeUndefined();
    const prefix = "Fixture ";
    const maxObjective = prefix + "🧭".repeat(GOAL_OBJECTIVE_MAX_LENGTH - prefix.length);
    expect((await set(`${maxObjective}🧭`))._unsafeUnwrapErr()).toMatchObject({
      code: "invalid_objective",
    });
    expect((await set(maxObjective))._unsafeUnwrap()).toMatchObject({ objective: maxObjective });
    await test.root.waitForIdle(ctx);
  } finally {
    await test.close();
  }
});
