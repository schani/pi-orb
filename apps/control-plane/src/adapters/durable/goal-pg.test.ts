import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  type EntryId,
  Harness,
  ROOT_CONVERSATION_ID,
  type Storage,
  type SubmissionId,
  type SubmissionRecord,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { ok } from "neverthrow";
import { expect, it, onTestFinished } from "vitest";
import { openOrbSqlFixture } from "../../testkit/sql-fixture.ts";
import { DurableAgent } from "./agent.ts";
import { changeGoal, GOAL_REQUEST_PREFIX, GoalDoc, GoalInput } from "./goal.ts";

async function fixture() {
  const opened = await openOrbSqlFixture("goal-pg", "running");
  const { database, orb, project, task } = opened;
  const persistence = database.agentPersistence;
  const open = () => persistence.open(task, orb, { signal: new AbortController().signal });
  const sleep = () =>
    database.store.scheduleOrbSleep(task, {
      orbId: orb.id,
      caller: {
        kind: "central",
        orbId: orb.id,
        projectId: project.id,
        ownerUserId: project.ownerUserId,
        agentAdmissionVersion: orb.agentAdmissionVersion,
      },
      sleepId: randomUUID(),
      durationSeconds: 300,
    });
  const stop = (expectedStateVersion = orb.stateVersion) =>
    database.store.requestOrbStop(task, {
      orbId: orb.id,
      expectedStateVersion,
      now: task.wallNow(),
    });
  return { ...opened, open, sleep, stop, persistence };
}

const objective = "Private fixture objective";

async function seedInterruptedGoal(open: Awaited<ReturnType<typeof fixture>>["open"]) {
  const lease = (await open())._unsafeUnwrap();
  const harness = await Harness.open(
    lease.storage,
    { models: createModels(), registry: createRegistry() },
    context,
  );
  try {
    const root = await harness.root(context, {
      agent: { model: { provider: "faux", modelId: "faux-1" } },
    });
    (
      await changeGoal(
        root,
        "set",
        { type: "goal_set", objective, input: "Private kickoff input" },
        context,
      )
    )._unsafeUnwrap();
    await root.waitForIdle(context);
  } finally {
    await harness.close(context);
    (await lease.release())._unsafeUnwrap();
  }
}

it("reads a fresh or interrupted goal passively with no new owner or native state", async () => {
  const { db, database, orb, task, persistence, open } = await fixture();
  const snapshot = async () => (await persistence.snapshot(task, orb))._unsafeUnwrap();
  const owners = async () =>
    (
      await db.query(
        "SELECT outcome FROM durable_pg_owner_events WHERE orb_id=$1 ORDER BY outcome",
        [orb.id],
      )
    )._unsafeUnwrap().rows;
  expect(await snapshot()).toMatchObject({ goal: null, records: [] });
  expect(await owners()).toEqual([]);
  expect(
    (await db.query("SELECT orb_id FROM durable_pg_durable_metadata"))._unsafeUnwrap().rows,
  ).toEqual([]);

  await seedInterruptedGoal(open);

  expect(await snapshot()).toMatchObject({
    activity: "idle",
    goal: { objective, status: "paused", reason: "No model was available." },
    records: [],
  });
  expect(await owners()).toEqual([{ outcome: "acquired" }, { outcome: "released" }]);
  // A native outcome for a different goal revision must not be inherited.
  (
    await db.query(
      `UPDATE durable_pg_submissions
          SET record=(record::jsonb || '{"requestId":"orb-goal:other:0"}'::jsonb)::text
        WHERE orb_id=$1`,
      [orb.id],
    )
  )._unsafeUnwrap();
  expect((await snapshot()).goal).toEqual({ objective, status: "active", revision: "1" });

  (await db.query("UPDATE orbs SET state='archiving' WHERE id=$1", [orb.id]))._unsafeUnwrap();
  expect(await snapshot()).not.toHaveProperty("goal");
  (
    await db.query(
      "INSERT INTO orb_deletions(orb_id,host_kind,kind,requested_at,cleanup_after,updated_at) VALUES($1,'process','archive',now(),now(),now())",
      [orb.id],
    )
  )._unsafeUnwrap();
  (
    await database.store.sealOrbArchive(task, {
      orbId: orb.id,
      expectedStateVersion: orb.stateVersion,
      now: 0,
      cursor: null,
      headId: null,
    })
  )._unsafeUnwrap();
  (
    await database.store.finalizeOrbArchive(task, {
      orbId: orb.id,
      expectedStateVersion: orb.stateVersion,
      now: 0,
    })
  )._unsafeUnwrap();
  expect(await snapshot()).not.toHaveProperty("goal");
  (await db.query("DELETE FROM orbs WHERE id=$1", [orb.id]))._unsafeUnwrap();
  expect(await snapshot()).not.toHaveProperty("goal");
});

async function inputWrites(storage: Storage, revision: number, turn: number) {
  const id = await storage.mintId<SubmissionId>();
  const entry = await storage.mintId<EntryId>();
  const queued = {
    id,
    conversationId: ROOT_CONVERSATION_ID,
    requestId: `${GOAL_REQUEST_PREFIX}${revision}:${turn}`,
    type: "input",
    status: "queued",
  } as const satisfies SubmissionRecord;
  const placed = { ...queued, status: "placed", entry } as const;
  return {
    queued,
    placed,
    entry: {
      id: entry,
      conversationId: ROOT_CONVERSATION_ID,
      kind: GoalInput.kind,
      data: { revision: String(revision), turn },
    },
  };
}

it("does not turn an external inbox race into a rejected native goal commit", async () => {
  const { database, orb, task, open } = await fixture();
  const lease = (await open())._unsafeUnwrap();
  const harness = await Harness.open(
    lease.storage,
    { models: createModels(), registry: createRegistry() },
    context,
  );
  try {
    const root = await harness.root(context);
    let reached = false;
    const set = await changeGoal(
      root,
      "set",
      { type: "goal_set", objective, input: "Private kickoff input" },
      context,
      async () => {
        (await lease.checkInputAdmission?.(true))?._unsafeUnwrap();
        (
          await database.store.enqueueOrbMessage(task, {
            orbId: orb.id,
            messageId: randomUUID(),
            content: [{ type: "text", text: "Parallel inbox input" }],
            now: task.wallNow(),
          })
        )._unsafeUnwrap();
        reached = true;
        return ok(undefined);
      },
    );
    expect(reached).toBe(true);
    expect(set._unsafeUnwrap().goal).toMatchObject({ status: "active" });
    await root.waitForIdle(context);
    expect((await harness.snapshot(GoalDoc, root.id, context))?.goal?.objective).toBe(objective);
    expect((await database.store.listOrbMessages(task, orb.id))._unsafeUnwrap()).toMatchObject([
      { status: "queued", operationId: null },
    ]);
  } finally {
    await harness.close(context);
    (await lease.release())._unsafeUnwrap();
  }
});

async function openGoalAgent(
  { orb, open }: Awaited<ReturnType<typeof fixture>>,
  responses: FauxResponseStep[],
  beforeCommit: (batches: Parameters<Storage["commit"]>[0]) => void | Promise<void>,
) {
  const lease = (await open())._unsafeUnwrap();
  const fake = fauxProvider();
  fake.setResponses(responses);
  const models = createModels();
  models.setProvider(fake.provider);
  const storage: Storage = new Proxy(lease.storage, {
    get(target, key) {
      if (key === "commit")
        return async (...args: Parameters<Storage["commit"]>) => {
          await beforeCommit(args[0]);
          return target.commit(...args);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const agent = (
    await DurableAgent.open({
      orbId: orb.id,
      storage,
      models,
      registry: createRegistry(),
      env: new NodeExecutionEnv({ cwd: "/tmp" }),
      checkoutCommit: null,
      instructions: "",
      initialSettings: { model: { provider: "faux", id: "faux-1" }, thinkingLevel: "off" },
      goal: { kickoff: () => "Fixture kickoff", followUp: () => "Fixture follow-up" },
      checkAdmission: lease.check,
      checkInputAdmission: lease.checkInputAdmission,
      ownershipSignal: lease.signal,
      beginDrain: lease.beginDrain,
      closeResources: lease.release,
    })
  )._unsafeUnwrap();
  return { agent, storage, fake };
}

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function kickoff(kind: "set" | "resume") {
  return kind === "resume"
    ? ({ type: "goal_resume", revision: "1:interrupted" } as const)
    : ({ type: "goal_set", objective } as const);
}

it.each(["set", "resume", "automatic"] as const)(
  "drains exactly one %s handoff when Sleep wins immediately before native publication",
  async (kind) => {
    const rig = await fixture();
    const { database, orb, task, sleep, persistence } = rig;
    if (kind === "resume") await seedInterruptedGoal(rig.open);
    const entered = barrier();
    const answer = barrier();
    const responses: FauxResponseStep[] = [
      async () => {
        entered.resolve();
        await answer.promise;
        return fauxAssistantMessage("Fixture handoff answer");
      },
    ];
    if (kind === "automatic") responses.unshift(fauxAssistantMessage("Fixture kickoff answer"));
    const revision = kind === "resume" ? "2" : "1";
    const handoffId = `${GOAL_REQUEST_PREFIX}${revision}:${kind === "automatic" ? 1 : 0}`;
    let workAtBoundary: boolean | undefined;
    const { agent, storage } = await openGoalAgent(rig, responses, async (batches) => {
      if (
        batches.some((batch) =>
          batch.some(
            (write) =>
              write.type === "submission" &&
              write.value.requestId === handoffId &&
              write.value.status === (kind === "automatic" ? "queued" : "placed"),
          ),
        )
      ) {
        // Preflight passed; Sleep commits before PgStorage acquires the orb row lock.
        (await sleep())._unsafeUnwrap();
        workAtBoundary = agent.workActive();
      }
    });
    const active = { objective, status: "active", revision };
    try {
      expect(
        (await agent.request(kind, kickoff(kind === "automatic" ? "set" : kind)))._unsafeUnwrap(),
      ).toEqual({ type: "goal_applied", duplicate: false });
      const idle = agent.waitForIdle();
      expect(
        await Promise.race([
          entered.promise.then(() => "handoff entered"),
          idle.then((result) => (result.isErr() ? result.error : "already idle")),
        ]),
      ).toEqual("handoff entered");
      expect(workAtBoundary).toBe(true);
      expect((await database.store.getOrb(task, orb.id))._unsafeUnwrap()).toMatchObject({
        state: "running",
        stopReason: null,
        sleepId: expect.any(String),
      });
      expect(agent.workActive()).toBe(true);
      expect((await agent.prepareIdleStop())._unsafeUnwrap()).toMatchObject({ prepared: false });

      answer.resolve();
      (await idle)._unsafeUnwrap();
      expect(agent.health()).toMatchObject({ status: "ready", activity: "idle" });
      expect(agent.workActive()).toBe(false);
      expect((await agent.prepareIdleStop())._unsafeUnwrap()).toMatchObject({ prepared: true });
      expect(agent.sleepSuspensionFailure()).toBeUndefined();
      expect(agent.snapshot()._unsafeUnwrap().goal).toEqual(active);
      const [submissions, afterRuns] = await Promise.all([
        storage.scanSubmissions({ conversationId: ROOT_CONVERSATION_ID }, 8, undefined, context),
        storage.scanTasks({ kind: "orb.goal-after-run" }, 8, undefined, context),
      ]);
      expect(submissions.items.map(({ requestId, status }) => [requestId, status])).toEqual([
        ...(kind === "set"
          ? []
          : [[`${GOAL_REQUEST_PREFIX}1:0`, kind === "resume" ? "unanswered" : "done"]]),
        [handoffId, "done"],
      ]);
      expect(afterRuns.items.map(({ state }) => state)).toEqual([
        ...(kind === "automatic"
          ? [{ status: "terminal", outcome: { status: "completed", result: "continued" } }]
          : []),
        { status: "terminal", outcome: { status: "completed", result: "deferred_sleep" } },
      ]);
      (await agent.close())._unsafeUnwrap();
      expect((await persistence.snapshot(task, orb))._unsafeUnwrap().goal).toEqual(active);
    } finally {
      answer.resolve();
      await agent.close();
    }
  },
);

it.each(["set", "resume"] as const)(
  "refuses %s through the agent without a new submission when Sleep is already pending",
  async (kind) => {
    const rig = await fixture();
    if (kind === "resume") await seedInterruptedGoal(rig.open);
    const { agent, fake, storage } = await openGoalAgent(rig, [], () => undefined);
    const submissions = () =>
      storage.scanSubmissions({ conversationId: ROOT_CONVERSATION_ID }, 8, undefined, context);
    try {
      const before = agent.snapshot()._unsafeUnwrap().goal;
      const beforeSubmissions = await submissions();
      (await rig.sleep())._unsafeUnwrap();
      expect((await agent.request(kind, kickoff(kind)))._unsafeUnwrap()).toEqual({
        type: "rejected",
        error: { code: "busy", message: "Input admission paused by sleep", retryable: true },
      });
      expect(await submissions()).toEqual(beforeSubmissions);
      expect(fake.state.callCount).toBe(0);
      expect(agent.snapshot()._unsafeUnwrap().goal).toEqual(before);
      expect(agent.health()).toMatchObject({ status: "ready", activity: "idle" });
      expect(agent.workActive()).toBe(false);
    } finally {
      await agent.close();
    }
  },
);

it.each(["sleep", "stop", "sleep-stop", "revoked"] as const)(
  "fences goal kickoff, automatic handoff and previously queued placement at %s",
  async (edge) => {
    const { db, database, orb, task, open, sleep, stop } = await fixture();
    const lease = (await open())._unsafeUnwrap();
    const { storage } = lease;
    onTestFinished(async () => {
      await storage.close(context);
      (await lease.release())._unsafeUnwrap();
    });
    const accepted = await inputWrites(storage, 1, 0);
    const later = await inputWrites(storage, 2, 0);
    const automatic = await inputWrites(storage, 1, 1);
    const commit = (writes: Parameters<Storage["commit"]>[0][number]) =>
      storage.commit([writes], () => undefined, context);
    expect(await commit([{ type: "submission", value: accepted.queued }])).toMatchObject({
      kind: "stored",
    });
    // Make the guard run during owner drain, where the generic owner check no longer
    // compares the current admission version. A real Stop must still fence goals.
    (await lease.beginDrain?.())?._unsafeUnwrap();
    if (edge === "stop") (await stop())._unsafeUnwrap();
    else if (edge === "revoked") {
      (
        await db.query(
          "UPDATE orbs SET agent_admission_version=agent_admission_version+1 WHERE id=$1",
          [orb.id],
        )
      )._unsafeUnwrap();
    } else {
      (
        await database.store.enqueueOrbMessage(task, {
          orbId: orb.id,
          messageId: randomUUID(),
          content: [{ type: "text", text: "An inbox message" }],
          now: task.wallNow(),
        })
      )._unsafeUnwrap();
      expect((await lease.checkInputAdmission(true))._unsafeUnwrapErr()).toMatchObject({
        type: "input_admission_refused",
        disposition: "queued_input",
      });
      const sleeping = (await sleep())._unsafeUnwrap();
      if (edge === "sleep-stop")
        expect(
          (
            await database.store.casTransition(task, {
              orbId: orb.id,
              expectedStateVersion: sleeping.stateVersion,
              toState: "stopping",
              stopReason: "sleep",
              now: task.wallNow(),
            })
          )._unsafeUnwrap(),
        ).toMatchObject({ state: "stopping", stopReason: "sleep" });
      expect((await lease.checkInputAdmission(true))._unsafeUnwrapErr()).toMatchObject({
        type: "input_admission_refused",
        disposition: "sleep",
      });
    }

    for (const { queued } of [later, automatic]) {
      const handoff = commit([{ type: "submission", value: queued }]);
      if (edge === "sleep") {
        expect(await handoff).toMatchObject({ kind: "stored" });
        expect(await storage.submission(queued.id, context)).toEqual(queued);
      } else {
        await expect(handoff).rejects.toMatchObject({ cause: { type: "authority_error" } });
        expect(await storage.submission(queued.id, context)).toBeUndefined();
      }
    }
    const place = commit([
      { type: "entry", value: accepted.entry },
      { type: "submission", value: accepted.placed },
    ]);
    if (edge === "sleep") {
      expect(await place).toMatchObject({ kind: "stored" });
      expect(await storage.submission(accepted.queued.id, context)).toEqual(accepted.placed);
    } else {
      await expect(place).rejects.toMatchObject({ cause: { type: "authority_error" } });
      expect(await storage.submission(accepted.queued.id, context)).toEqual(accepted.queued);
      expect(await storage.entry(accepted.entry.id, context)).toBeUndefined();
    }
  },
);
