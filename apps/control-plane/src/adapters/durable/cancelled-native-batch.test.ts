import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, ROOT_CONVERSATION_ID, type Storage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { NoSimulationTask } from "determined";
import type { Result } from "neverthrow";
import { expect, it } from "vitest";
import type { RuntimeClientError } from "../../domain/errors.ts";
import { makeOrbRow, makeProjectRow } from "../../testkit/fixtures.ts";
import { composeControlPlaneDatabase } from "../database.ts";
import { PGliteClient } from "../pg/pglite-client.ts";
import { DurableAgent } from "./agent.ts";

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it("cancels one member of a frozen batch, rejects late admission and delivers its survivor once under a fresh batch", async () => {
  const db = new PGliteClient(),
    database = composeControlPlaneDatabase(db);
  const task = new NoSimulationTask("cancel-native-batch", false);
  const project = makeProjectRow(randomUUID()),
    orb = makeOrbRow(randomUUID(), project.id, "running");
  const firstId = randomUUID(),
    cancelId = randomUUID();
  const entered = barrier(),
    release = barrier();
  let agent: DurableAgent | undefined;
  let delivery: ReturnType<DurableAgent["deliver"]> | undefined;
  let calls = 0;
  const requireOk = <T, E>(phase: string, result: Result<T, E>): T => {
    if (result.isErr())
      expect.fail(JSON.stringify({ phase, error: result.error, health: agent?.health(), calls }));
    return result._unsafeUnwrap();
  };
  try {
    (await database.migrate())._unsafeUnwrap();
    (
      await database.users.resolveUser(
        task,
        { issuer: "test", subject: "owner", email: null },
        { id: project.ownerUserId, now: 0 },
      )
    )._unsafeUnwrap();
    (await database.store.insertProject(task, project))._unsafeUnwrap();
    (await database.store.insertOrb(task, orb))._unsafeUnwrap();
    for (const [id, text] of [
      [firstId, "survivor"],
      [cancelId, "cancel me"],
    ])
      (
        await database.store.enqueueOrbMessage(task, {
          orbId: orb.id,
          messageId: id!,
          content: [{ type: "text", text: text! }],
          wake: false,
          now: 0,
        })
      )._unsafeUnwrap();
    const batch = (
      await database.store.claimNextOrbMessageBatch(task, { orbId: orb.id, now: 1 })
    )._unsafeUnwrap();
    expect(batch.map((row) => row.messageId)).toEqual([firstId, cancelId]);
    const lease = (
      await database.agentPersistence.open(task, orb, { signal: new AbortController().signal })
    )._unsafeUnwrap();
    let storageCloseCalls = 0,
      storageCloseCompletions = 0,
      resourceCloseCalls = 0,
      resourceCloseCompletions = 0;
    const closeStorage: Storage["close"] = async (...args) => {
      storageCloseCalls++;
      await lease.storage.close(...args);
      storageCloseCompletions++;
    };
    const closeResources = () => {
      resourceCloseCalls++;
      return lease.release().map(() => {
        resourceCloseCompletions++;
        return undefined;
      });
    };
    const storage = new Proxy(lease.storage, {
      get(target, key) {
        if (key === "close") return closeStorage;
        if (key === "commit")
          return async (...args: Parameters<Storage["commit"]>) => {
            if (
              args[0].some(
                (write) =>
                  write.type === "submission" &&
                  write.value.requestId === `inbox:${batch[0]!.deliveryBatchId}`,
              )
            ) {
              entered.resolve();
              await release.promise;
            }
            return target.commit(...args);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Storage;
    const models = createModels(),
      faux = fauxProvider();
    let modelContext = "";
    faux.setResponses([
      (context) => {
        calls++;
        modelContext = JSON.stringify(context.messages);
        return fauxAssistantMessage("survived");
      },
    ]);
    models.setProvider(faux.provider);
    agent = (
      await DurableAgent.open({
        orbId: orb.id,
        storage,
        models,
        registry: createRegistry(),
        env: new NodeExecutionEnv({ cwd: "/tmp" }),
        checkoutCommit: "commit",
        instructions: "",
        initialSettings: { model: { provider: "faux", id: "faux-1" }, thinkingLevel: "off" },
        checkInputAdmission: lease.checkInputAdmission,
        beginDrain: lease.beginDrain,
        closeResources,
      })
    )._unsafeUnwrap();
    const before = agent.snapshot()._unsafeUnwrap().records;
    delivery = agent.deliver({
      baseUrl: "unused",
      messageId: batch[0]!.deliveryBatchId!,
      messageIds: [firstId, cancelId],
      content: [{ type: "text", text: "survivor\n\ncancel me" }],
    });
    expect(
      await Promise.race([entered.promise.then(() => "held"), delivery.then((result) => result)]),
    ).toBe("held");
    expect(
      (
        await database.store.cancelPendingOrbMessage(task, {
          orbId: orb.id,
          messageId: cancelId,
          caller: {
            kind: "central",
            orbId: orb.id,
            projectId: project.id,
            ownerUserId: project.ownerUserId,
            agentAdmissionVersion: 0,
          },
          now: 2,
        })
      )._unsafeUnwrap(),
    ).toBe("cancelled");
    const next = (
      await database.store.claimNextOrbMessageBatch(task, { orbId: orb.id, now: 3 })
    )._unsafeUnwrap();
    expect(next.map((row) => row.messageId)).toEqual([firstId]);
    expect(next[0]?.deliveryBatchId).not.toBe(batch[0]?.deliveryBatchId);
    release.resolve();
    const rejected = await delivery;
    expect(rejected._unsafeUnwrapErr()).toMatchObject({
      type: "runtime_client_error",
      code: "history_unavailable",
      message: "Input admission changed",
      retryable: true,
    });
    const failedIdle = await agent.waitForIdle();
    expect(failedIdle._unsafeUnwrapErr()).toMatchObject({
      code: "history_unavailable",
      message: "Input admission changed",
    });
    expect(calls).toBe(0);
    expect(
      requireOk(
        "public snapshot after rejection",
        await database.agentPersistence.snapshot(task, orb),
      ).records,
    ).toEqual(before);
    requireOk(
      "fail old batch",
      await database.store.failOrbMessageBatch(task, {
        orbId: orb.id,
        messageIds: [firstId, cancelId],
        deliveryBatchId: batch[0]!.deliveryBatchId!,
        lastError: "old rejection",
        now: 4,
      }),
    );
    const retained = requireOk(
      "retained batch",
      await database.store.listOrbMessages(task, orb.id),
    );
    expect(retained.find((row) => row.messageId === firstId)?.status).toBe("delivering");
    expect(retained.find((row) => row.messageId === cancelId)?.lastError).toBe(
      "Cancelled before agent admission",
    );
    expect(
      (
        await agent.deliver({
          baseUrl: "unused",
          messageId: batch[0]!.deliveryBatchId!,
          messageIds: [firstId, cancelId],
          content: [{ type: "text", text: "survivor\n\ncancel me" }],
        })
      )._unsafeUnwrapErr(),
    ).toEqual(rejected._unsafeUnwrapErr());
    expect(
      (
        await agent.request("late-user", {
          type: "message",
          content: [{ type: "text", text: "late user" }],
          expectedHeadId: before.at(-1)?.id ?? null,
        })
      )._unsafeUnwrapErr(),
    ).toEqual(rejected._unsafeUnwrapErr());
    expect(
      requireOk("public snapshot before close", await database.agentPersistence.snapshot(task, orb))
        .records,
    ).toEqual(before);
    const closing = agent.close();
    expect(agent.close()).toBe(closing);
    const closed = await closing;
    expect(closed._unsafeUnwrapErr()).toEqual({
      type: "runtime_client_error",
      code: "history_unavailable",
      answered: true,
      retryable: true,
      message: "Agent drain ownership unavailable",
    } satisfies RuntimeClientError);
    expect(storageCloseCompletions).toBeGreaterThan(0);
    expect(storageCloseCompletions).toBe(storageCloseCalls);
    expect(resourceCloseCalls).toBe(1);
    expect(resourceCloseCompletions).toBe(1);
    const completedStorageCloses = storageCloseCompletions;
    expect(agent.close()).toBe(closing);
    expect(await agent.close()).toBe(closed);
    expect(storageCloseCalls).toBe(completedStorageCloses);
    expect(storageCloseCompletions).toBe(completedStorageCloses);
    expect(resourceCloseCalls).toBe(1);
    expect(resourceCloseCompletions).toBe(1);
    expect(calls).toBe(0);
    expect(agent.health()).toMatchObject({
      status: "failed",
      error: { code: "central_agent_failed", message: "Input admission changed" },
    });
    expect(lease.signal.aborted).toBe(true);
    const freshLease = requireOk(
      "fresh lease",
      await database.agentPersistence.open(task, orb, { signal: new AbortController().signal }),
    );
    agent = requireOk(
      "fresh agent",
      await DurableAgent.open({
        orbId: orb.id,
        storage: freshLease.storage,
        models,
        registry: createRegistry(),
        env: new NodeExecutionEnv({ cwd: "/tmp" }),
        checkoutCommit: "commit",
        instructions: "",
        initialSettings: { model: { provider: "faux", id: "faux-1" }, thinkingLevel: "off" },
        checkInputAdmission: freshLease.checkInputAdmission,
        beginDrain: freshLease.beginDrain,
        closeResources: freshLease.release,
      }),
    );
    expect(freshLease.signal.aborted).toBe(false);
    expect(agent.health()).toMatchObject({ status: "ready", activity: "idle" });
    expect(requireOk("fresh snapshot", agent.snapshot()).records).toEqual(before);
    const freshRequest = {
      baseUrl: "unused",
      messageId: next[0]!.deliveryBatchId!,
      messageIds: [firstId],
      content: [{ type: "text" as const, text: "survivor" }],
    };
    const freshDelivery = await agent.deliver(freshRequest);
    expect(
      freshDelivery.isOk(),
      freshDelivery.isErr() ? JSON.stringify(freshDelivery.error) : undefined,
    ).toBe(true);
    expect(requireOk("fresh delivery", freshDelivery)).toMatchObject({
      messageId: next[0]!.deliveryBatchId!,
      duplicate: false,
      delivery: "turn",
    });
    requireOk("fresh idle", await agent.waitForIdle());
    expect(agent.health()).toMatchObject({ status: "ready", activity: "idle" });
    expect(requireOk("fresh duplicate", await agent.deliver(freshRequest))).toMatchObject({
      messageId: next[0]!.deliveryBatchId!,
      operationId: requireOk("fresh delivery receipt", freshDelivery).operationId,
      duplicate: true,
    });
    requireOk("duplicate idle", await agent.waitForIdle());
    expect(calls).toBe(1);
    expect(faux.state.callCount).toBe(1);
    expect(modelContext).toContain("survivor");
    expect(modelContext).not.toContain("cancel me");
    expect(modelContext).not.toContain(cancelId);
    expect(modelContext).not.toContain("late user");
    const submissions = await freshLease.storage.scanSubmissions(
      { conversationId: ROOT_CONVERSATION_ID },
      100,
      undefined,
      BACKGROUND_CONTEXT,
    );
    expect(submissions.items).toHaveLength(1);
    expect(submissions.items[0]).toMatchObject({
      conversationId: ROOT_CONVERSATION_ID,
      requestId: `inbox:${next[0]!.deliveryBatchId}`,
      status: "done",
    });
    const identityDocument = await freshLease.storage.findDocument(
      {
        kind: "orb.identity",
        scope: { kind: "conversation", conversationId: ROOT_CONVERSATION_ID },
      },
      "current",
      BACKGROUND_CONTEXT,
    );
    expect(identityDocument).toBeDefined();
    const identity = await freshLease.storage.document(
      identityDocument!.id,
      "current",
      BACKGROUND_CONTEXT,
    );
    expect(identity?.value).toMatchObject({
      sessionId: requireOk("fresh session ownership", agent.snapshot()).session.id,
      receipts: {
        [next[0]!.deliveryBatchId!]: {
          messageIds: [firstId],
          submissionId: submissions.items[0]!.id,
          operationId: requireOk("fresh operation ownership", freshDelivery).operationId,
        },
      },
    });
    const records = requireOk("completed fresh snapshot", agent.snapshot()).records;
    expect(JSON.stringify(records)).not.toContain("cancel me");
    expect(JSON.stringify(records)).not.toContain(cancelId);
    expect(JSON.stringify(records)).not.toContain("late user");
    expect(
      records.filter((record) => record.type === "message" && record.role === "user"),
    ).toHaveLength(1);
    expect(
      records.find((record) => record.type === "message" && record.role === "user"),
    ).toMatchObject({ content: [{ type: "text", text: "survivor" }], inboxMessageIds: [firstId] });
  } finally {
    release.resolve();
    await delivery;
    await agent?.close();
    await database.close();
  }
});
