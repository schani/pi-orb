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

it.each(["payload", "batch", "missing"] as const)(
  "rejects captured input when %s changes before native admission, without inference/public admission",
  async (change) => {
    const db = new PGliteClient(),
      database = composeControlPlaneDatabase(db);
    const task = new NoSimulationTask("native-payload-fence", false);
    const project = makeProjectRow(randomUUID()),
      orb = makeOrbRow(randomUUID(), project.id, "running"),
      messageId = randomUUID();
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
      }),
      reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
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
      (
        await database.store.enqueueOrbMessage(task, {
          orbId: orb.id,
          messageId,
          content: [{ type: "text", text: "captured" }],
          wake: false,
          now: 0,
        })
      )._unsafeUnwrap();
      (
        await database.store.claimNextOrbMessageBatch(task, { orbId: orb.id, now: 0 })
      )._unsafeUnwrap();
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
                    write.type === "submission" && write.value.requestId === `inbox:${messageId}`,
                )
              ) {
                entered();
                await held;
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
          return fauxAssistantMessage("must not infer");
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
      const before = agent.snapshot()._unsafeUnwrap().records;
      delivery = agent.deliver({
        baseUrl: "unused",
        messageId,
        messageIds: [messageId],
        content: [{ type: "text", text: "captured" }],
      });
      expect(
        await Promise.race([reached.then(() => "held"), delivery.then((result) => result)]),
      ).toBe("held");
      if (change === "payload")
        (
          await db.query(
            'UPDATE orb_messages SET content=\'[{"type":"text","text":"edited"}]\' WHERE orb_id=$1 AND message_id=$2',
            [orb.id, messageId],
          )
        )._unsafeUnwrap();
      else if (change === "batch")
        (
          await db.query(
            "UPDATE orb_messages SET delivery_batch_id=$3 WHERE orb_id=$1 AND message_id=$2",
            [orb.id, messageId, randomUUID()],
          )
        )._unsafeUnwrap();
      else
        (
          await db.query("DELETE FROM orb_messages WHERE orb_id=$1 AND message_id=$2", [
            orb.id,
            messageId,
          ])
        )._unsafeUnwrap();
      release();
      expect((await delivery).isErr()).toBe(true);
      expect(calls).toBe(0);
      expect(
        (
          await db.query("SELECT count(*) AS n FROM durable_pg_submissions WHERE orb_id=$1", [
            orb.id,
          ])
        )._unsafeUnwrap().rows[0]?.n,
      ).toBe(0);
      expect((await database.agentPersistence.snapshot(task, orb))._unsafeUnwrap().records).toEqual(
        before,
      );
    } finally {
      release();
      await delivery;
      await agent?.close();
      await database.close();
    }
  },
);
