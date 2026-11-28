import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import {
  type Conversation,
  createRegistry,
  MemoryStorage,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { GoalView } from "@pi-orb/protocol";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { assert, expect, it, vi } from "vitest";
import { DurableAgent, type DurableAgentOptions } from "./agent.ts";
import { recordGoalResult } from "./goal.ts";
import { durableError } from "./manager.ts";
import { MemoryAgentPersistence } from "./memory-persistence.testkit.ts";

const objective = "Fixture objective";
const set = { type: "goal_set", objective } as const;
const kickoff = "Fixture kickoff";
const followUp = "Fixture follow-up";
const policy = { kickoff: () => kickoff, followUp: () => followUp };

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function open(respond: FauxResponseFactory, options: Partial<DurableAgentOptions> = {}) {
  const fake = fauxProvider();
  const received: string[] = [];
  fake.setResponses(
    Array.from({ length: 8 }, () => (...args: Parameters<FauxResponseFactory>) => {
      const input = args[0].messages.findLast((message) => message.role === "user");
      const content = input?.content;
      received.push(
        typeof content === "string"
          ? content
          : (content ?? [])
              .flatMap((block) => (block.type === "text" ? [block.text] : []))
              .join("\n"),
      );
      return respond(...args);
    }),
  );
  const models = createModels();
  models.setProvider(fake.provider);
  const storage = options.storage ?? new MemoryStorage();
  let conversation: () => Promise<Conversation | undefined> = async () => undefined;
  const agent = (
    await DurableAgent.open({
      orbId: "orb",
      storage,
      models,
      registry: createRegistry(),
      env: new NodeExecutionEnv({ cwd: "/tmp" }),
      checkoutCommit: null,
      instructions: "",
      initialSettings: { model: { provider: "faux", id: "faux-1" }, thinkingLevel: "off" },
      bindNativeConversation: (resolve) => {
        conversation = () => resolve(ROOT_CONVERSATION_ID, context);
      },
      ...options,
    })
  )._unsafeUnwrap();
  const events: (GoalView | null)[] = [];
  agent.subscribe((frame) => {
    if (frame.type === "runtime.event" && frame.event.type === "goal_state")
      events.push(frame.event.goal);
  });
  return { agent, conversation, storage, events, received };
}

function current(agent: DurableAgent) {
  return agent.snapshot()._unsafeUnwrap().goal;
}

async function sendHuman(agent: DurableAgent) {
  return (
    await agent.request("human", {
      type: "message",
      expectedHeadId: agent.snapshot()._unsafeUnwrap().headId,
      content: [{ type: "text", text: "Fixture human" }],
    })
  )._unsafeUnwrap();
}

it("does not expose goal support or route goal actions when the policy is absent", async () => {
  const entered = barrier();
  const release = barrier();
  const { agent, events } = await open(async () => {
    entered.resolve();
    await release.promise;
    return fauxAssistantMessage("Fixture answer");
  });
  try {
    expect(current(agent)).toBeUndefined();
    expect(await sendHuman(agent)).toMatchObject({ type: "accepted" });
    await entered.promise;
    expect((await agent.request("start", set))._unsafeUnwrap()).toMatchObject({
      type: "rejected",
      error: { code: "unsupported" },
    });
    expect(current(agent)).toBeUndefined();
    expect(events).toEqual([]);
  } finally {
    release.resolve();
    await agent.close();
  }
});

it("queues Set and Resume, and accepts Pause and Clear during a human turn", async () => {
  const entered = barrier();
  const release = barrier();
  const format = vi.fn((_objective: string) => kickoff);
  const { agent, events, received } = await open(
    async () => {
      entered.resolve();
      await release.promise;
      return fauxAssistantMessage("Fixture answer");
    },
    { goal: { ...policy, kickoff: format } },
  );
  try {
    expect(current(agent)).toBeNull();
    expect(await sendHuman(agent)).toMatchObject({ type: "accepted" });
    await entered.promise;
    expect((await agent.request("start", set))._unsafeUnwrap()).toEqual({
      type: "goal_applied",
      duplicate: false,
    });
    const active = current(agent);
    assert.exists(active);
    expect(active).toMatchObject({ objective, status: "active" });
    expect((await agent.request("start", set))._unsafeUnwrap()).toEqual({
      type: "goal_applied",
      duplicate: true,
    });
    expect(
      (await agent.request("start", { ...set, objective: "Different" }))._unsafeUnwrap(),
    ).toMatchObject({
      type: "rejected",
      error: { code: "request_id_conflict" },
    });
    expect(format.mock.calls).toEqual([[objective]]);
    expect(
      (
        await agent.request("pause", { type: "goal_pause", revision: active.revision })
      )._unsafeUnwrap(),
    ).toEqual({
      type: "goal_applied",
      duplicate: false,
    });
    const paused = current(agent);
    assert.exists(paused);
    expect(paused).toMatchObject({ status: "paused" });
    expect(
      (
        await agent.request("stale", { type: "goal_resume", revision: active.revision })
      )._unsafeUnwrap(),
    ).toMatchObject({ type: "rejected", error: { code: "invalid_request" } });
    expect(
      (
        await agent.request("resume", { type: "goal_resume", revision: paused.revision })
      )._unsafeUnwrap(),
    ).toEqual({ type: "goal_applied", duplicate: false });
    const resumed = current(agent);
    assert.exists(resumed);
    expect(resumed).toMatchObject({ objective, status: "active" });
    expect(format.mock.calls).toEqual([[objective], [objective]]);
    expect(
      (
        await agent.request("clear-active", { type: "goal_clear", revision: resumed.revision })
      )._unsafeUnwrap(),
    ).toMatchObject({ type: "rejected", error: { code: "invalid_request" } });
    expect(
      (
        await agent.request("pause-resumed", { type: "goal_pause", revision: resumed.revision })
      )._unsafeUnwrap(),
    ).toEqual({ type: "goal_applied", duplicate: false });
    const pausedAgain = current(agent);
    assert.exists(pausedAgain);
    expect(
      (
        await agent.request("clear", { type: "goal_clear", revision: pausedAgain.revision })
      )._unsafeUnwrap(),
    ).toEqual({
      type: "goal_applied",
      duplicate: false,
    });
    release.resolve();
    (await agent.waitForIdle())._unsafeUnwrap();
    expect(received).toEqual(["Fixture human"]);
    expect(events).toEqual([active, paused, resumed, pausedAgain, null]);
    expect(current(agent)).toBeNull();
  } finally {
    release.resolve();
    await agent.close();
  }
});

it("publishes explicit completion once from the committed root document and reads it on reopen", async () => {
  const entered = barrier();
  const release = barrier();
  const memory = new MemoryAgentPersistence();
  const storage = (await memory.openOrb("orb", false))._unsafeUnwrap().storage;
  const { agent, conversation, events, received } = await open(
    async () => {
      entered.resolve();
      await release.promise;
      return fauxAssistantMessage("Fixture answer");
    },
    { goal: policy, storage },
  );
  try {
    (await agent.request("start", set))._unsafeUnwrap();
    await entered.promise;
    const active = current(agent);
    assert.exists(active);
    const root = await conversation();
    assert.exists(root);
    const { items } = await storage.scanSubmissions(
      { conversationId: root.id },
      8,
      undefined,
      context,
    );
    const input = items.find((item) => item.type === "input");
    assert.exists(input);
    (
      await root.commit(
        (tx) =>
          recordGoalResult(
            tx,
            root.id,
            { revision: active.revision, submissionId: input.id, status: "placed" },
            { status: "complete", reason: "Verified" },
          ),
        context,
      )
    )._unsafeUnwrap();
    const complete = current(agent);
    expect(complete).toMatchObject({ objective, status: "complete", reason: "Verified" });
    release.resolve();
    (await agent.waitForIdle())._unsafeUnwrap();
    expect(received).toEqual([kickoff]);
    expect(events).toEqual([active, complete]);
    const before = agent.snapshot()._unsafeUnwrap().records;
    expect(before).not.toEqual(expect.arrayContaining([expect.objectContaining({ role: "user" })]));
    expect(JSON.stringify(before)).not.toContain(kickoff);
    (await agent.close())._unsafeUnwrap();

    const reopened = await open(() => fauxAssistantMessage("Unused fixture"), {
      goal: policy,
      storage,
    });
    try {
      expect(current(reopened.agent)).toEqual(complete);
      expect((await reopened.agent.request("start", set))._unsafeUnwrap()).toEqual({
        type: "goal_applied",
        duplicate: true,
      });
      expect(reopened.events).toEqual([]);
      expect(reopened.agent.snapshot()._unsafeUnwrap().records).toEqual(before);
      expect(reopened.received).toEqual([]);
    } finally {
      await reopened.agent.close();
    }
  } finally {
    release.resolve();
    await agent.close();
    await memory.close();
  }
});

it("uses the existing input gate at kickoff and every automatic handoff; formatter inputs stay private", async () => {
  let blocked = true;
  let requests = 0;
  const checkInputAdmission = vi.fn((_browser: boolean) =>
    blocked
      ? errAsync({
          type: "input_admission_refused" as const,
          disposition: "queued_input" as const,
          error: durableError("Fixture admission refusal"),
        })
      : okAsync(undefined),
  );
  const { agent, events, received } = await open(
    () => {
      if (++requests === 2) blocked = true;
      return fauxAssistantMessage("Fixture answer");
    },
    { goal: policy, checkInputAdmission },
  );
  try {
    expect((await agent.request("blocked-start", set))._unsafeUnwrap()).toMatchObject({
      type: "rejected",
      error: { code: "busy" },
    });
    expect(current(agent)).toBeNull();

    blocked = false;
    (await agent.request("start", set))._unsafeUnwrap();
    (await agent.waitForIdle())._unsafeUnwrap();
    expect(checkInputAdmission.mock.calls).toEqual([[true], [true], [true], [true]]);
    expect(received).toEqual([kickoff, followUp]);
    expect(events.map((goal) => goal?.status)).toEqual(["active", "paused"]);
    expect(current(agent)?.reason).toBeTruthy();
    const records = agent.snapshot()._unsafeUnwrap().records;
    expect(records).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "user" })]),
    );
    expect(JSON.stringify(records)).not.toContain(kickoff);
    expect(JSON.stringify(records)).not.toContain(followUp);
  } finally {
    await agent.close();
  }
});

it("does not hand off if the owner is lost during the asynchronous inbox check", async () => {
  const owner = new AbortController();
  const entered = barrier();
  const release = barrier();
  let checks = 0;
  const { agent, received } = await open(() => fauxAssistantMessage("Fixture answer"), {
    goal: policy,
    ownershipSignal: owner.signal,
    checkInputAdmission: () => {
      if (++checks === 1) return okAsync(undefined);
      entered.resolve();
      return ResultAsync.fromSafePromise(release.promise);
    },
  });
  try {
    (await agent.request("start", set))._unsafeUnwrap();
    await entered.promise;
    owner.abort();
    release.resolve();
    (await agent.waitForIdle())._unsafeUnwrap();
    expect(received).toEqual([kickoff]);
  } finally {
    release.resolve();
    await agent.close();
  }
});

it("publishes cancellation as the committed paused goal", async () => {
  const entered = barrier();
  const { agent, events } = await open(
    async (_request, options) => {
      entered.resolve();
      if (!options?.signal?.aborted)
        await new Promise<void>((resolve) =>
          options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
      return fauxAssistantMessage("Fixture answer");
    },
    { goal: policy },
  );
  try {
    (await agent.request("start", set))._unsafeUnwrap();
    await entered.promise;
    const operationId = agent.liveView()?.operationId;
    assert.exists(operationId);
    expect(
      (await agent.request("abort", { type: "abort", operationId }))._unsafeUnwrap(),
    ).toMatchObject({
      type: "accepted",
    });
    (await agent.waitForIdle())._unsafeUnwrap();
    expect(events.map((goal) => goal?.status)).toEqual(["active", "paused"]);
    expect(current(agent)).toMatchObject({ status: "paused", reason: "Goal turn was aborted." });
  } finally {
    await agent.close();
  }
});
