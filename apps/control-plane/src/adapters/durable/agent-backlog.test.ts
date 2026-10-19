import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  type Harness,
  MemoryStorage,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { DeliverOrbMessageResponse } from "@pi-orb/protocol";
import { errAsync, ok, okAsync, ResultAsync } from "neverthrow";
import { expect, it } from "vitest";
import { DurableAgent } from "./agent.ts";
import { durableError } from "./manager.ts";
import { MemoryAgentPersistence } from "./memory-persistence.testkit.ts";

it("retains FIFO, independent peer receipts and mixed duplicate/new admission", async () => {
  const models = createModels();
  const faux = fauxProvider();
  const contexts: string[] = [];
  faux.setResponses(
    Array(2).fill((request: { messages: unknown }) => {
      contexts.push(JSON.stringify(request.messages));
      return fauxAssistantMessage("answer");
    }),
  );
  models.setProvider(faux.provider);
  const storage = new MemoryStorage();
  const agent = (
    await DurableAgent.open({
      orbId: "orb",
      storage,
      models,
      registry: createRegistry(),
      env: new NodeExecutionEnv({ cwd: "/tmp" }),
      checkoutCommit: "commit",
      instructions: "instruction",
      initialSettings: { model: { provider: "faux", id: "faux-1" }, thinkingLevel: "off" },
    })
  )._unsafeUnwrap();
  const inputs = ["peer A", "HUMAN BODY", "peer B"].map((text, index) => ({
    baseUrl: "central",
    messageId: `message-${index}`,
    messageIds: [`message-${index}`],
    content: [{ type: "text" as const, text }],
    ...(index === 1
      ? {}
      : {
          system: {
            kind: "orb_message" as const,
            senderOrbId:
              index === 0
                ? "00000000-0000-4000-8000-000000000001"
                : "00000000-0000-4000-8000-000000000002",
          },
        }),
  }));
  try {
    const first = (await agent.deliverMany(inputs))
      ._unsafeUnwrap()
      .map((result) => result._unsafeUnwrap());
    expect(new Set(first.map((response) => response.operationId)).size).toBe(1);
    (await agent.waitForIdle())._unsafeUnwrap();
    expect(contexts).toHaveLength(1);
    const firstContext = contexts[0]!;
    expect(firstContext.indexOf("peer A")).toBeLessThan(firstContext.indexOf("HUMAN BODY"));
    expect(firstContext.indexOf("HUMAN BODY")).toBeLessThan(firstContext.indexOf("peer B"));
    const records = agent.snapshot()._unsafeUnwrap().records;
    expect(
      records.filter((record) => record.type === "event" && record.eventType === "orb.message"),
    ).toMatchObject([
      { sender: { orbId: inputs[0]!.system!.senderOrbId }, inboxMessageIds: ["message-0"] },
      { sender: { orbId: inputs[2]!.system!.senderOrbId }, inboxMessageIds: ["message-2"] },
    ]);
    const next = {
      ...inputs[1]!,
      messageId: "next",
      messageIds: ["next"],
      content: [{ type: "text" as const, text: "later human" }],
    };
    const mixed = (await agent.deliverMany([inputs[0]!, next]))
      ._unsafeUnwrap()
      .map((result) => result._unsafeUnwrap());
    expect(mixed[0]).toEqual({ ...first[0]!, duplicate: true });
    expect(mixed[1]?.duplicate).toBe(false);
    (await agent.waitForIdle())._unsafeUnwrap();
    expect(contexts).toHaveLength(2);
    const native = await storage.scanSubmissions({}, 100, undefined, BACKGROUND_CONTEXT);
    expect(
      native.items.filter((submission) => submission.requestId?.startsWith("inbox:")),
    ).toHaveLength(4);
    expect(
      agent
        .snapshot()
        ._unsafeUnwrap()
        .records.filter((record) => record.type === "event" && record.eventType === "orb.message"),
    ).toHaveLength(2);
  } finally {
    await agent.close();
  }
});

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each(["preflight", "provisional"] as const)(
  "classifies successful admission after the old operation finishes during %s",
  async (race) => {
    const models = createModels();
    const faux = fauxProvider();
    const started = barrier();
    const finish = barrier();
    const checking = barrier();
    const admit = barrier();
    faux.setResponses([
      async () => {
        started.resolve();
        await finish.promise;
        return fauxAssistantMessage("first answer");
      },
      fauxAssistantMessage("new answer"),
    ]);
    models.setProvider(faux.provider);
    let holdPreflight = false;
    let refuse = false;
    let checks = 0;
    const agent = (
      await DurableAgent.open({
        orbId: "orb",
        storage: new MemoryStorage(),
        models,
        registry: createRegistry(),
        env: new NodeExecutionEnv({ cwd: "/tmp" }),
        checkoutCommit: "commit",
        instructions: "instruction",
        initialSettings: { model: { provider: "faux", id: "faux-1" }, thinkingLevel: "off" },
        checkAdmission: () =>
          refuse && ++checks === 2
            ? errAsync(durableError("admission paused", true))
            : okAsync(undefined),
        checkInputAdmission: () =>
          ResultAsync.fromSafePromise(
            (async () => {
              if (holdPreflight) {
                checking.resolve();
                await admit.promise;
              }
              return ok(undefined);
            })(),
          ).andThen((result) => result),
      })
    )._unsafeUnwrap();
    const input = (messageId: string) => ({
      baseUrl: "central",
      messageId,
      messageIds: [messageId],
      content: [{ type: "text" as const, text: messageId }],
    });
    try {
      const first = (await agent.deliver(input("first")))._unsafeUnwrap();
      await started.promise;
      let pending: ReturnType<DurableAgent["deliver"]> | undefined;
      if (race === "preflight") {
        holdPreflight = true;
        pending = agent.deliver(input("next"));
        await checking.promise;
      } else {
        refuse = true;
        expect((await agent.deliver(input("next"))).isErr()).toBe(true);
        refuse = false;
      }
      finish.resolve();
      (await agent.waitForIdle())._unsafeUnwrap();
      expect(agent.health()).toMatchObject({ activity: "idle" });
      admit.resolve();
      const response = (await (pending ?? agent.deliver(input("next"))))._unsafeUnwrap();
      expect(response.delivery).toBe("turn");
      expect(response.operationId).not.toBe(first.operationId);
      (await agent.waitForIdle())._unsafeUnwrap();
      expect((await agent.deliver(input("next")))._unsafeUnwrap()).toEqual({
        ...response,
        duplicate: true,
      });
      expect(faux.state.callCount).toBe(2);
    } finally {
      finish.resolve();
      admit.resolve();
      await agent.close();
    }
  },
);

it.each(["single", "batch", "finalized duplicate", "newer active"] as const)(
  "recovers settled provisional %s receipts without another inference",
  async (scenario) => {
    const authority = new MemoryAgentPersistence();
    const models = createModels();
    const faux = fauxProvider();
    const started = barrier();
    const finish = barrier();
    faux.setResponses([
      fauxAssistantMessage("answer"),
      async () => {
        started.resolve();
        if (scenario === "newer active") await finish.promise;
        return fauxAssistantMessage("answer");
      },
    ]);
    models.setProvider(faux.provider);
    const storage = (await authority.openOrb("orb", false))._unsafeUnwrap().storage;
    let refuse = false;
    let checks = 0;
    let conversation!: Harness["conversation"];
    const open = () =>
      DurableAgent.open({
        orbId: "orb",
        storage,
        models,
        registry: createRegistry(),
        env: new NodeExecutionEnv({ cwd: "/tmp" }),
        checkoutCommit: "commit",
        instructions: "instruction",
        initialSettings: { model: { provider: "faux", id: "faux-1" }, thinkingLevel: "off" },
        bindNativeConversation: (resolve) => {
          conversation = resolve;
        },
        checkAdmission: () =>
          refuse && ++checks === 2
            ? errAsync(durableError("admission paused", true))
            : okAsync(undefined),
      });
    let agent = (await open())._unsafeUnwrap();
    const input = (messageId: string) => ({
      baseUrl: "central",
      messageId,
      messageIds: [messageId],
      content: [{ type: "text" as const, text: messageId }],
    });
    const provisional = [input("first"), ...(scenario === "single" ? [] : [input("second")])];
    let previous: DeliverOrbMessageResponse | undefined;
    try {
      if (scenario === "finalized duplicate") {
        previous = (await agent.deliver(input("previous")))._unsafeUnwrap();
        (await agent.waitForIdle())._unsafeUnwrap();
      }
      const requests = previous ? [input("previous"), ...provisional] : provisional;
      refuse = true;
      expect((await agent.deliverMany(requests)).isErr()).toBe(true);
      refuse = false;
      // Retain the same boundary as a crash after Native admission but before receipt finalization.
      const root = await conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
      expect(root).toBeDefined();
      const admitted = await root!.submitMany(
        provisional.map((request) => ({
          type: "input" as const,
          requestId: `inbox:${request.messageId}`,
          content: request.content,
          whenBusy: "steer" as const,
        })),
        BACKGROUND_CONTEXT,
      );
      (await agent.waitForIdle())._unsafeUnwrap();
      const nativeBefore = await storage.scanSubmissions({}, 100, undefined, BACKGROUND_CONTEXT);
      expect(nativeBefore.items.every((submission) => submission.status === "done")).toBe(true);
      await agent.close();
      agent = (await open())._unsafeUnwrap();
      let newer: DeliverOrbMessageResponse | undefined;
      if (scenario === "newer active") {
        newer = (await agent.deliver(input("newer")))._unsafeUnwrap();
        await started.promise;
      }
      const nativeAtRetry = await storage.scanSubmissions({}, 100, undefined, BACKGROUND_CONTEXT);
      const recovered = (await agent.deliverMany(requests))
        ._unsafeUnwrap()
        .map((result) => result._unsafeUnwrap());
      if (previous) expect(recovered.shift()).toEqual({ ...previous, duplicate: true });
      expect(recovered.map((receipt) => receipt.operationId)).toEqual(
        provisional.map(() => `conversation:orb:submission:${admitted.submissions[0]!.id}`),
      );
      expect(recovered.every((receipt) => !receipt.duplicate && receipt.delivery === "turn")).toBe(
        true,
      );
      const duplicates = (await agent.deliverMany(provisional))
        ._unsafeUnwrap()
        .map((result) => result._unsafeUnwrap());
      expect(duplicates).toEqual(recovered.map((receipt) => ({ ...receipt, duplicate: true })));
      if (newer) {
        expect(recovered.every((receipt) => receipt.operationId !== newer.operationId)).toBe(true);
        expect(
          (
            await agent.request("abort-old", {
              type: "abort",
              operationId: recovered[0]!.operationId,
            })
          )._unsafeUnwrap(),
        ).toMatchObject({ type: "rejected", error: { code: "stale_operation" } });
        expect(agent.health()).toMatchObject({ activity: "busy", operationId: newer.operationId });
      }
      expect(faux.state.callCount).toBe(previous || newer ? 2 : 1);
      expect(await storage.scanSubmissions({}, 100, undefined, BACKGROUND_CONTEXT)).toEqual(
        nativeAtRetry,
      );
      finish.resolve();
      (await agent.waitForIdle())._unsafeUnwrap();
    } finally {
      finish.resolve();
      await agent.close();
    }
  },
);
