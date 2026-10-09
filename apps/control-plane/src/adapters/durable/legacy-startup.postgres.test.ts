import { randomUUID } from "node:crypto";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { NoSimulationTask } from "determined";
import { expect, it } from "vitest";
import { makeOrbRow, makeProjectRow } from "../../testkit/fixtures.ts";
import { composeControlPlaneDatabase } from "../database.ts";
import { PgDurableAuthority } from "../durable-pg/index.ts";
import { PgClient, type PostgreSQLClient } from "../pg/client.ts";
import { DurableAgent } from "./agent.ts";
import { projectNativeCommit } from "./atomic-history.ts";
import { checkNativeStartup, legacyBackendMessage } from "./startup.ts";

const connection = process.env.PI_ORB_DURABLE_PG_TEST_URL;
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it
  .skipIf(!connection)
  .each(["publication-first", "acquire-first", "archive-first", "replacement-first"] as const)(
  "real PostgreSQL startup fences %s with independent connections",
  async (order) => {
    const admin = new PgClient(connection!);
    const schema = `legacy_start_${randomUUID().replaceAll("-", "")}`;
    (await admin.query(`CREATE SCHEMA ${schema}`))._unsafeUnwrap();
    const url = new URL(connection!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const db = new PgClient(url.toString());
    const publisher = new PgClient(url.toString());
    const waiting = barrier();
    let observeLock = false;
    const measured = new Proxy(db, {
      get(target, key) {
        if (key === "transaction")
          return (...args: Parameters<PostgreSQLClient["transaction"]>) =>
            target.transaction((query, execute) =>
              args[0]((sql, values) => {
                if (observeLock && sql.includes("FROM orbs") && sql.includes("FOR UPDATE"))
                  waiting.resolve();
                return query(sql, values);
              }, execute),
            );
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as PostgreSQLClient;
    const database = composeControlPlaneDatabase(measured);
    const other = composeControlPlaneDatabase(publisher);
    const task = new NoSimulationTask("legacy-pg-race", false);
    const project = makeProjectRow(randomUUID());
    const orb = makeOrbRow(randomUUID(), project.id, "running");
    const operation = { signal: new AbortController().signal };
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
      const snapshot = async () => {
        const state: unknown[] = [];
        for (const table of [
          "orbs",
          "history_records",
          "durable_pg_durable_metadata",
          "durable_pg_conversations",
          "durable_pg_documents",
          "durable_pg_entries",
        ])
          state.push(
            (
              await publisher.query(
                `SELECT * FROM ${table} WHERE ${table === "orbs" ? "id" : "orb_id"}=$1`,
                [orb.id],
              )
            )._unsafeUnwrap().rows,
          );
        return state;
      };
      if (order === "acquire-first") {
        const checked = barrier(),
          release = barrier();
        const authority = new PgDurableAuthority(measured);
        const acquiring = authority.acquire(orb.id, "race-owner", 0, 0, 60_000, async (query) => {
          const verdict = await checkNativeStartup(query, orb.id, true);
          checked.resolve();
          await release.promise;
          return verdict;
        });
        await checked.promise;
        const publishing = other.store.initOrVerifySession(task, orb.id, {
          id: "host-sdk-session",
          overflow: {},
        });
        release.resolve();
        const owner = (await acquiring)._unsafeUnwrap();
        (await publishing)._unsafeUnwrap();
        const storage = (
          await authority.open(owner, {
            admit: (query) => checkNativeStartup(query, orb.id),
            project: (query, writes) => projectNativeCommit(query, orb.id, writes),
          })
        )._unsafeUnwrap();
        const before = await snapshot();
        const result = await DurableAgent.open({
          orbId: orb.id,
          storage,
          models: createModels(),
          registry: createRegistry(),
          env: new NodeExecutionEnv({ cwd: "/tmp" }),
          checkoutCommit: "pin",
          instructions: "test",
          resume: false,
          closeResources: () =>
            authority.release(owner).mapErr(() => ({
              type: "runtime_client_error" as const,
              code: "history_unavailable" as const,
              answered: true,
              retryable: true,
              message: "release failed",
            })),
        });
        if (result.isOk()) await result.value.close();
        expect(result.isErr() ? result.error : null).toMatchObject({
          code: "legacy_backend",
          retryable: false,
          message: legacyBackendMessage,
        });
        expect(await snapshot()).toEqual(before);
      } else {
        // Preflight is deliberately advisory: an independent locked writer wins next.
        (await database.agentPersistence.checkStartup!(task, orb, operation))._unsafeUnwrap();
        const locked = barrier(),
          release = barrier();
        const publishing = publisher.transaction(async (query) => {
          (await query("SELECT id FROM orbs WHERE id=$1 FOR UPDATE", [orb.id]))._unsafeUnwrap();
          const changed =
            order === "publication-first"
              ? await query(
                  "UPDATE orbs SET harness_session_id='host-sdk-session',harness_session_header=$2::jsonb WHERE id=$1",
                  [orb.id, JSON.stringify({ id: "host-sdk-session", overflow: {} })],
                )
              : await query(
                  "UPDATE orbs SET agent_admission_version=agent_admission_version+1,state=$2 WHERE id=$1",
                  [orb.id, order === "archive-first" ? "archived" : "running"],
                );
          locked.resolve();
          await release.promise;
          return changed.map(() => undefined);
        });
        await locked.promise;
        observeLock = true;
        const opening = database.agentPersistence.open(task, orb, operation);
        await waiting.promise;
        release.resolve();
        (await publishing)._unsafeUnwrap();
        const before = await snapshot();
        const result = await opening;
        if (result.isOk()) await result.value.release();
        expect(result.isErr()).toBe(true);
        if (order === "publication-first")
          expect(result._unsafeUnwrapErr()).toMatchObject({
            code: "legacy_backend",
            retryable: false,
            message: legacyBackendMessage,
          });
        expect(await snapshot()).toEqual(before);
        expect(
          (
            await publisher.query("SELECT * FROM durable_pg_owners WHERE orb_id=$1", [orb.id])
          )._unsafeUnwrap().rows,
        ).toEqual([]);
      }
    } finally {
      await database.agentPersistence.close();
      await other.agentPersistence.close();
      await database.close();
      await other.close();
      (await admin.query(`DROP SCHEMA ${schema} CASCADE`))._unsafeUnwrap();
      (await admin.end())._unsafeUnwrap();
    }
  },
);
