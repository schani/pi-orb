import { randomUUID } from "node:crypto";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, type Storage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { NoSimulationTask } from "determined";
import { expect, it } from "vitest";
import { makeOrbRow, makeProjectRow } from "../../testkit/fixtures.ts";
import { composeControlPlaneDatabase } from "../database.ts";
import { DurableAgent } from "../durable/agent.ts";
import { PgClient, type PostgreSQLClient } from "../pg/client.ts";
import { PGliteClient } from "../pg/pglite-client.ts";

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each(["pglite", "postgres"] as const)(
  "%s native admission before dispatcher ACK remains active; historical inbox cannot abort a later turn",
  async (kind) => {
    const schema = `inbox_abort_${randomUUID().replaceAll("-", "")}`;
    let admin: PgClient | undefined;
    let db: PostgreSQLClient;
    if (kind === "pglite") db = new PGliteClient();
    else {
      const connection =
        process.env.PI_ORB_DURABLE_PG_TEST_URL ??
        "postgres://durable_test:durable_local_test_only@127.0.0.1:55432/durable_test";
      admin = new PgClient(connection);
      (await admin.query(`CREATE SCHEMA ${schema}`))._unsafeUnwrap();
      const url = new URL(connection);
      url.searchParams.set("options", `-c search_path=${schema}`);
      db = new PgClient(url.toString());
    }
    const database = composeControlPlaneDatabase(db);
    const task = new NoSimulationTask("native-inbox-abort", false);
    const project = makeProjectRow(randomUUID());
    const orb = makeOrbRow(randomUUID(), project.id, "running");
    const batchId = randomUUID(),
      messageId = randomUUID(),
      completedId = randomUUID(),
      laterId = randomUUID();
    const committed = barrier(),
      releaseCommit = barrier(),
      priorEntered = barrier(),
      modelEntered = barrier(),
      releaseModel = barrier();
    let agent: DurableAgent | undefined;
    let interrupted = false;
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
      (
        await db.query(
          'INSERT INTO orb_messages(orb_id,message_id,content,status,delivery_batch_id) VALUES($1,$2,\'[{"type":"text","text":"first"}]\',\'delivering\',$3)',
          [orb.id, messageId, batchId],
        )
      )._unsafeUnwrap();
      const lease = (
        await database.agentPersistence.open(task, orb, { signal: new AbortController().signal })
      )._unsafeUnwrap();
      const storage = new Proxy(lease.storage, {
        get(target, key) {
          if (key === "commit")
            return async (...args: Parameters<Storage["commit"]>) => {
              const result = await target.commit(...args);
              if (
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
      const models = createModels(),
        faux = fauxProvider();
      faux.setResponses([
        fauxAssistantMessage("completed answer"),
        async (_request, options) => {
          priorEntered.resolve();
          await new Promise<void>((resolve) =>
            options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
          return fauxAssistantMessage("", { stopReason: "aborted" });
        },
        async (_request, options) => {
          modelEntered.resolve();
          await Promise.race([
            releaseModel.promise,
            new Promise<void>((resolve) => {
              if (options?.signal?.aborted) {
                interrupted = true;
                resolve();
              } else
                options?.signal?.addEventListener(
                  "abort",
                  () => {
                    interrupted = true;
                    resolve();
                  },
                  { once: true },
                );
            }),
          ]);
          return fauxAssistantMessage("later answer");
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
          checkAdmission: lease.check,
          beginDrain: lease.beginDrain,
          closeResources: lease.release,
        })
      )._unsafeUnwrap();
      (
        await db.query(
          'INSERT INTO orb_messages(orb_id,message_id,content,status) VALUES($1,$2,\'[{"type":"text","text":"completed"}]\',\'queued\')',
          [orb.id, completedId],
        )
      )._unsafeUnwrap();
      (
        await db.query(
          "UPDATE orb_messages SET delivery_batch_id=message_id WHERE orb_id=$1 AND message_id=$2",
          [orb.id, completedId],
        )
      )._unsafeUnwrap();
      (
        await agent.deliver({
          baseUrl: "unused",
          messageId: completedId,
          messageIds: [completedId],
          content: [{ type: "text", text: "completed" }],
        })
      )._unsafeUnwrap();
      await agent.waitForIdle();
      expect(
        (
          await db.query("SELECT status FROM orb_messages WHERE orb_id=$1 AND message_id=$2", [
            orb.id,
            completedId,
          ])
        )._unsafeUnwrap().rows[0]?.status,
      ).toBe("delivered");
      (
        await agent.deliver({
          baseUrl: "unused",
          messageId: randomUUID(),
          messageIds: [],
          content: [{ type: "text", text: "prior" }],
        })
      )._unsafeUnwrap();
      await priorEntered.promise;
      delivery = agent.deliver({
        baseUrl: "unused",
        messageId: batchId,
        messageIds: [messageId],
        content: [{ type: "text", text: "first" }],
      });
      expect(
        await Promise.race([
          committed.promise.then(() => "committed"),
          delivery.then((result) => result),
        ]),
      ).toBe("committed");
      expect(
        (
          await db.query(
            "SELECT status,operation_id FROM orb_messages WHERE orb_id=$1 AND message_id=$2",
            [orb.id, messageId],
          )
        )._unsafeUnwrap().rows[0],
      ).toMatchObject({ status: "delivering", operation_id: null });
      const cancelled = await database.store.cancelPendingOrbMessage(task, {
        orbId: orb.id,
        messageId,
        caller: {
          kind: "central",
          orbId: orb.id,
          projectId: project.id,
          ownerUserId: project.ownerUserId,
          agentAdmissionVersion: 0,
        },
        now: 1,
      });
      expect(cancelled.isErr() ? cancelled.error : cancelled.value).toBe("active");
      releaseCommit.resolve();
      (await delivery)._unsafeUnwrap();
      expect(
        (
          await agent.request("admitted-abort", {
            type: "abort",
            operationId: `inbox:${messageId}`,
          })
        )._unsafeUnwrap(),
      ).toMatchObject({ type: "accepted" });
      await agent.waitForIdle();
      expect(
        (
          await db.query(
            "SELECT status,last_error FROM orb_messages WHERE orb_id=$1 AND message_id=$2",
            [orb.id, messageId],
          )
        )._unsafeUnwrap().rows[0],
      ).toMatchObject({ status: "failed", last_error: "Cancelled after agent admission" });
      (
        await database.store.enqueueOrbMessage(task, {
          orbId: orb.id,
          messageId: laterId,
          content: [{ type: "text", text: "later" }],
          wake: false,
          now: 2,
        })
      )._unsafeUnwrap();
      (
        await database.store.claimNextOrbMessageBatch(task, { orbId: orb.id, now: 3 })
      )._unsafeUnwrap();
      (
        await agent.deliver({
          baseUrl: "unused",
          messageId: laterId,
          messageIds: [laterId],
          content: [{ type: "text", text: "later" }],
        })
      )._unsafeUnwrap();
      await modelEntered.promise;
      expect(
        (
          await agent.request("historical-abort", {
            type: "abort",
            operationId: `inbox:${batchId}`,
          })
        )._unsafeUnwrap(),
      ).toMatchObject({ type: "rejected", error: { code: "stale_operation" } });
      expect(
        (
          await agent.request("delivered-historical-abort", {
            type: "abort",
            operationId: `inbox:${completedId}`,
          })
        )._unsafeUnwrap(),
      ).toMatchObject({ type: "rejected", error: { code: "stale_operation" } });
      expect(interrupted).toBe(false);
      expect(
        (
          await agent.request("current-abort", { type: "abort", operationId: `inbox:${laterId}` })
        )._unsafeUnwrap(),
      ).toMatchObject({ type: "accepted" });
      await agent.waitForIdle();
      expect(interrupted).toBe(true);
    } finally {
      releaseCommit.resolve();
      releaseModel.resolve();
      await agent?.close();
      await delivery;
      await database.close();
      if (admin) {
        (await admin.query(`DROP SCHEMA ${schema} CASCADE`))._unsafeUnwrap();
        (await admin.end())._unsafeUnwrap();
      }
    }
  },
);
