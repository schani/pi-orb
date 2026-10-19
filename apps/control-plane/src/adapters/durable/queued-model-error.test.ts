import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  defineTool,
  type Harness,
  InboxDoc,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  type Storage,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { errAsync } from "neverthrow";
import { expect, it } from "vitest";
import { DurableAgent, type DurableAgentOptions } from "./agent.ts";
import { durableError } from "./manager.ts";
import { MemoryAgentPersistence } from "./memory-persistence.testkit.ts";

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const input = (messageId: string) => ({
  baseUrl: "unused",
  messageId,
  messageIds: [messageId],
  content: [{ type: "text" as const, text: messageId }],
});

async function fixture() {
  const authority = new MemoryAgentPersistence();
  const entered = barrier();
  const release = barrier();
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  let effects = 0;
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("effect", {}), { stopReason: "toolUse" }),
    async () => {
      entered.resolve();
      await release.promise;
      return fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "scripted terminal refusal",
      });
    },
    fauxAssistantMessage("queued answer"),
    fauxAssistantMessage("later answer"),
  ]);
  let agent!: DurableAgent;
  let storage!: Storage;
  let conversation!: Harness["conversation"];
  const open = async (options: Pick<DurableAgentOptions, "resume" | "admitRecovery"> = {}) => {
    storage = (await authority.openOrb("orb", false))._unsafeUnwrap().storage;
    const registry = createRegistry();
    registry.install({
      name: "effect",
      tools: [
        defineTool({
          name: "effect",
          description: "Record an effect",
          parameters: Type.Object({}),
          replay: "unsafe",
          execute: async () => {
            effects++;
            return { output: [{ type: "text", text: "effect recorded" }] };
          },
        }),
      ],
    });
    const result = await DurableAgent.open({
      orbId: "orb",
      storage,
      models,
      registry,
      env: new NodeExecutionEnv({ cwd: "/tmp" }),
      checkoutCommit: null,
      instructions: "",
      initialSettings: { model: { provider: "faux", id: "faux-1" }, thinkingLevel: "off" },
      bindNativeConversation: (resolve) => {
        conversation = resolve;
      },
      ...options,
    });
    if (result.isOk()) agent = result.value;
    return result;
  };
  (await open())._unsafeUnwrap();
  const submission = (messageId: string) =>
    storage.submissionByRequest(ROOT_CONVERSATION_ID, `inbox:${messageId}`, BACKGROUND_CONTEXT);
  const fail = async (queue: boolean) => {
    (await agent.deliver(input("failed")))._unsafeUnwrap();
    await entered.promise;
    expect(effects).toBe(1);
    if (queue) {
      (await agent.deliver(input("queued")))._unsafeUnwrap();
      expect(await submission("queued")).toMatchObject({ status: "queued" });
    }
    release.resolve();
    (await agent.waitForIdle())._unsafeUnwrap();
    expect(await submission("failed")).toMatchObject({
      status: "unanswered",
      reason: "model_error",
    });
  };
  // Reproduce the stored pre-fix state without depending on the terminal-boundary bug remaining.
  const strand = async () => {
    await fail(false);
    const root = await conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
    assert(root);
    const id = await root.commit(async (tx) => {
      const live = await tx.doc(LiveDoc, root.id);
      expect(live.run).toBeUndefined();
      const inbox = await tx.doc(InboxDoc, root.id);
      expect(inbox.items).toEqual([]);
      const queued = await tx.createSubmission({
        conversationId: root.id,
        requestId: "inbox:queued",
        type: "input",
        status: "queued",
      });
      inbox.items.push({ id: queued.id, mode: "steer", content: input("queued").content });
      return queued.id;
    }, BACKGROUND_CONTEXT);
    const tasks = await storage.scanTasks(
      { conversationId: root.id },
      100,
      undefined,
      BACKGROUND_CONTEXT,
    );
    expect(tasks.items.every((task) => task.state.status === "terminal")).toBe(true);
    expect(await submission("queued")).toMatchObject({ id, status: "queued" });
    expect(faux.state.callCount).toBe(2);
    return id;
  };
  const assertRecovered = async (queuedId: number) => {
    (await agent.waitForIdle())._unsafeUnwrap();
    expect(await submission("queued")).toMatchObject({ id: queuedId, status: "done" });
    expect(await submission("failed")).toMatchObject({
      status: "unanswered",
      reason: "model_error",
    });
    expect(effects).toBe(1);
    const entries = await storage.scanEntries(
      { conversationId: ROOT_CONVERSATION_ID },
      100,
      undefined,
      BACKGROUND_CONTEXT,
    );
    const users = entries.items.flatMap((entry) =>
      (entry.model ?? []).filter((message) => message.role === "user"),
    );
    for (const text of ["failed", "queued"])
      expect(
        users.filter((message) => JSON.stringify(message.content).includes(text)),
      ).toHaveLength(1);
    expect(agent.health()).toMatchObject({ status: "ready", activity: "idle" });
    expect((await agent.prepareIdleStop())._unsafeUnwrap().prepared).toBe(true);
  };
  return {
    get agent() {
      return agent;
    },
    faux,
    open,
    fail,
    strand,
    submission,
    assertRecovered,
    close: async () => {
      release.resolve();
      await agent.close();
      await authority.close();
    },
  };
}

it("consumes input queued during terminal model_error without replaying the failed run", async () => {
  const f = await fixture();
  try {
    await f.fail(true);
    const queued = await f.submission("queued");
    assert(queued);
    await f.assertRecovered(queued.id);
    expect(f.faux.state.callCount).toBe(3);
    for (const messageId of ["failed", "queued"])
      expect((await f.agent.deliver(input(messageId)))._unsafeUnwrap().duplicate).toBe(true);
    (await f.agent.waitForIdle())._unsafeUnwrap();
    expect(f.faux.state.callCount).toBe(3);
    (await f.agent.deliver(input("later")))._unsafeUnwrap();
    (await f.agent.waitForIdle())._unsafeUnwrap();
    expect(await f.submission("later")).toMatchObject({ status: "done" });
    expect(f.faux.state.callCount).toBe(4);
    await f.assertRecovered(queued.id);
  } finally {
    await f.close();
  }
});

it.each(["queued", "later"])(
  "recovers an idle stranded inbox on %s submission, preserving its original Native ID",
  async (messageId) => {
    const f = await fixture();
    try {
      const queuedId = await f.strand();
      (await f.agent.deliver(input(messageId)))._unsafeUnwrap();
      await f.assertRecovered(queuedId);
      const calls = f.faux.state.callCount;
      expect((await f.agent.deliver(input("queued")))._unsafeUnwrap().duplicate).toBe(
        messageId === "queued",
      );
      (await f.agent.waitForIdle())._unsafeUnwrap();
      expect((await f.agent.deliver(input("queued")))._unsafeUnwrap().duplicate).toBe(true);
      expect(f.faux.state.callCount).toBe(calls);
      expect((await f.submission("queued"))?.id).toBe(queuedId);
    } finally {
      await f.close();
    }
  },
);

it("recovers a reopened stranded inbox, but leaves a read-only reopen inert", async () => {
  const f = await fixture();
  try {
    const queuedId = await f.strand();
    (await f.agent.close())._unsafeUnwrap();
    (await f.open({ resume: false }))._unsafeUnwrap();
    f.agent.resume();
    expect(f.faux.state.callCount).toBe(2);
    expect(await f.submission("queued")).toMatchObject({ id: queuedId, status: "queued" });
    expect((await f.agent.deliver(input("queued"))).isErr()).toBe(true);
    (await f.agent.close())._unsafeUnwrap();
    (await f.open())._unsafeUnwrap();
    await f.assertRecovered(queuedId);
    expect(f.faux.state.callCount).toBe(3);
  } finally {
    await f.close();
  }
});

it("requires recovery admission before resuming stranded queued input with no active tasks", async () => {
  const f = await fixture();
  try {
    const queuedId = await f.strand();
    (await f.agent.close())._unsafeUnwrap();
    let admitted = 0;
    const result = await f.open({
      admitRecovery: () => {
        admitted++;
        return errAsync(durableError("recovery denied"));
      },
    });
    expect(result.isErr()).toBe(true);
    expect(admitted).toBe(1);
    expect(f.faux.state.callCount).toBe(2);
    expect(await f.submission("queued")).toMatchObject({ id: queuedId, status: "queued" });
  } finally {
    await f.close();
  }
});
