import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import { DurableAgent } from "./agent.ts";
import { durableError } from "./manager.ts";
import { MemoryAgentPersistence } from "./memory-persistence.testkit.ts";

async function open(options: Partial<Parameters<typeof DurableAgent.open>[0]> = {}) {
  const persistence = new MemoryAgentPersistence();
  const agent = (
    await DurableAgent.open({
      orbId: "orb",
      storage: (await persistence.openOrb("orb", false))._unsafeUnwrap().storage,
      models: createModels(),
      registry: createRegistry(),
      env: new NodeExecutionEnv({ cwd: "/tmp" }),
      checkoutCommit: null,
      instructions: "",
      ...options,
    })
  )._unsafeUnwrap();
  return { agent, persistence };
}

function sender() {
  const submit = vi.fn(async () => ({ id: 99 }));
  const conversation = vi.fn(async () => ({ id: 1, submit }));
  const transaction = {
    conversation: async (id: number) =>
      id === 7 ? { id: 7, owner: { conversationId: 1, taskId: 9 } } : { id: 1 },
    task: async (id: number) => ({
      id,
      conversationId: id === 9 ? 1 : 7,
      kind: id === 9 ? "orb.child" : "pi.tool",
      state: { status: "running", checkpoint: { phase: "run", child: 7 } },
    }),
    doc: async () => ({
      children: { "trusted-agent": { anchor: 9, prompt: "child", description: "worker" } },
    }),
  };
  const commit = vi.fn(async (fn: (tx: typeof transaction) => unknown) => fn(transaction));
  const api = { taskId: 42, conversationId: 7, callId: "call", conversation, commit };
  return { api: api as unknown as ToolExecutionApi, submit, conversation, commit, transaction };
}

it.each(["paused", "closed", "stale invocation", "ownerless"] as const)(
  "rejects %s without submitting private input",
  async (state) => {
    const { agent, persistence } = await open({ resume: state !== "paused" });
    const caller = sender();
    if (state === "stale invocation")
      caller.commit.mockRejectedValue(new Error("stale framework invocation"));
    if (state === "ownerless") caller.transaction.conversation = async (id) => ({ id });
    try {
      if (state === "closed") await agent.close();
      const result = await agent.notifyParent("PRIVATE", caller.api, context);
      expect(result.isErr() && result.error).toMatchObject({
        code: state === "ownerless" ? "invalid_request" : "unavailable",
      });
      expect(caller.submit).not.toHaveBeenCalled();
      if (state === "paused" || state === "closed") expect(caller.commit).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain("stale framework invocation");
      expect(JSON.stringify(agent.snapshot()._unsafeUnwrap())).not.toContain("PRIVATE");
    } finally {
      await agent.close();
      await persistence.close();
    }
  },
);

it.each(["inside ownership commit", "after ownership commit", "close", "ownership"] as const)(
  "rechecks admission at %s before native submission",
  async (stage) => {
    let entered!: () => void, release!: () => void;
    const admissionEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let admitted = true,
      checks = 0;
    const ownership = new AbortController();
    const asynchronous = stage === "close" || stage === "ownership";
    const { agent, persistence } = await open({
      ownershipSignal: ownership.signal,
      checkAdmission: () => {
        if (asynchronous && ++checks === 4) {
          entered();
          return ResultAsync.fromSafePromise(pending);
        }
        return admitted ? okAsync(undefined) : errAsync(durableError("sleep"));
      },
    });
    const caller = sender();
    caller.commit.mockImplementation(async (fn) => {
      if (stage === "inside ownership commit") admitted = false;
      const result = await fn(caller.transaction);
      if (stage === "after ownership commit") admitted = false;
      return result;
    });
    checks = 0;
    const notification = agent.notifyParent("PRIVATE", caller.api, context);
    let closing: ReturnType<DurableAgent["close"]> | undefined;
    try {
      if (asynchronous) {
        await admissionEntered;
        expect(caller.conversation).toHaveBeenCalledOnce();
        if (stage === "close") closing = agent.close();
        else ownership.abort();
        release();
      }
      expect((await notification).isErr()).toBe(true);
      expect(caller.submit).not.toHaveBeenCalled();
      expect(agent.workActive()).toBe(false);
    } finally {
      release();
      await notification;
      if (closing) await closing;
      await agent.close();
      await persistence.close();
    }
  },
);

it("derives replay-stable native request IDs from the trusted invocation", async () => {
  const { agent, persistence } = await open();
  const caller = sender();
  try {
    for (const [index, callId] of ["call", "call", "other"].entries()) {
      expect(
        (await agent.notifyParent("PRIVATE", { ...caller.api, callId }, context))._unsafeUnwrap(),
      ).toEqual({ accepted: true });
      expect(caller.submit).toHaveBeenNthCalledWith(
        index + 1,
        {
          type: "input",
          content: JSON.stringify({
            agent_id: "trusted-agent",
            description: "worker",
            message: "PRIVATE",
          }),
          whenBusy: "steer",
          requestId: `subagent-notify:42:${callId}`,
        },
        context,
      );
    }
  } finally {
    await agent.close();
    await persistence.close();
  }
});
