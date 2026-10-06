import { randomUUID } from "node:crypto";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { ServerFrame } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { describe, expect, it } from "vitest";
import { makeOrbRow, makeProjectRow } from "../../testkit/fixtures.ts";
import { composeControlPlaneDatabase } from "../database.ts";
import { PgDurableAuthority } from "../durable-pg/index.ts";
import { PGliteClient } from "../pg/pglite-client.ts";
import { DurableAgent } from "./agent.ts";
import { projectNativeCommit } from "./atomic-history.ts";

describe("browser input projection into PostgreSQL", () => {
  it("keeps browser deduplication separate from UUID inbox acknowledgements", async () => {
    const db = new PGliteClient();
    const database = composeControlPlaneDatabase(db);
    const task = new NoSimulationTask("browser-inbox-projection", false);
    const project = makeProjectRow(randomUUID());
    const orb = makeOrbRow(randomUUID(), project.id, "running");
    const authority = new PgDurableAuthority(db, () => 0);
    const models = createModels();
    const faux = fauxProvider();
    let generations = 0;
    faux.setResponses([
      () => {
        generations++;
        return fauxAssistantMessage("browser final");
      },
      () => {
        generations++;
        return fauxAssistantMessage("inbox final");
      },
    ]);
    models.setProvider(faux.provider);
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
    const owner = (await authority.acquire(orb.id, "browser-test", 0, 0, 100))._unsafeUnwrap();
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
    let agent = await open();
    const frames: ServerFrame[] = [];
    agent.subscribe((frame) => frames.push(frame));
    const requestId = randomUUID();
    const action = {
      type: "message" as const,
      expectedHeadId: agent.snapshot()._unsafeUnwrap().headId,
      content: [{ type: "text" as const, text: "browser question" }],
    };
    try {
      const accepted = (await agent.request(requestId, action))._unsafeUnwrap();
      expect(accepted).toMatchObject({ type: "accepted", duplicate: false });
      const idle = await agent.waitForIdle();
      if (idle.isErr()) {
        await agent.close();
        agent = await open();
        console.error(
          "native authority after projection failure",
          JSON.stringify(agent.snapshot()._unsafeUnwrap().records),
        );
      }
      expect(idle.isOk(), idle.isErr() ? idle.error.message : "").toBe(true);
      expect(agent.health().status).toBe("ready");
      expect(frames.filter((frame) => frame.type === "server.error")).toEqual([]);
      const records = agent.snapshot()._unsafeUnwrap().records;
      const user = records.find((record) => record.type === "message" && record.role === "user");
      expect(user).toMatchObject({ inboxMessageIds: [] });
      expect(JSON.stringify(records)).toContain("browser final");
      expect((await database.store.getOrb(task, orb.id))._unsafeUnwrap()?.replicationCursor).toBe(
        records.at(-1)?.id,
      );
      await agent.close();
      agent = await open();
      expect((await agent.request(requestId, action))._unsafeUnwrap()).toMatchObject({
        type: "accepted",
        duplicate: true,
      });
      (await agent.waitForIdle())._unsafeUnwrap();
      expect(generations).toBe(1);
      const messageId = randomUUID();
      const content = [{ type: "text" as const, text: "inbox question" }];
      (
        await database.store.enqueueOrbMessage(task, { orbId: orb.id, messageId, content, now: 1 })
      )._unsafeUnwrap();
      (
        await database.store.claimNextOrbMessageBatch(task, { orbId: orb.id, now: 1 })
      )._unsafeUnwrap();
      (
        await agent.deliver({ baseUrl: "central", messageId, messageIds: [messageId], content })
      )._unsafeUnwrap();
      (await agent.waitForIdle())._unsafeUnwrap();
      expect(agent.health().status).toBe("ready");
      expect(
        (await database.store.listOrbMessages(task, orb.id))
          ._unsafeUnwrap()
          .find((message) => message.messageId === messageId)?.status,
      ).toBe("delivered");
      expect(JSON.stringify(agent.snapshot()._unsafeUnwrap().records)).toContain("inbox final");
      expect(generations).toBe(2);
    } finally {
      await agent.close();
      await authority.release(owner);
      await database.close();
    }
  });
});
