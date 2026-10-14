import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineDoc, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { NoSimulationTask } from "determined";
import { expect, it } from "vitest";
import { makeOrbRow, makeProjectRow } from "../../testkit/fixtures.ts";
import { composeControlPlaneDatabase } from "../database.ts";
import { PgDurableAuthority } from "../durable-pg/index.ts";
import { PgClient, type PostgreSQLClient } from "../pg/client.ts";
import { PGliteClient } from "../pg/pglite-client.ts";
import { DurableAgent } from "./agent.ts";
import { projectNativeCommit } from "./atomic-history.ts";

it.for(["pglite", "postgres"] as const)(
  "%s atomically hides reserved native input through placement, replay, reopen and pull without flagging the user; root alerts still flag",
  async (kind, { skip }) => {
    const schema = `notification_private_${randomUUID().replaceAll("-", "")}`;
    let admin: PgClient | undefined;
    let db: PostgreSQLClient;
    if (kind === "pglite") db = new PGliteClient();
    else {
      const connection = process.env.PI_ORB_DURABLE_PG_TEST_URL;
      if (!connection) return skip("needs PI_ORB_DURABLE_PG_TEST_URL");
      admin = new PgClient(connection);
      (await admin.query(`CREATE SCHEMA ${schema}`))._unsafeUnwrap();
      const url = new URL(connection);
      url.searchParams.set("options", `-c search_path=${schema}`);
      db = new PgClient(url.toString());
    }
    const database = composeControlPlaneDatabase(db);
    const task = new NoSimulationTask("private-notification", false);
    const project = makeProjectRow(randomUUID());
    const orb = makeOrbRow(randomUUID(), project.id, "running");
    const secret = "PRIVATE notification atomic 46ab8";
    const authority = new PgDurableAuthority(db, () => 0);
    const models = createModels(),
      faux = fauxProvider();
    let generations = 0;
    const requests: string[] = [];
    faux.setResponses([
      (request) => {
        generations++;
        requests.push(JSON.stringify(request.messages));
        return fauxAssistantMessage("public reply");
      },
    ]);
    models.setProvider(faux.provider);
    let harness: Harness | undefined, agent: DurableAgent | undefined;
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
      const owner = (await authority.acquire(orb.id, "notify", 0, 0, 100))._unsafeUnwrap();
      const openStorage = async () =>
        (
          await authority.open(owner, {
            project: (query, writes) => projectNativeCommit(query, orb.id, writes),
          })
        )._unsafeUnwrap();
      harness = await Harness.open(
        await openStorage(),
        { models, registry: createRegistry() },
        context,
      );
      let root = await harness.root(context, {
        agent: { model: { provider: "faux", modelId: "faux-1" } },
      });
      const identity = defineDoc({
        kind: "orb.identity",
        version: 1,
        scope: "conversation",
        history: "latest",
        fork: "initial",
        initial: () => ({ sessionId: "native", timestamp: 0, receipts: {} }),
      });
      await root.commit(async (tx) => {
        await tx.doc(identity, root.id);
        await tx.appendEntry(root.id, {
          kind: "pi.message",
          model: [{ role: "user", content: "public preceding", timestamp: 0 }],
        });
      }, context);
      const before = (await database.store.getOrb(task, orb.id))._unsafeUnwrap();
      const draft = {
        type: "input" as const,
        content: secret,
        requestId: "subagent-notify:42:outer:nested:0",
        whenBusy: "steer" as const,
      };
      const first = await root.submit(draft, context);
      await first.wait(context);
      const replay = await root.submit(draft, context);
      expect(replay.id).toBe(first.id);
      await root.waitForIdle(context);
      expect(generations).toBe(1);
      expect(requests[0]).toContain(secret);
      const records = (
        await db.query("SELECT record FROM history_records WHERE orb_id=$1 ORDER BY record_id", [
          orb.id,
        ])
      )._unsafeUnwrap();
      expect(JSON.stringify(records.rows)).not.toContain(secret);
      const row = (await database.store.getOrb(task, orb.id))._unsafeUnwrap();
      expect(row?.unreadAlertId).toBeNull();
      expect(row?.replicationCursor).not.toBe(before?.replicationCursor);
      await harness.close(context);
      harness = await Harness.open(
        await openStorage(),
        { models, registry: createRegistry() },
        context,
      );
      root = await harness.root(context);
      const retained = await root.submit(draft, context);
      expect(retained.id).toBe(first.id);
      expect(generations).toBe(1);
      await harness.close(context);
      harness = undefined;
      agent = (
        await DurableAgent.open({
          orbId: orb.id,
          storage: await openStorage(),
          models,
          registry: createRegistry(),
          env: new NodeExecutionEnv({ cwd: "/tmp" }),
          instructions: "",
          checkoutCommit: null,
          resume: false,
          initialSettings: { model: { provider: "faux", id: "faux-1" }, thinkingLevel: "off" },
        })
      )._unsafeUnwrap();
      const snapshot = agent.snapshot()._unsafeUnwrap();
      expect(JSON.stringify(snapshot)).not.toContain(secret);
      expect(JSON.stringify((await agent.pullHistory(null, 500))._unsafeUnwrap())).not.toContain(
        secret,
      );
      expect(snapshot.headId).toBe(
        (await database.store.getOrb(task, orb.id))._unsafeUnwrap()?.replicatedHeadId,
      );
      await agent.close();
      agent = (
        await DurableAgent.open({
          orbId: orb.id,
          storage: await openStorage(),
          models,
          registry: createRegistry(),
          env: new NodeExecutionEnv({ cwd: "/tmp" }),
          instructions: "",
          checkoutCommit: null,
          initialSettings: { model: { provider: "faux", id: "faux-1" }, thinkingLevel: "off" },
        })
      )._unsafeUnwrap();
      const alert = (await agent.appendAlert("root-alert", "root needs attention"))._unsafeUnwrap();
      const flagged = (await database.store.getOrb(task, orb.id))._unsafeUnwrap();
      expect(flagged?.unreadAlertId).toBe(alert.recordId);
      expect(JSON.stringify(agent.snapshot()._unsafeUnwrap())).toContain("root needs attention");
      expect(
        JSON.stringify(
          (
            await db.query("SELECT record FROM history_records WHERE orb_id=$1", [orb.id])
          )._unsafeUnwrap().rows,
        ),
      ).not.toContain(secret);
    } finally {
      if (agent) await agent.close();
      if (harness) await harness.close(context);
      await database.close();
      if (admin) {
        (await admin.query(`DROP SCHEMA ${schema} CASCADE`))._unsafeUnwrap();
        (await admin.end())._unsafeUnwrap();
      }
    }
  },
);
