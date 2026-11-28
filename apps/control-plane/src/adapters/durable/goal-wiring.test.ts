import { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { GoalView } from "@pi-orb/protocol";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { assert, expect, it, vi } from "vitest";
import { DurableAgent, type DurableAgentOptions } from "./agent.ts";
import { durableError } from "./manager.ts";

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
  const agent = (
    await DurableAgent.open({
      orbId: "orb",
      storage: new MemoryStorage(),
      models,
      registry: createRegistry(),
      env: new NodeExecutionEnv({ cwd: "/tmp" }),
      checkoutCommit: null,
      instructions: "",
      initialSettings: { model: { provider: "faux", id: "faux-1" }, thinkingLevel: "off" },
      ...options,
    })
  )._unsafeUnwrap();
  const events: (GoalView | null)[] = [];
  agent.subscribe((frame) => {
    if (frame.type === "runtime.event" && frame.event.type === "goal_state")
      events.push(frame.event.goal);
  });
  return { agent, events, received };
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
  const { agent, events } = await open(() => fauxAssistantMessage("Unused fixture"));
  try {
    expect((await agent.request("start", set))._unsafeUnwrap()).toMatchObject({
      type: "rejected",
      error: { code: "unsupported" },
    });
    expect(current(agent)).toBeUndefined();
    expect(events).toEqual([]);
  } finally {
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
  const apply = async (id: string, action: Parameters<DurableAgent["request"]>[1]) => {
    expect((await agent.request(id, action))._unsafeUnwrap()).toEqual({
      type: "goal_applied",
      duplicate: false,
    });
  };
  try {
    expect(current(agent)).toBeNull();
    expect(await sendHuman(agent)).toMatchObject({ type: "accepted" });
    await entered.promise;
    await apply("start", set);
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
    await apply("pause", { type: "goal_pause", revision: active.revision });
    const paused = current(agent);
    assert.exists(paused);
    expect(paused).toMatchObject({ status: "paused" });
    const invalidRequest = { type: "rejected", error: { code: "invalid_request" } };
    expect(
      (
        await agent.request("stale", { type: "goal_resume", revision: active.revision })
      )._unsafeUnwrap(),
    ).toMatchObject(invalidRequest);
    await apply("resume", { type: "goal_resume", revision: paused.revision });
    const resumed = current(agent);
    assert.exists(resumed);
    expect(resumed).toMatchObject({ objective, status: "active" });
    expect(format.mock.calls).toEqual([[objective], [objective]]);
    expect(
      (
        await agent.request("clear-active", { type: "goal_clear", revision: resumed.revision })
      )._unsafeUnwrap(),
    ).toMatchObject(invalidRequest);
    await apply("pause-resumed", { type: "goal_pause", revision: resumed.revision });
    const pausedAgain = current(agent);
    assert.exists(pausedAgain);
    await apply("clear", { type: "goal_clear", revision: pausedAgain.revision });
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
