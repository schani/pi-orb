import { randomUUID } from "node:crypto";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, type Storage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { NoSimulationTask } from "determined";
import { expect, it } from "vitest";
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
    const storage = new Proxy(lease.storage, {
      get(target, key) {
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
    faux.setResponses([
      () => {
        calls++;
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
        beginDrain: lease.beginDrain,
        closeResources: lease.release,
      })
    )._unsafeUnwrap();
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
    expect((await delivery).isErr()).toBe(true);
    expect(calls).toBe(0);
    (
      await database.store.failOrbMessageBatch(task, {
        orbId: orb.id,
        messageIds: [firstId, cancelId],
        deliveryBatchId: batch[0]!.deliveryBatchId!,
        lastError: "old rejection",
        now: 4,
      })
    )._unsafeUnwrap();
    const retained = (await database.store.listOrbMessages(task, orb.id))._unsafeUnwrap();
    expect(retained.find((row) => row.messageId === firstId)?.status).toBe("delivering");
    expect(retained.find((row) => row.messageId === cancelId)?.lastError).toBe(
      "Cancelled before agent admission",
    );
    (
      await agent.deliver({
        baseUrl: "unused",
        messageId: next[0]!.deliveryBatchId!,
        messageIds: [firstId],
        content: [{ type: "text", text: "survivor" }],
      })
    )._unsafeUnwrap();
    await agent.waitForIdle();
    expect(calls).toBe(1);
    expect(JSON.stringify(agent.snapshot()._unsafeUnwrap().records)).not.toContain("cancel me");
    expect(
      agent
        .snapshot()
        ._unsafeUnwrap()
        .records.filter((record) => record.type === "message" && record.role === "user"),
    ).toHaveLength(1);
  } finally {
    release.resolve();
    await delivery;
    await agent?.close();
    await database.close();
  }
});
