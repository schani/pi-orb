import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  defineTool,
  type Storage,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { NoSimulationTask } from "determined";
import { expect, it } from "vitest";
import { makeOrbRow, makeProjectRow } from "../../testkit/fixtures.ts";
import { runDst } from "../../testkit/sim.ts";
import { composeControlPlaneDatabase } from "../database.ts";
import { DurableAgent } from "../durable/agent.ts";
import { durableError } from "../durable/manager.ts";
import { fenceModels } from "../durable/model-fence.ts";
import { createDurableTools } from "../durable/tools/index.ts";
import { PgClient, type PostgreSQLClient } from "../pg/client.ts";
import { PGliteClient } from "../pg/pglite-client.ts";

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each([
  { kind: "pglite", admittedAbort: true },
  { kind: "postgres", admittedAbort: true },
  { kind: "pglite", admittedAbort: false },
  { kind: "postgres", admittedAbort: false },
] as const)(
  "$kind live native root/child Stop drain (admittedAbort=$admittedAbort) and new owner Start",
  async ({ kind, admittedAbort: abortBeforeStop }) => {
    const schema = `composed_drain_${randomUUID().replaceAll("-", "")}`;
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
    const task = new NoSimulationTask("pg-composed-drain", false);
    const project = makeProjectRow(randomUUID());
    const orb = makeOrbRow(randomUUID(), project.id, "running");
    const context = { signal: new AbortController().signal };
    const rootEntered = barrier(),
      childEntered = barrier(),
      commitEntered = barrier(),
      commitRelease = barrier(),
      drainEntered = barrier();
    const rootAborted = barrier(),
      childAborted = barrier();
    let holdCommit = false;
    let dispatches = 0;
    let resourcesClosed = 0;
    let agent: DurableAgent | undefined;
    let replacement: DurableAgent | undefined;
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
      const lease = (await database.agentPersistence.open(task, orb, context))._unsafeUnwrap();
      const storage = new Proxy(lease.storage, {
        get(target, key) {
          if (key === "commit")
            return async (...args: Parameters<Storage["commit"]>) => {
              if (holdCommit) {
                holdCommit = false;
                commitEntered.resolve();
                await commitRelease.promise;
              }
              return target.commit(...args);
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Storage;
      const models = createModels();
      const faux = fauxProvider();
      const respond: FauxResponseFactory = async (request, options) => {
        dispatches++;
        const child = JSON.stringify(
          request.messages.find((message) => message.role === "user")?.content,
        ).includes("held-child");
        if (!child && !request.messages.some((message) => message.role === "toolResult"))
          return fauxAssistantMessage(fauxToolCall("subagent", { prompt: "held-child" }), {
            stopReason: "toolUse",
          });
        (child ? childEntered : rootEntered).resolve();
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) resolve();
          else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        (child ? childAborted : rootAborted).resolve();
        return fauxAssistantMessage("", { stopReason: "aborted" });
      };
      faux.setResponses(Array(10).fill(respond));
      models.setProvider(faux.provider);
      let admittedApi: ToolExecutionApi | undefined;
      let effectsStarted = 0;
      const guardedModels = fenceModels(models, lease.check, lease.signal);
      const tools = createDurableTools({
        authorize: (_name, _args, api) => {
          admittedApi = api;
          return lease
            .check()
            .mapErr(() => ({ code: "forbidden" as const, message: "Owner revoked" }));
        },
        additionalTools: [
          defineTool({
            name: "probe_effect",
            description: "Synthetic effect counter",
            parameters: Type.Object({}),
            replay: "safe",
            execute: async () => {
              effectsStarted++;
              return { content: [{ type: "text", text: "effect started" }] };
            },
          }),
        ],
      });
      const registry = createRegistry();
      registry.install(tools.extension);
      agent = (
        await DurableAgent.open({
          orbId: orb.id,
          storage,
          models: guardedModels,
          registry,
          env: new NodeExecutionEnv({ cwd: "/tmp" }),
          checkoutCommit: "commit",
          instructions: "",
          initialSettings: { model: { provider: "faux", id: "faux-1" }, thinkingLevel: "off" },
          checkAdmission: lease.check,
          ownershipSignal: lease.signal,
          beginDrain: () =>
            lease.beginDrain().map(() => {
              drainEntered.resolve();
              return undefined;
            }),
          closeResources: () =>
            tools
              .close()
              .mapErr(() => durableError("tools close failed"))
              .andThen(() => lease.release())
              .map(() => {
                resourcesClosed++;
                return undefined;
              }),
        })
      )._unsafeUnwrap();
      const messageId = randomUUID();
      (
        await database.store.enqueueOrbMessage(task, {
          orbId: orb.id,
          messageId,
          content: [{ type: "text", text: "held-root" }],
          wake: false,
          now: 0,
        })
      )._unsafeUnwrap();
      (
        await database.store.claimNextOrbMessageBatch(task, { orbId: orb.id, now: 0 })
      )._unsafeUnwrap();
      (
        await agent.deliver({
          baseUrl: "unused",
          messageId,
          messageIds: [messageId],
          content: [{ type: "text", text: "held-root" }],
        })
      )._unsafeUnwrap();
      await Promise.all([rootEntered.promise, childEntered.promise]);
      const active = (
        await db.query(
          "SELECT record::jsonb->>'kind' AS kind,status FROM durable_pg_tasks WHERE orb_id=$1 AND status<>'terminal'",
          [orb.id],
        )
      )._unsafeUnwrap().rows;
      expect(active.some((row) => row.kind === "orb.child")).toBe(true);
      expect(active.length).toBeGreaterThan(1);
      expect(
        (
          await db.query("SELECT id FROM durable_pg_conversations WHERE orb_id=$1", [orb.id])
        )._unsafeUnwrap().rows.length,
      ).toBeGreaterThan(1);
      const beforeMutation = (await database.agentPersistence.snapshot(task, orb))._unsafeUnwrap();
      const beforeSeq = (
        await db.query("SELECT next_seq FROM durable_pg_durable_metadata WHERE orb_id=$1", [orb.id])
      )._unsafeUnwrap().rows[0]?.next_seq;
      holdCommit = abortBeforeStop;
      const admittedAbort = abortBeforeStop
        ? agent.request("admitted-abort", { type: "abort", operationId: `inbox:${messageId}` })
        : undefined;
      if (admittedAbort)
        expect(
          await Promise.race([
            commitEntered.promise.then(() => "commit-held"),
            admittedAbort.then((result) => result),
          ]),
        ).toBe("commit-held");
      (
        await db.query("UPDATE orbs SET agent_admission_version=1 WHERE id=$1", [orb.id])
      )._unsafeUnwrap();
      if (abortBeforeStop) {
        expect(
          (
            await db.query("SELECT next_seq FROM durable_pg_durable_metadata WHERE orb_id=$1", [
              orb.id,
            ])
          )._unsafeUnwrap().rows[0]?.next_seq,
        ).toBe(beforeSeq);
        expect(
          (await database.agentPersistence.snapshot(task, orb))._unsafeUnwrap().records,
        ).toEqual(beforeMutation.records);
      }
      const beforeCloseDispatches = dispatches;
      const oldAgent = agent;
      const closing = oldAgent.close();
      await drainEntered.promise;
      await runDst(
        { name: `pg-composed-drain-${kind}-${abortBeforeStop}`, iterations: 1 },
        async (sim) => {
          const scheduled = await sim.runTasks([
            {
              name: "explicit-stop",
              f: async (scheduledTask) => {
                await scheduledTask.checkpoint("before-close");
                await scheduledTask.checkpoint("owned-drain-active");
                expect(oldAgent.accepting()).toBe(false);
              },
            },
            {
              name: "admitted-native-commit",
              f: async (scheduledTask) => {
                await scheduledTask.checkpoint("before-resuming-owned-commit");
                commitRelease.resolve();
              },
            },
          ]);
          expect(scheduled.isErr() ? scheduled.error : null).toBeNull();
        },
      );
      expect(
        (
          await oldAgent.deliver({
            baseUrl: "unused",
            messageId: randomUUID(),
            messageIds: [],
            content: [{ type: "text", text: "stale" }],
          })
        ).isErr(),
      ).toBe(true);
      if (admittedAbort)
        expect((await admittedAbort)._unsafeUnwrap()).toMatchObject({ type: "accepted" });
      expect((await closing).isOk()).toBe(true);
      await Promise.all([rootAborted.promise, childAborted.promise]);
      expect(resourcesClosed).toBe(1);
      expect(lease.signal.aborted).toBe(true);
      expect(dispatches).toBe(beforeCloseDispatches);
      const staleModel = models.getModel("faux", "faux-1");
      if (!staleModel) expect.fail("Synthetic model missing");
      expect((await guardedModels.completeSimple(staleModel, { messages: [] })).stopReason).toBe(
        "error",
      );
      expect(dispatches).toBe(beforeCloseDispatches);
      if (!admittedApi) expect.fail("Native tool API was not captured");
      expect(
        (await tools.catalog.invoke("probe_effect", {}, admittedApi, BACKGROUND_CONTEXT)).isErr(),
      ).toBe(true);
      expect(effectsStarted).toBe(0);
      const stopped = (await database.agentPersistence.snapshot(task, orb))._unsafeUnwrap();
      expect(JSON.stringify(stopped.records)).toContain("held-root");
      const stoppedTasks = (
        await db.query("SELECT record::jsonb AS record FROM durable_pg_tasks WHERE orb_id=$1", [
          orb.id,
        ])
      )._unsafeUnwrap().rows;
      const terminal = stoppedTasks.filter(
        (row) => (row.record as { state: { status: string } }).state.status === "terminal",
      );
      if (abortBeforeStop) {
        expect(terminal).toHaveLength(stoppedTasks.length);
        const aborted = (
          await db.query(
            "SELECT conversation_id FROM durable_pg_tasks WHERE orb_id=$1 AND record::jsonb#>>'{state,outcome,status}'='aborted'",
            [orb.id],
          )
        )._unsafeUnwrap().rows;
        expect(new Set(aborted.map((row) => Number(row.conversation_id))).size).toBeGreaterThan(1);
      } else expect(terminal.length).toBeLessThan(stoppedTasks.length);
      expect(
        stopped.records.some((record) => record.type === "message" && record.role === "tool"),
      ).toBe(true);
      const ownerEvents = (
        await db.query(
          "SELECT outcome FROM durable_pg_owner_events WHERE orb_id=$1 ORDER BY recorded_at",
          [orb.id],
        )
      )._unsafeUnwrap().rows;
      expect(ownerEvents.map((row) => row.outcome)).toEqual(["acquired", "draining", "released"]);
      const nextOrb = { ...orb, agentAdmissionVersion: 1 };
      const nextLease = (
        await database.agentPersistence.open(task, nextOrb, context)
      )._unsafeUnwrap();
      const nextModels = createModels();
      const nextFaux = fauxProvider();
      nextFaux.setResponses(Array(10).fill(fauxAssistantMessage("recovered answer")));
      nextModels.setProvider(nextFaux.provider);
      const nextTools = createDurableTools();
      const nextRegistry = createRegistry();
      nextRegistry.install(nextTools.extension);
      const recoveredTasks = barrier();
      const nextStorage = new Proxy(nextLease.storage, {
        get(target, key) {
          if (key === "commit")
            return async (...args: Parameters<Storage["commit"]>) => {
              const result = await target.commit(...args);
              const pending = (
                await db.query(
                  "SELECT id FROM durable_pg_tasks WHERE orb_id=$1 AND status<>'terminal'",
                  [orb.id],
                )
              )._unsafeUnwrap().rows;
              if (pending.length === 0) recoveredTasks.resolve();
              return result;
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Storage;
      replacement = (
        await DurableAgent.open({
          orbId: orb.id,
          storage: nextStorage,
          models: nextModels,
          registry: nextRegistry,
          env: new NodeExecutionEnv({ cwd: "/tmp" }),
          checkoutCommit: "commit",
          instructions: "",
          checkAdmission: nextLease.check,
          ownershipSignal: nextLease.signal,
          beginDrain: nextLease.beginDrain,
          closeResources: () =>
            nextTools
              .close()
              .mapErr(() => durableError("tools close failed"))
              .andThen(() => nextLease.release()),
        })
      )._unsafeUnwrap();
      expect((await lease.release()).isOk()).toBe(true);
      expect((await nextLease.check()).isOk()).toBe(true);
      const nextMessage = randomUUID();
      (
        await database.store.enqueueOrbMessage(task, {
          orbId: orb.id,
          messageId: nextMessage,
          content: [{ type: "text", text: "new-start" }],
          wake: false,
          now: 1,
        })
      )._unsafeUnwrap();
      (
        await database.store.claimNextOrbMessageBatch(task, { orbId: orb.id, now: 1 })
      )._unsafeUnwrap();
      (
        await replacement.deliver({
          baseUrl: "unused",
          messageId: nextMessage,
          messageIds: [nextMessage],
          content: [{ type: "text", text: "new-start" }],
        })
      )._unsafeUnwrap();
      (await replacement.waitForIdle())._unsafeUnwrap();
      if (!abortBeforeStop) await recoveredTasks.promise;
      const recovered = (await database.agentPersistence.snapshot(task, nextOrb))._unsafeUnwrap();
      expect(JSON.stringify(recovered.records)).toContain("recovered answer");
      expect(
        (
          await db.query(
            "SELECT kind,status FROM durable_pg_tasks WHERE orb_id=$1 AND status<>'terminal'",
            [orb.id],
          )
        )._unsafeUnwrap().rows,
      ).toEqual([]);
      const current = (await database.store.getOrb(task, orb.id))._unsafeUnwrap();
      if (!current) expect.fail("Orb missing before archive");
      const archiving = (
        await database.store.requestOrbArchive(task, {
          orbId: orb.id,
          expectedStateVersion: current.stateVersion,
          now: task.wallNow(),
          cleanupAfter: task.wallNow(),
        })
      )._unsafeUnwrap();
      (await replacement.close())._unsafeUnwrap();
      const sealHead = (await database.store.getOrb(task, orb.id))._unsafeUnwrap();
      if (!sealHead) expect.fail("Orb missing before seal");
      (
        await database.store.sealOrbArchive(task, {
          orbId: orb.id,
          expectedStateVersion: archiving.stateVersion,
          now: task.wallNow(),
          cursor: sealHead.replicationCursor,
          headId: sealHead.replicatedHeadId,
        })
      )._unsafeUnwrap();
      for (const table of [
        "durable_metadata",
        "entries",
        "tasks",
        "submissions",
        "documents",
        "document_revisions",
        "conversations",
      ])
        expect(
          (
            await db.query(`SELECT * FROM durable_pg_${table} WHERE orb_id=$1`, [orb.id])
          )._unsafeUnwrap().rows,
        ).toEqual([]);
      const sealed = (await database.agentPersistence.snapshot(task, archiving))._unsafeUnwrap();
      expect(sealed.records).toEqual(recovered.records);
      expect((await database.agentPersistence.open(task, archiving, context)).isErr()).toBe(true);
    } finally {
      commitRelease.resolve();
      await replacement?.close();
      await agent?.close();
      await database.close();
      if (admin) {
        (await admin.query(`DROP SCHEMA ${schema} CASCADE`))._unsafeUnwrap();
        (await admin.end())._unsafeUnwrap();
      }
    }
  },
);
