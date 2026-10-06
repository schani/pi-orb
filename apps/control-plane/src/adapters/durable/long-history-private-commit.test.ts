import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineDoc, Harness } from "@earendil-works/pi-durable";
import { NoSimulationTask } from "determined";
import { expect, it } from "vitest";
import { makeOrbRow, makeProjectRow } from "../../testkit/fixtures.ts";
import { composeControlPlaneDatabase } from "../database.ts";
import type { Query } from "../durable-pg/executor.ts";
import { PgDurableAuthority } from "../durable-pg/index.ts";
import type { PostgreSQLClient } from "../pg/client.ts";
import { PGliteClient } from "../pg/pglite-client.ts";
import { projectNativeCommit } from "./atomic-history.ts";

it("does not scan or republish multi-MiB root history for native private progress commits", async () => {
  const db = new PGliteClient();
  let nativeEntryReads = 0,
    publicHistoryWrites = 0;
  const measured =
    (query: Query): Query =>
    (sql, values) => {
      if (/^\s*SELECT/.test(sql) && sql.includes("durable_pg_entries")) nativeEntryReads++;
      if (/^\s*(?:INSERT|UPDATE|DELETE)/.test(sql) && sql.includes("history_records"))
        publicHistoryWrites++;
      return query(sql, values);
    };
  const client = new Proxy(db, {
    get(target, key) {
      if (key === "query") return measured(target.query.bind(target));
      if (key === "transaction")
        return (...args: Parameters<PostgreSQLClient["transaction"]>) =>
          target.transaction((query, execute) => args[0](measured(query), execute));
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as PostgreSQLClient;
  const database = composeControlPlaneDatabase(client);
  const task = new NoSimulationTask("long-history-native-progress", false);
  const project = makeProjectRow(randomUUID()),
    orb = makeOrbRow(randomUUID(), project.id, "running");
  let harness: Harness | undefined;
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
    const authority = new PgDurableAuthority(client, () => 0);
    const owner = (await authority.acquire(orb.id, "owner", 0, 0, 1000))._unsafeUnwrap();
    const storage = (
      await authority.open(owner, {
        project: (query, writes) => projectNativeCommit(query, orb.id, writes),
      })
    )._unsafeUnwrap();
    harness = await Harness.open(
      storage,
      { models: createModels(), registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    const root = await harness.root(BACKGROUND_CONTEXT);
    const identity = defineDoc({
      kind: "orb.identity",
      version: 1,
      scope: "conversation",
      history: "latest",
      fork: "initial",
      initial: () => ({ sessionId: "long-native", timestamp: 0, receipts: {} }),
    });
    const progress = defineDoc({
      kind: "orb.private-progress",
      version: 1,
      scope: "conversation",
      history: "latest",
      fork: "initial",
      initial: () => ({ ticks: 0 }),
    });
    await root.commit(async (tx) => {
      await tx.doc(identity, root.id);
      await tx.doc(progress, root.id);
      for (let index = 0; index < 200; index++)
        await tx.appendEntry(root.id, {
          kind: "pi.message",
          model: [{ role: "user", content: `${index}:${"x".repeat(16_384)}`, timestamp: index }],
        });
    }, BACKGROUND_CONTEXT);
    expect(nativeEntryReads).toBeGreaterThan(0);
    expect(publicHistoryWrites).toBeGreaterThan(0);
    const before = (
      await db.query(
        "SELECT count(*) AS n, md5(string_agg(record::text, '' ORDER BY record_id)) AS digest FROM history_records WHERE orb_id=$1",
        [orb.id],
      )
    )._unsafeUnwrap().rows;
    const oldCursor = (await database.store.getOrb(task, orb.id))._unsafeUnwrap()
      ?.replicationCursor;
    nativeEntryReads = 0;
    publicHistoryWrites = 0;
    for (let index = 0; index < 40; index++)
      await root.commit(async (tx) => {
        (await tx.doc(progress, root.id)).ticks++;
      }, BACKGROUND_CONTEXT);
    expect(nativeEntryReads).toBe(0);
    expect(publicHistoryWrites).toBe(0);
    expect(
      (
        await db.query(
          "SELECT count(*) AS n, md5(string_agg(record::text, '' ORDER BY record_id)) AS digest FROM history_records WHERE orb_id=$1",
          [orb.id],
        )
      )._unsafeUnwrap().rows,
    ).toEqual(before);
    expect((await database.store.getOrb(task, orb.id))._unsafeUnwrap()?.replicationCursor).toBe(
      oldCursor,
    );
  } finally {
    await harness?.close(BACKGROUND_CONTEXT);
    await database.close();
  }
});
