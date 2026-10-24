import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineDoc, Harness, type Storage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { NoSimulationTask } from "determined";
import { err, ok, okAsync } from "neverthrow";
import { expect, it, onTestFinished } from "vitest";
import { makeOrbRow, makeProjectRow, seedTestUser } from "../../testkit/fixtures.ts";
import { composeControlPlaneDatabase } from "../database.ts";
import { PgDurableAuthority } from "../durable-pg/index.ts";
import { PgClient } from "../pg/client.ts";
import { PGliteClient } from "../pg/pglite-client.ts";
import { DurableAgent } from "./agent.ts";
import { projectNativeCommit } from "./atomic-history.ts";
import { durableError } from "./manager.ts";
import { createDurableTools } from "./tools/index.ts";
import { createOrbTools } from "./tools/orb-tools.ts";

/** Own one isolated notification database, including failed initialization. */
async function openNotificationDatabase(kind: "pglite" | "postgres") {
  const connection = process.env.PI_ORB_DURABLE_PG_TEST_URL;
  if (kind === "postgres" && !connection) return undefined;
  const schema = `notification_${randomUUID().replaceAll("-", "")}`;
  const url = kind === "postgres" ? new URL(connection ?? "") : undefined;
  url?.searchParams.set("options", `-c search_path=${schema}`);
  const admin = url ? new PgClient(connection ?? "") : undefined;
  const db = url ? new PgClient(url.toString()) : new PGliteClient();
  const database = composeControlPlaneDatabase(db);
  const task = new NoSimulationTask("notification", false);
  const project = makeProjectRow(randomUUID());
  const orb = makeOrbRow(randomUUID(), project.id, "running");
  const close = async () => {
    try {
      await database.close();
    } finally {
      if (admin) {
        try {
          (await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`))._unsafeUnwrap();
        } finally {
          (await admin.end())._unsafeUnwrap();
        }
      }
    }
  };
  try {
    if (admin) (await admin.query(`CREATE SCHEMA ${schema}`))._unsafeUnwrap();
    (await database.migrate())._unsafeUnwrap();
    (await seedTestUser(task, database.users))._unsafeUnwrap();
    (await database.store.insertProject(task, project))._unsafeUnwrap();
    (await database.store.insertOrb(task, orb))._unsafeUnwrap();
    onTestFinished(close);
    return { db, database, task, orb };
  } catch (error) {
    const [cleanup] = await Promise.allSettled([close()]);
    if (cleanup?.status === "rejected")
      console.error("Notification DB cleanup failed", cleanup.reason);
    throw error;
  }
}

it.for(["pglite", "postgres"] as const)(
  "%s atomically projects typed native notifications through placement, replay, reopen and pull without flagging the user",
  async (kind, { skip }) => {
    const fixture = await openNotificationDatabase(kind);
    if (!fixture) return skip("needs PI_ORB_DURABLE_PG_TEST_URL");
    const { db, database, task, orb } = fixture;
    const secret = "literal notification atomic 46ab8";
    const payload = JSON.stringify({ agent_id: "7", description: "Check", message: secret });
    const notice = {
      type: "event",
      eventType: "pi.custom_message",
      overflow: {},
      custom: { customType: "subagent-notification", display: true },
      subagent: { kind: "notification", id: "7", description: "Check", message: secret },
    };
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
        checkpointWhen: () => false,
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
        content: payload,
        requestId: "subagent-notify:42:outer:nested:0",
        whenBusy: "steer" as const,
      };
      const first = await root.submit(draft, context);
      await first.wait(context);
      const replay = await root.submit(draft, context);
      expect(replay.id).toBe(first.id);
      await root.waitForIdle(context);
      expect(generations).toBe(1);
      expect(requests[0]).toContain(JSON.stringify(payload).slice(1, -1));
      const records = (
        await db.query("SELECT record FROM history_records WHERE orb_id=$1 ORDER BY record_id", [
          orb.id,
        ])
      )._unsafeUnwrap();
      expect(records.rows.map((row) => row["record"])).toEqual(
        expect.arrayContaining([expect.objectContaining(notice)]),
      );
      expect(JSON.stringify(records.rows)).not.toContain("agent_id");
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
      expect(snapshot.records).toEqual(expect.arrayContaining([expect.objectContaining(notice)]));
      expect((await agent.pullHistory(null, 500))._unsafeUnwrap().records).toEqual(
        expect.arrayContaining([expect.objectContaining(notice)]),
      );
      expect(
        snapshot.records.filter(
          (record) => record.type === "event" && record.subagent?.message === secret,
        ),
      ).toHaveLength(1);
      expect(snapshot.headId).toBe(
        (await database.store.getOrb(task, orb.id))._unsafeUnwrap()?.replicatedHeadId,
      );
    } finally {
      if (agent) await agent.close();
      if (harness) await harness.close(context);
    }
  },
);

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.for([
  { kind: "pglite", reason: "manual" },
  { kind: "postgres", reason: "manual" },
  { kind: "pglite", reason: "sleep" },
  { kind: "postgres", reason: "sleep" },
  { kind: "pglite", reason: "superseded" },
  { kind: "postgres", reason: "superseded" },
] as const)(
  "$kind rejects a real child notification if $reason wins after final application admission but before native owned-drain commit",
  async ({ kind, reason }, { skip }) => {
    const fixture = await openNotificationDatabase(kind);
    if (!fixture) return skip("needs PI_ORB_DURABLE_PG_TEST_URL");
    const { db, database, task, orb } = fixture;
    const entered = barrier(),
      release = barrier(),
      notificationSettled = barrier();
    const models = createModels(),
      faux = fauxProvider();
    const outcomes: unknown[] = [];
    let agent!: DurableAgent;
    let intercepted = false,
      parentNotificationRequests = 0;
    const bundle = createDurableTools({
      additionalTools: createOrbTools(
        { invoke: () => okAsync({ accepted: true }) },
        (message, api, ctx) =>
          agent
            .notifyParent(message, api, ctx)
            .map((result) => {
              outcomes.push(result);
              notificationSettled.resolve();
              return result;
            })
            .mapErr((error) => {
              outcomes.push(error);
              notificationSettled.resolve();
              return error;
            }),
      ),
    });
    const respond: FauxResponseFactory = async (request) => {
      const user = request.messages.find((message) => message.role === "user");
      const child = JSON.stringify(user?.content).includes("child-work");
      const results = request.messages.filter((message) => message.role === "toolResult");
      if (child) {
        if (results.length === 0)
          return fauxAssistantMessage(
            fauxToolCall("codemode", {
              code: 'text(await tools.notify_parent({message:"PRIVATE race report"}));',
            }),
            { stopReason: "toolUse" },
          );
        return fauxAssistantMessage("child done");
      }
      if (
        request.messages.some(
          (message) =>
            message.role === "user" &&
            JSON.stringify(message.content).includes("PRIVATE race report"),
        )
      ) {
        parentNotificationRequests++;
        return fauxAssistantMessage("processed");
      }
      if (results.length === 0)
        return fauxAssistantMessage(
          fauxToolCall("codemode", { code: 'text(await tools.subagent({prompt:"child-work"}));' }),
          { stopReason: "toolUse" },
        );
      return fauxAssistantMessage("parent done");
    };
    faux.setResponses(Array(12).fill(respond));
    models.setProvider(faux.provider);
    try {
      const authority = new PgDurableAuthority(db, () => 0);
      const owner = (await authority.acquire(orb.id, "notify-race", 0, 0, 1000))._unsafeUnwrap();
      const underlying = (
        await authority.open(owner, {
          project: (query, writes) => projectNativeCommit(query, orb.id, writes),
        })
      )._unsafeUnwrap();
      const storage = new Proxy(underlying, {
        get(target, key) {
          if (key === "commit")
            return async (...args: Parameters<Storage["commit"]>) => {
              if (
                !intercepted &&
                args[0].some(
                  (write) =>
                    write.type === "submission" &&
                    write.value.requestId?.startsWith("subagent-notify:"),
                )
              ) {
                intercepted = true;
                entered.resolve();
                await release.promise;
              }
              return target.commit(...args);
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const registry = createRegistry();
      registry.install(bundle.extension);
      registry.install(bundle.childExtension);
      agent = (
        await DurableAgent.open({
          orbId: orb.id,
          storage,
          models,
          registry,
          env: new NodeExecutionEnv({ cwd: "/tmp" }),
          instructions: "",
          checkoutCommit: null,
          modelTools: bundle.modelTools,
          childExtension: bundle.childExtension,
          initialSettings: { model: { provider: "faux", id: "faux-1" }, thinkingLevel: "off" },
          checkAdmission: () =>
            database.store
              .getOrb(task, orb.id)
              .mapErr(() => durableError("store"))
              .andThen((row) =>
                row?.agentAdmissionVersion === 0 &&
                row.stopReason !== "manual" &&
                row.stopReason !== "sleep"
                  ? ok(undefined)
                  : err(durableError("admission changed")),
              ),
        })
      )._unsafeUnwrap();
      (
        await agent.deliver({
          baseUrl: "central",
          messageId: "launch",
          messageIds: [],
          content: [{ type: "text", text: "launch" }],
        })
      )._unsafeUnwrap();
      await entered.promise;
      // Deliberately leave cleanup writes enabled while revoking new input.
      (
        await db.query("UPDATE orbs SET agent_admission_version=$3,stop_reason=$2 WHERE id=$1", [
          orb.id,
          reason === "superseded" ? null : reason,
          reason === "superseded" ? 1 : 0,
        ])
      )._unsafeUnwrap();
      (await authority.beginDrain(owner, underlying))._unsafeUnwrap();
      release.resolve();
      await notificationSettled.promise;
      expect(outcomes).toEqual([
        { code: "unavailable", message: "Notification admission unavailable" },
      ]);
      const submissions = (
        await db.query(
          "SELECT request_id FROM durable_pg_submissions WHERE orb_id=$1 AND request_id LIKE 'subagent-notify:%'",
          [orb.id],
        )
      )._unsafeUnwrap();
      expect(submissions.rows).toEqual([]);
      expect(parentNotificationRequests).toBe(0);
      const records = (
        await db.query("SELECT record FROM history_records WHERE orb_id=$1", [orb.id])
      )._unsafeUnwrap();
      expect(JSON.stringify(records.rows)).not.toContain("PRIVATE race report");
    } finally {
      release.resolve();
      if (agent) await agent.close();
      await bundle.close();
    }
  },
);
