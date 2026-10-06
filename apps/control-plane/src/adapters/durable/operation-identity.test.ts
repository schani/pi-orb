import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  defineTask,
  Harness,
  MemoryStorage,
  type StorageWrite,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { RuntimeEvent } from "@pi-orb/protocol";
import { expect, it } from "vitest";

async function checkpoint(promise: Promise<void>, name: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Missing checkpoint: ${name}`)), 3000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

import { DurableAgent } from "./agent.ts";
import { MemoryAgentPersistence } from "./memory-persistence.testkit.ts";

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("correlates earliest Native admission, patches, retirement and duplicate receipts across turns", async () => {
  const faux = fauxProvider();
  const models = createModels();
  const releases = [latch(), latch()];
  const entered = [latch(), latch()];
  let call = 0;
  models.setProvider({
    ...faux.provider,
    streamSimple: () => {
      const index = call++;
      const message = fauxAssistantMessage(`answer-${index}`);
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      stream.push({
        type: "text_delta",
        contentIndex: 0,
        delta: `answer-${index}`,
        partial: message,
      });
      entered[index]!.resolve();
      void releases[index]!.promise.then(() => {
        stream.push({ type: "done", reason: "stop", message });
        stream.end();
      });
      return stream;
    },
  });
  const admission = latch();
  const commitRelease = latch();
  class AdmissionStorage extends MemoryStorage {
    override async commit(writes: readonly StorageWrite[], context: Context) {
      if (
        writes.some(
          (write) => write.type === "submission" && write.value.requestId === "inbox:input-0",
        )
      ) {
        admission.resolve();
        await commitRelease.promise;
      }
      return super.commit(writes, context);
    }
  }
  const agent = (
    await DurableAgent.open({
      orbId: "identity",
      storage: new AdmissionStorage(),
      models,
      registry: createRegistry(),
      env: new NodeExecutionEnv({ cwd: "/tmp" }),
      checkoutCommit: "commit",
      instructions: "instructions",
      initialSettings: { model: { provider: "faux", id: "faux-1" }, thinkingLevel: "off" },
    })
  )._unsafeUnwrap();
  const events: RuntimeEvent[] = [];
  const patch = [latch(), latch()];
  agent.subscribe((frame) => {
    if (frame.type !== "runtime.event") return;
    events.push(frame.event);
    if (frame.event.type === "output_patch") patch[call - 1]!.resolve();
  });
  const ids: string[] = [];
  try {
    for (let index = 0; index < 2; index++) {
      const input = {
        baseUrl: "central",
        messageId: `input-${index}`,
        messageIds: [`input-${index}`],
        content: [{ type: "text" as const, text: `question-${index}` }],
      };
      const start = events.length;
      const delivered = agent.deliver(input);
      if (index === 0) {
        await checkpoint(admission.promise, "Native submission commit");
        expect(events.filter((event) => event.type === "operation_started")).toEqual([]);
        expect(call).toBe(0);
        commitRelease.resolve();
      }
      const receipt = (await delivered)._unsafeUnwrap();
      ids.push(receipt.operationId);
      // Admission must already be busy, without waiting for Native's partial timer.
      expect(agent.snapshot()._unsafeUnwrap().activity).toBe("busy");
      expect(agent.health()).toMatchObject({ operationId: receipt.operationId });
      expect(events.slice(start).filter((event) => event.type === "operation_started")).toEqual([
        { type: "operation_started", operationId: receipt.operationId },
      ]);
      await checkpoint(entered[index]!.promise, `model ${index}`);
      if (index === 1)
        expect(
          (
            await agent.request("old-abort", { type: "abort", operationId: ids[0]! })
          )._unsafeUnwrap(),
        ).toMatchObject({ type: "rejected", error: { code: "stale_operation" } });
      expect((await agent.deliver(input))._unsafeUnwrap()).toMatchObject({
        duplicate: true,
        operationId: receipt.operationId,
      });
      await checkpoint(patch[index]!.promise, `patch ${index}`);
      releases[index]!.resolve();
      await agent.waitForIdle();
      const scoped = events.slice(start).filter((event) => "operationId" in event);
      expect(
        scoped.every(
          (event) => "operationId" in event && event.operationId === receipt.operationId,
        ),
      ).toBe(true);
      expect(scoped.at(-1)).toEqual({
        type: "operation_finished",
        operationId: receipt.operationId,
        outcome: "completed",
      });
    }
    expect(new Set(ids).size).toBe(2);
  } finally {
    commitRelease.resolve();
    for (const release of releases) release.resolve();
    await agent.close();
  }
});

it("gives genuine no-input background work a task identity before upcoming input", async () => {
  const release = latch();
  const entered = latch();
  const terminal = latch();
  const pending = defineTask<null, { phase: "run" }, null>({
    name: "identity-background",
    version: 1,
    initial: () => ({ phase: "run" }),
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
    phases: {
      run: async (_task, runtime, ctx) => {
        entered.resolve();
        await release.promise;
        await runtime.commit(
          () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
          ctx,
        );
        terminal.resolve();
      },
    },
  });
  const registry = () => {
    const value = createRegistry();
    value.install({ name: "identity-background", tasks: [pending] });
    return value;
  };
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  const authority = new MemoryAgentPersistence();
  const storage = (await authority.openOrb("background", false))._unsafeUnwrap().storage;
  const seed = await Harness.open(storage, { models, registry: registry() }, BACKGROUND_CONTEXT);
  const root = await seed.root(BACKGROUND_CONTEXT, {
    agent: { model: { provider: "faux", modelId: "faux-1" } },
  });
  const task = await root.commit(
    (tx) =>
      tx.createTask(pending, null, {
        ownership: { kind: "conversation" },
        background: true,
      }),
    BACKGROUND_CONTEXT,
  );
  await seed.close(BACKGROUND_CONTEXT);
  const agent = (
    await DurableAgent.open({
      orbId: "background",
      storage: (await authority.openOrb("background", true))._unsafeUnwrap().storage,
      models,
      registry: registry(),
      env: new NodeExecutionEnv({ cwd: "/tmp" }),
      checkoutCommit: "commit",
      instructions: "instructions",
    })
  )._unsafeUnwrap();
  try {
    await checkpoint(entered.promise, "background task");
    const operationId = `${agent.snapshot()._unsafeUnwrap().session.id}:task:${task}`;
    expect(agent.health()).toMatchObject({ activity: "busy", operationId });
    const receipt = (
      await agent.deliver({
        baseUrl: "central",
        messageId: "upcoming",
        messageIds: ["upcoming"],
        content: [{ type: "text", text: "upcoming" }],
      })
    )._unsafeUnwrap();
    expect(receipt).toMatchObject({ operationId, delivery: "steer" });
    (await agent.waitForIdle())._unsafeUnwrap();
    expect(agent.health()).toMatchObject({ activity: "busy", operationId });
    release.resolve();
    await checkpoint(terminal.promise, "background completion");
  } finally {
    release.resolve();
    await agent.close();
    await authority.close();
  }
});

it("keeps queued Native steering generations in the accepted busy operation", async () => {
  const faux = fauxProvider();
  const models = createModels();
  const entered = [latch(), latch()];
  const releases = [latch(), latch()];
  let calls = 0;
  const contexts: string[] = [];
  faux.setResponses(
    [0, 1].map((index) => async (context) => {
      calls++;
      contexts.push(JSON.stringify(context.messages));
      entered[index]!.resolve();
      await releases[index]!.promise;
      return fauxAssistantMessage(`answer-${index}`);
    }),
  );
  models.setProvider(faux.provider);
  const agent = (
    await DurableAgent.open({
      orbId: "steering",
      storage: new MemoryStorage(),
      models,
      registry: createRegistry(),
      env: new NodeExecutionEnv({ cwd: "/tmp" }),
      checkoutCommit: "commit",
      instructions: "instructions",
      initialSettings: { model: { provider: "faux", id: "faux-1" }, thinkingLevel: "off" },
    })
  )._unsafeUnwrap();
  const events: RuntimeEvent[] = [];
  agent.subscribe((frame) => {
    if (frame.type === "runtime.event") events.push(frame.event);
  });
  const input = (id: string) => ({
    baseUrl: "central",
    messageId: id,
    messageIds: [id],
    content: [{ type: "text" as const, text: id }],
  });
  try {
    const first = (await agent.deliver(input("first")))._unsafeUnwrap();
    await checkpoint(entered[0]!.promise, "first generation");
    const queued = (await agent.deliver(input("queued")))._unsafeUnwrap();
    expect(queued).toMatchObject({ operationId: first.operationId, delivery: "steer" });
    expect(calls).toBe(1);
    releases[0]!.resolve();
    await checkpoint(entered[1]!.promise, "steered generation");
    expect(contexts[1]).toContain("queued");
    expect(agent.health()).toMatchObject({ operationId: first.operationId, activity: "busy" });
    expect((await agent.deliver(input("queued")))._unsafeUnwrap()).toMatchObject({
      duplicate: true,
      operationId: first.operationId,
      delivery: "steer",
    });
    releases[1]!.resolve();
    (await agent.waitForIdle())._unsafeUnwrap();
    expect(events.filter((event) => event.type === "operation_started")).toEqual([
      { type: "operation_started", operationId: first.operationId },
    ]);
    expect(events.filter((event) => event.type === "operation_finished")).toEqual([
      { type: "operation_finished", operationId: first.operationId, outcome: "completed" },
    ]);
    expect(
      agent
        .snapshot()
        ._unsafeUnwrap()
        .records.flatMap((record) =>
          record.type === "message" && record.role === "user" ? [record.inboxMessageIds] : [],
        ),
    ).toEqual([["first"], ["queued"]]);
  } finally {
    for (const release of releases) release.resolve();
    await agent.close();
  }
});
