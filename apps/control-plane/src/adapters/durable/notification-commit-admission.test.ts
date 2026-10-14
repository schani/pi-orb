import { randomUUID } from "node:crypto";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, type Storage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { NoSimulationTask } from "determined";
import { err, ok, okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { makeOrbRow, makeProjectRow } from "../../testkit/fixtures.ts";
import { composeControlPlaneDatabase } from "../database.ts";
import { PgDurableAuthority } from "../durable-pg/index.ts";
import { PgClient, type PostgreSQLClient } from "../pg/client.ts";
import { PGliteClient } from "../pg/pglite-client.ts";
import { DurableAgent } from "./agent.ts";
import { projectNativeCommit } from "./atomic-history.ts";
import { durableError } from "./manager.ts";
import { createDurableTools } from "./tools/index.ts";
import { createOrbTools } from "./tools/orb-tools.ts";

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
    const schema = `notification_admission_${randomUUID().replaceAll("-", "")}`;
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
    const task = new NoSimulationTask("notification-commit-admission", false);
    const project = makeProjectRow(randomUUID()),
      orb = makeOrbRow(randomUUID(), project.id, "running");
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
              code: 'text(await tools.orb_alert({message:"PRIVATE race report"}));',
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
      await database.close();
      if (admin) {
        (await admin.query(`DROP SCHEMA ${schema} CASCADE`))._unsafeUnwrap();
        (await admin.end())._unsafeUnwrap();
      }
    }
  },
);
