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
function api() {
  const submit = vi.fn();
  const conversation = vi.fn(async () => ({ id: 1, submit }));
  const commit = vi.fn();
  return {
    submit,
    conversation,
    commit,
    invocation: {
      taskId: 42,
      conversationId: 7,
      callId: "call",
      conversation,
      commit,
    } as unknown as ToolExecutionApi,
  };
}

it.each(["manual stop", "sleep", "superseded ownership"])(
  "rejects private notification after %s admission revocation without submitting or resuming",
  async (reason) => {
    let admitted = true;
    const checkAdmission = vi.fn(() =>
      admitted ? okAsync(undefined) : errAsync(durableError(reason)),
    );
    const { agent, persistence } = await open({ checkAdmission });
    const sender = api();
    try {
      admitted = false;
      const result = await agent.notifyParent("PRIVATE", sender.invocation, context);
      expect(result.isErr()).toBe(true);
      expect(sender.conversation).not.toHaveBeenCalled();
      expect(sender.submit).not.toHaveBeenCalled();
      expect(sender.commit).not.toHaveBeenCalled();
      expect(agent.workActive()).toBe(false);
    } finally {
      await agent.close();
      await persistence.close();
    }
  },
);

it.each(["paused", "closed"] as const)(
  "rejects a %s agent without invoking native operations",
  async (state) => {
    const { agent, persistence } = await open({ resume: state !== "paused" });
    const sender = api();
    try {
      if (state === "closed") await agent.close();
      expect((await agent.notifyParent("PRIVATE", sender.invocation, context)).isErr()).toBe(true);
      expect(sender.commit).not.toHaveBeenCalled();
      expect(sender.conversation).not.toHaveBeenCalled();
      expect(sender.submit).not.toHaveBeenCalled();
    } finally {
      await agent.close();
      await persistence.close();
    }
  },
);

it("maps a stale native invocation to a typed rejection, never raw promise failure", async () => {
  const { agent, persistence } = await open();
  const sender = api();
  sender.commit.mockRejectedValue(new Error("stale framework invocation"));
  try {
    const result = await agent.notifyParent("PRIVATE", sender.invocation, context);
    expect(result.isErr()).toBe(true);
    expect(sender.submit).not.toHaveBeenCalled();
    expect(result.isErr() && result.error).toMatchObject({ code: "unavailable" });
    expect(JSON.stringify(result)).not.toContain("stale framework invocation");
  } finally {
    await agent.close();
    await persistence.close();
  }
});

it("rejects an ownerless non-root target rather than sending to the root or alerting the user", async () => {
  const { agent, persistence } = await open();
  const sender = api();
  sender.commit.mockImplementation(async (fn) =>
    fn({
      conversation: async () => ({ id: 7 }),
      task: async () => undefined,
    }),
  );
  try {
    const result = await agent.notifyParent("PRIVATE", sender.invocation, context);
    expect(result.isErr() && result.error).toMatchObject({ code: "invalid_request" });
    expect(sender.submit).not.toHaveBeenCalled();
    expect(JSON.stringify(agent.snapshot()._unsafeUnwrap())).not.toContain("PRIVATE");
  } finally {
    await agent.close();
    await persistence.close();
  }
});

it.each(["inside ownership commit", "after ownership commit"] as const)(
  "rechecks admission %s before native submission",
  async (stage) => {
    let admitted = true;
    const { agent, persistence } = await open({
      checkAdmission: () => (admitted ? okAsync(undefined) : errAsync(durableError("sleep"))),
    });
    const sender = api();
    sender.commit.mockImplementation(async (fn) => {
      if (stage === "inside ownership commit") admitted = false;
      const result = await fn({
        conversation: async (id: number) =>
          id === 7 ? { id: 7, owner: { conversationId: 1, taskId: 9 } } : { id: 1 },
        task: async (id: number) => ({
          id,
          conversationId: id === 9 ? 1 : 7,
          kind: id === 9 ? "orb.child" : "pi.tool",
          ownership: { kind: "conversation" },
          state: { status: "running", checkpoint: { phase: "run", child: 7 } },
        }),
        doc: async () => ({
          children: { "trusted-agent": { anchor: 9, prompt: "child", description: "worker" } },
        }),
      });
      if (stage === "after ownership commit") admitted = false;
      return result;
    });
    try {
      expect((await agent.notifyParent("PRIVATE", sender.invocation, context)).isErr()).toBe(true);
      expect(sender.submit).not.toHaveBeenCalled();
      expect(agent.workActive()).toBe(false);
    } finally {
      await agent.close();
      await persistence.close();
    }
  },
);

it.each(["close", "ownership"] as const)(
  "rechecks local %s while final asynchronous admission is pending",
  async (reason) => {
    let entered!: () => void, release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const admissionEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const ownership = new AbortController();
    let checks = 0;
    const { agent, persistence } = await open({
      ownershipSignal: ownership.signal,
      checkAdmission: () => {
        checks++;
        if (checks !== 4) return okAsync(undefined);
        entered();
        return ResultAsync.fromSafePromise(pending);
      },
    });
    const sender = api();
    sender.submit.mockResolvedValue({ id: 99 });
    sender.commit.mockImplementation(async (fn) =>
      fn({
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
      }),
    );
    checks = 0;
    const notification = agent.notifyParent("PRIVATE", sender.invocation, context);
    let closing: ReturnType<DurableAgent["close"]> | undefined;
    try {
      await admissionEntered;
      expect(sender.conversation).toHaveBeenCalledOnce();
      if (reason === "close") closing = agent.close();
      else ownership.abort();
      release();
      expect((await notification).isErr()).toBe(true);
      expect(sender.submit).not.toHaveBeenCalled();
    } finally {
      release();
      await notification;
      if (closing) await closing;
      await agent.close();
      await persistence.close();
    }
  },
);
