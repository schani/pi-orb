import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, ROOT_CONVERSATION_ID, type Storage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { NoSimulationTask } from "determined";
import { expect, it } from "vitest";
import { squashMessageBatch } from "../../domain/message-batch.ts";
import { cancelQueuedUserTurn } from "../../domain/queued-turn-cancellation.ts";
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

it.each(["singleton", "batch"] as const)(
  "%s native admission wins pending cancellation for either UUID spelling before the dispatcher ACK",
  async (kind) => {
    const db = new PGliteClient();
    const database = composeControlPlaneDatabase(db);
    const task = new NoSimulationTask("state-machine-inbox", false);
    task.wallNow = () => 1_000;
    const project = makeProjectRow("11111111-1111-4111-8111-111111111111");
    const orb = makeOrbRow("22222222-2222-4222-8222-222222222222", project.id, "running");
    const member = "abcdefab-cdef-4abc-8def-abcdefabcdef";
    const survivor = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const caller = {
      kind: "central" as const,
      orbId: orb.id,
      projectId: project.id,
      ownerUserId: project.ownerUserId,
      agentAdmissionVersion: 0,
    };
    const modelEntered = barrier();
    const releaseModel = barrier();
    const committed = barrier();
    const releaseCommit = barrier();
    let batchId: string | undefined;
    let agent: DurableAgent | undefined;
    let delivery: ReturnType<DurableAgent["deliver"]> | undefined;
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
      const lease = (
        await database.agentPersistence.open(task, orb, { signal: new AbortController().signal })
      )._unsafeUnwrap();
      // Hold only the acknowledgement: native writes, admission guard and SQL commit are real.
      const storage = new Proxy(lease.storage, {
        get(target, key) {
          if (key === "commit")
            return async (...args: Parameters<Storage["commit"]>) => {
              const result = await target.commit(...args);
              if (
                batchId !== undefined &&
                args[0].some(
                  (write) =>
                    write.type === "submission" &&
                    write.value.requestId === `inbox:${batchId}` &&
                    write.value.status === "queued",
                )
              ) {
                committed.resolve();
                await releaseCommit.promise;
              }
              return result;
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Storage;
      const models = createModels();
      const faux = fauxProvider();
      faux.setResponses([
        async () => {
          modelEntered.resolve();
          await releaseModel.promise;
          return fauxAssistantMessage("prior answer");
        },
        fauxAssistantMessage("queued answer"),
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
          checkAdmission: lease.check,
          checkInputAdmission: lease.checkInputAdmission,
          beginDrain: lease.beginDrain,
          closeResources: lease.release,
        })
      )._unsafeUnwrap();
      (
        await agent.deliver({
          baseUrl: "central",
          messageId: "browser:prior",
          messageIds: [],
          content: [{ type: "text", text: "prior" }],
        })
      )._unsafeUnwrap();
      await modelEntered.promise;
      for (const id of kind === "batch" ? [member, survivor] : [member])
        (
          await database.store.enqueueOrbMessage(task, {
            orbId: orb.id,
            messageId: id,
            content: [{ type: "text", text: id }],
            wake: false,
            now: 1_000,
          })
        )._unsafeUnwrap();
      const batch = (
        await database.store.claimOrbMessageBacklog(task, { orbId: orb.id, now: 1_000 })
      )._unsafeUnwrap();
      const claimedBatchId = batch[0]?.deliveryBatchId;
      assert(typeof claimedBatchId === "string", "Claimed batch has a delivery identity");
      batchId = claimedBatchId;
      delivery = agent.deliver({
        baseUrl: "central",
        messageId: batchId,
        messageIds: batch.map((row) => row.messageId),
        content: squashMessageBatch(batch),
      });
      expect(await Promise.race([committed.promise.then(() => "committed"), delivery])).toBe(
        "committed",
      );
      const native = await lease.storage.submissionByRequest(
        ROOT_CONVERSATION_ID,
        `inbox:${batchId}`,
        BACKGROUND_CONTEXT,
      );
      expect(native).toMatchObject({ status: "queued" });
      const before = (await database.store.listOrbMessages(task, orb.id))._unsafeUnwrap();
      expect(before.every((row) => row.operationId === null)).toBe(true);
      expect(
        (
          await cancelQueuedUserTurn(task, database.store, caller, `inbox:${member}`)
        )._unsafeUnwrap(),
      ).toBe("active");
      const upper = (
        await cancelQueuedUserTurn(task, database.store, caller, `inbox:${member.toUpperCase()}`)
      )._unsafeUnwrap();
      const after = (await database.store.listOrbMessages(task, orb.id))._unsafeUnwrap();
      expect({ cancellation: upper, messages: after }).toEqual({
        cancellation: "active",
        messages: before,
      });
      expect(
        await lease.storage.submissionByRequest(
          ROOT_CONVERSATION_ID,
          `inbox:${batchId}`,
          BACKGROUND_CONTEXT,
        ),
      ).toEqual(native);
    } finally {
      releaseCommit.resolve();
      releaseModel.resolve();
      await delivery;
      await agent?.close();
      (await database.close())._unsafeUnwrap();
    }
  },
);
