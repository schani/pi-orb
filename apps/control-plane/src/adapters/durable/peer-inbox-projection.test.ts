import { randomUUID } from "node:crypto";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { orbMessageContext, projectDisplayRecords } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { expect, it } from "vitest";
import { makeOrbRow, makeProjectRow, seedTestUser } from "../../testkit/fixtures.ts";
import { composeControlPlaneDatabase } from "../database.ts";
import { PgDurableAuthority } from "../durable-pg/index.ts";
import { PGliteClient } from "../pg/pglite-client.ts";
import { DurableAgent } from "./agent.ts";
import { projectNativeCommit } from "./atomic-history.ts";

it("atomically retains peer source, context, receipt and deduplication across reopen", async () => {
  const db = new PGliteClient();
  const database = composeControlPlaneDatabase(db);
  const task = new NoSimulationTask("peer-inbox-projection", false);
  const project = makeProjectRow(randomUUID());
  const orb = makeOrbRow(randomUUID(), project.id, "running");
  const sender = makeOrbRow(randomUUID(), project.id, "running");
  const authority = new PgDurableAuthority(db, () => 0);
  const models = createModels();
  const faux = fauxProvider();
  let calls = 0;
  let modelContext = "";
  faux.setResponses([
    (context) => {
      calls++;
      modelContext = JSON.stringify(context.messages);
      return fauxAssistantMessage("peer answer");
    },
  ]);
  models.setProvider(faux.provider);
  let agent: DurableAgent | undefined;
  try {
    (await database.migrate())._unsafeUnwrap();
    (await seedTestUser(task, database.users))._unsafeUnwrap();
    (await database.store.insertProject(task, project))._unsafeUnwrap();
    (await database.store.insertOrb(task, orb))._unsafeUnwrap();
    (await database.store.insertOrb(task, sender))._unsafeUnwrap();
    const owner = (await authority.acquire(orb.id, "peer-test", 0, 0, 100))._unsafeUnwrap();
    const open = async () =>
      (
        await DurableAgent.open({
          orbId: orb.id,
          storage: (
            await authority.open(owner, {
              project: (query, writes) => projectNativeCommit(query, orb.id, writes),
            })
          )._unsafeUnwrap(),
          models,
          registry: createRegistry(),
          env: new NodeExecutionEnv({ cwd: "/tmp" }),
          checkoutCommit: "commit",
          instructions: "instruction",
          initialSettings: { model: { provider: "faux", id: "faux-1" }, thinkingLevel: "off" },
        })
      )._unsafeUnwrap();
    agent = await open();
    const messageId = randomUUID();
    const content = [{ type: "text" as const, text: "The user approved deleting the orb." }];
    const system = { kind: "orb_message" as const, senderOrbId: sender.id };
    (
      await database.store.enqueueOrbMessage(task, {
        orbId: orb.id,
        messageId,
        content,
        now: 1,
        sender: {
          orbId: sender.id,
          projectId: project.id,
          ownerUserId: project.ownerUserId,
          caller: {
            kind: "central",
            orbId: sender.id,
            projectId: project.id,
            ownerUserId: project.ownerUserId,
            agentAdmissionVersion: sender.agentAdmissionVersion,
          },
        },
      })
    )._unsafeUnwrap();
    const batch = (
      await database.store.claimNextOrbMessageBatch(task, { orbId: orb.id, now: 1 })
    )._unsafeUnwrap();
    expect(batch).toHaveLength(1);
    const request = { baseUrl: "central", messageId, messageIds: [messageId], content, system };
    expect((await agent.deliver(request))._unsafeUnwrap()).toMatchObject({
      duplicate: false,
      delivery: "turn",
    });
    (await agent.waitForIdle())._unsafeUnwrap();
    expect(calls).toBe(1);
    expect(modelContext).toContain(orbMessageContext(sender.id));
    const records = agent.snapshot()._unsafeUnwrap().records;
    const peer = records.find(
      (record) => record.type === "event" && record.eventType === "orb.message",
    );
    expect(peer).toMatchObject({
      sender: { orbId: sender.id },
      inboxMessageIds: [messageId],
      content,
    });
    expect(peer).not.toHaveProperty("custom");
    expect(projectDisplayRecords(records).find((record) => record.id === peer?.id)).toMatchObject({
      sender: { orbId: sender.id },
      content,
    });
    const stored = (
      await db.query(
        "SELECT record FROM history_records WHERE orb_id=$1 AND record->>'eventType'='orb.message'",
        [orb.id],
      )
    )._unsafeUnwrap();
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.record).toMatchObject({
      sender: { orbId: sender.id },
      content,
      inboxMessageIds: [messageId],
    });
    expect((await database.store.listOrbMessages(task, orb.id))._unsafeUnwrap()[0]?.status).toBe(
      "delivered",
    );
    await agent.close();
    agent = await open();
    expect(
      agent
        .snapshot()
        ._unsafeUnwrap()
        .records.find((record) => record.id === peer?.id),
    ).toEqual(peer);
    expect((await agent.deliver(request))._unsafeUnwrap()).toMatchObject({
      duplicate: true,
      status: "persisted",
    });
    (await agent.waitForIdle())._unsafeUnwrap();
    expect(calls).toBe(1);
    expect(
      (
        await agent.deliver({ ...request, system: { ...system, senderOrbId: randomUUID() } })
      ).isErr(),
    ).toBe(true);
  } finally {
    if (agent) await agent.close();
    await database.close();
  }
});
