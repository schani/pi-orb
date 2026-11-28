import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, MemoryStorage, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { GoalView } from "@pi-orb/protocol";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { assert, expect, it } from "vitest";
import { DurableAgent, type DurableAgentOptions } from "./agent.ts";
import { goalModelPolicy, reportGoalTool } from "./goal-model.ts";
import { durableError } from "./manager.ts";
import { type AuthorizeTool, createDurableTools } from "./tools/index.ts";

const objective = "Verify the fixture.\nKeep the output.";
const kickoff = `Work toward the goal below. Mark it complete only after verifying the objective, or blocked if you cannot make further progress. Include the evidence or blocker.\n\n${objective}`;
const continuation = `Continue working toward this goal:\n\n${objective}`;
const set = { type: "goal_set", objective } as const;
const completed = { status: "complete", evidence: "Fixture verified" } as const;
const blocked = { status: "blocked", reason: "Fixture missing" } as const;

function report(args: object) {
  return fauxAssistantMessage(
    fauxToolCall("codemode", { code: `text(await tools.report_goal(${JSON.stringify(args)}));` }),
    { stopReason: "toolUse" },
  );
}

async function open(
  responses: readonly (AssistantMessage | FauxResponseFactory)[],
  authorize?: AuthorizeTool,
  admission?: Pick<DurableAgentOptions, "checkAdmission" | "checkInputAdmission">,
) {
  const received: string[] = [];
  const fake = fauxProvider();
  fake.setResponses(
    responses.map(
      (response): FauxResponseFactory =>
        (...args) => {
          const input = args[0].messages.findLast((message) => message.role === "user");
          const content = input?.content;
          received.push(
            typeof content === "string"
              ? content
              : (content ?? [])
                  .flatMap((block) => (block.type === "text" ? [block.text] : []))
                  .join("\n"),
          );
          return typeof response === "function" ? response(...args) : response;
        },
    ),
  );
  const models = createModels();
  models.setProvider(fake.provider);
  const tools = createDurableTools({
    additionalTools: [reportGoalTool],
    ...(authorize ? { authorize } : {}),
  });
  const registry = createRegistry();
  registry.install(tools.extension);
  registry.install(tools.childExtension);
  const storage = new MemoryStorage();
  const agent = (
    await DurableAgent.open({
      orbId: "orb",
      storage,
      models,
      registry,
      modelTools: tools.modelTools,
      childExtension: tools.childExtension,
      goal: goalModelPolicy,
      ...admission,
      env: new NodeExecutionEnv({ cwd: "/tmp" }),
      checkoutCommit: null,
      instructions: "",
      initialSettings: { model: { provider: "faux", id: "faux-1" }, thinkingLevel: "off" },
      closeResources: () => tools.close().mapErr(() => durableError("Tool cleanup failed")),
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

function records(agent: DurableAgent) {
  return JSON.stringify(agent.snapshot()._unsafeUnwrap().records);
}

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function holdFirstReport() {
  const entered = barrier();
  const release = barrier();
  let count = 0;
  const authorize: AuthorizeTool = (name) => {
    if (name !== "report_goal" || ++count !== 1) return okAsync(undefined);
    entered.resolve();
    return ResultAsync.fromSafePromise(release.promise);
  };
  return { authorize, entered: entered.promise, release: release.resolve };
}

it.each([
  [completed, completed.evidence],
  [blocked, blocked.reason],
] as const)("reports %j from the automatic follow-up", async (outcome, reason) => {
  const { agent, events, received } = await open([
    fauxAssistantMessage("Working"),
    report(outcome),
    fauxAssistantMessage("Done"),
  ]);
  try {
    expect((await agent.request("set", set))._unsafeUnwrap()).toEqual({
      type: "goal_applied",
      duplicate: false,
    });
    (await agent.waitForIdle())._unsafeUnwrap();
    expect(received).toEqual([kickoff, continuation, continuation]);
    expect(events.map((goal) => goal?.status)).toEqual(["active", outcome.status]);
    expect(current(agent)).toMatchObject({ status: outcome.status, reason });
    expect(records(agent)).toContain(`Goal ${outcome.status}.`);
  } finally {
    await agent.close();
  }
});

it.each(["pending", "suspending"] as const)(
  "defers during %s Sleep and completes in an ordinary wake turn",
  async (phase) => {
    let sleeping = false;
    const { agent, events, received } = await open(
      [
        () => {
          sleeping = true;
          return fauxAssistantMessage("Going to sleep");
        },
        report(completed),
        fauxAssistantMessage("Done"),
      ],
      undefined,
      {
        checkAdmission: () =>
          phase === "suspending" && sleeping
            ? errAsync(durableError("Fixture owner admission denied"))
            : okAsync(undefined),
        checkInputAdmission: () =>
          sleeping
            ? errAsync({
                type: "input_admission_refused",
                disposition: "sleep",
                error: durableError("Fixture sleep refusal"),
              })
            : okAsync(undefined),
      },
    );
    try {
      (await agent.request("set", set))._unsafeUnwrap();
      (await agent.waitForIdle())._unsafeUnwrap();
      expect(received).toEqual([kickoff]);
      expect(events).toEqual([{ revision: "1", objective, status: "active" }]);
      expect(current(agent)).toEqual(events[0]);

      sleeping = false;
      const wake = "Finish the goal";
      expect(
        (
          await agent.request("wake", {
            type: "message",
            expectedHeadId: agent.snapshot()._unsafeUnwrap().headId,
            content: [{ type: "text", text: wake }],
          })
        )._unsafeUnwrap(),
      ).toMatchObject({ type: "accepted" });
      (await agent.waitForIdle())._unsafeUnwrap();
      expect(received).toEqual([kickoff, wake, wake]);
      expect(current(agent)).toMatchObject({ status: "complete", reason: completed.evidence });
      expect(records(agent)).toContain("Goal complete.");
    } finally {
      await agent.close();
    }
  },
);

it("rejects a report from an unrelated root turn with a goal queued", async () => {
  const hold = holdFirstReport();
  const { agent, events, received } = await open(
    [
      report({ status: "complete", evidence: "Wrong turn" }),
      fauxAssistantMessage("Human answer"),
      report(completed),
      fauxAssistantMessage("Goal answer"),
    ],
    hold.authorize,
  );
  try {
    expect(
      (
        await agent.request("human", {
          type: "message",
          expectedHeadId: agent.snapshot()._unsafeUnwrap().headId,
          content: [{ type: "text", text: "Human input" }],
        })
      )._unsafeUnwrap(),
    ).toMatchObject({ type: "accepted" });
    await hold.entered;
    (await agent.request("set", set))._unsafeUnwrap();
    hold.release();
    (await agent.waitForIdle())._unsafeUnwrap();
    expect(received).toEqual(["Human input", "Human input", kickoff, kickoff]);
    expect(events.map((goal) => goal?.status)).toEqual(["active", "complete"]);
    expect(current(agent)?.reason).toBe(completed.evidence);
    expect(records(agent)).toContain("Goal results require the current goal turn.");
  } finally {
    hold.release();
    await agent.close();
  }
});

it("rejects a later root report when the goal input was aborted", async () => {
  const entered = barrier();
  const { agent } = await open([
    async (_request, options) => {
      entered.resolve();
      if (!options?.signal?.aborted)
        await new Promise<void>((resolve) =>
          options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
      return fauxAssistantMessage("Aborted");
    },
    report(completed),
    fauxAssistantMessage("Done"),
  ]);
  try {
    (await agent.request("set", set))._unsafeUnwrap();
    await entered.promise;
    const operationId = agent.liveView()?.operationId;
    assert.exists(operationId);
    (await agent.request("abort", { type: "abort", operationId }))._unsafeUnwrap();
    (await agent.waitForIdle())._unsafeUnwrap();
    const aborted = current(agent);
    expect(aborted).toMatchObject({ status: "paused", reason: "Goal turn was aborted." });

    (
      await agent.request("later", {
        type: "message",
        expectedHeadId: agent.snapshot()._unsafeUnwrap().headId,
        content: [{ type: "text", text: "Finish the goal" }],
      })
    )._unsafeUnwrap();
    (await agent.waitForIdle())._unsafeUnwrap();
    expect(current(agent)).toEqual(aborted);
    expect(records(agent)).toContain("Goal results require the current goal turn.");
  } finally {
    await agent.close();
  }
});

it("rejects the old running tool after Pause and Resume, even for the same objective", async () => {
  const hold = holdFirstReport();
  const { agent, events, received } = await open(
    [
      report({ status: "complete", evidence: "Stale result" }),
      fauxAssistantMessage("Old answer"),
      report(blocked),
      fauxAssistantMessage("New answer"),
    ],
    hold.authorize,
  );
  try {
    (await agent.request("set", set))._unsafeUnwrap();
    await hold.entered;
    const active = current(agent);
    assert.exists(active);
    (
      await agent.request("pause", { type: "goal_pause", revision: active.revision })
    )._unsafeUnwrap();
    const paused = current(agent);
    assert.exists(paused);
    (
      await agent.request("resume", { type: "goal_resume", revision: paused.revision })
    )._unsafeUnwrap();
    expect(current(agent)?.revision).not.toBe(active.revision);
    hold.release();
    (await agent.waitForIdle())._unsafeUnwrap();
    expect(received).toEqual([kickoff, kickoff, kickoff, kickoff]);
    expect(events.map((goal) => goal?.status)).toEqual(["active", "paused", "active", "blocked"]);
    expect(current(agent)?.reason).toBe(blocked.reason);
    expect(records(agent)).toContain("Goal results require the current goal turn.");
  } finally {
    hold.release();
    await agent.close();
  }
});

it("rejects a non-root invocation before accessing durable state", async () => {
  const result = await reportGoalTool.execute(
    completed,
    { conversationId: ROOT_CONVERSATION_ID + 1 } as Parameters<typeof reportGoalTool.execute>[1],
    BACKGROUND_CONTEXT,
  );
  expect(result.isError).toBe(true);
});
