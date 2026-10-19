import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, type Harness, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { errAsync, okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { DurableAgent } from "./agent.ts";
import { durableError } from "./manager.ts";
import { MemoryAgentPersistence } from "./memory-persistence.testkit.ts";

const input = (messageId: string) => ({
  baseUrl: "central",
  messageId,
  messageIds: [messageId],
  content: [{ type: "text" as const, text: messageId }],
});
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("recovers settled provisional receipts without adopting the newer active operation", async () => {
  const authority = new MemoryAgentPersistence();
  const storage = (await authority.openOrb("orb", false))._unsafeUnwrap().storage;
  const started = barrier(),
    finish = barrier();
  let refuse = false,
    checks = 0;
  let conversation!: Harness["conversation"];
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
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
  faux.setResponses([
    fauxAssistantMessage("settled"),
    async () => {
      started.resolve();
      await finish.promise;
      return fauxAssistantMessage("newer");
    },
  ]);
  let agent = (await open())._unsafeUnwrap();
  const provisional = [input("first"), input("second")];
  try {
    refuse = true;
    expect((await agent.deliverMany(provisional)).isErr()).toBe(true);
    refuse = false;
    // Crash boundary: Native admission committed, receipt finalization did not.
    const root = await conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
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
    expect(
      (await storage.scanSubmissions({}, 100, undefined, BACKGROUND_CONTEXT)).items.every(
        (s) => s.status === "done",
      ),
    ).toBe(true);
    await agent.close();
    agent = (await open())._unsafeUnwrap();
    const newer = (await agent.deliver(input("newer")))._unsafeUnwrap();
    await started.promise;
    const before = await storage.scanSubmissions({}, 100, undefined, BACKGROUND_CONTEXT);
    const recovered = (await agent.deliverMany(provisional))
      ._unsafeUnwrap()
      .map((r) => r._unsafeUnwrap());
    const operationId = `conversation:orb:submission:${admitted.submissions[0]!.id}`;
    expect(recovered).toMatchObject(
      provisional.map((request) => ({
        messageId: request.messageId,
        operationId,
        duplicate: false,
        delivery: "turn",
      })),
    );
    expect((await agent.deliver(provisional[0]!))._unsafeUnwrap()).toEqual({
      ...recovered[0]!,
      duplicate: true,
    });
    expect(
      (await agent.deliverMany(provisional))._unsafeUnwrap().map((r) => r._unsafeUnwrap()),
    ).toEqual(recovered.map((r) => ({ ...r, duplicate: true })));
    expect(operationId).not.toBe(newer.operationId);
    expect(
      (await agent.request("abort-old", { type: "abort", operationId }))._unsafeUnwrap(),
    ).toMatchObject({ type: "rejected", error: { code: "stale_operation" } });
    expect(agent.health()).toMatchObject({ activity: "busy", operationId: newer.operationId });
    expect(faux.state.callCount).toBe(2);
    expect(await storage.scanSubmissions({}, 100, undefined, BACKGROUND_CONTEXT)).toEqual(before);
  } finally {
    finish.resolve();
    await agent.close();
    await authority.close();
  }
});
