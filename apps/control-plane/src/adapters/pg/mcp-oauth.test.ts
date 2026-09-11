import { randomUUID } from "node:crypto";
import { NoSimulationTask } from "determined";
import { afterEach, beforeEach, expect, it } from "vitest";
import { makeProjectRow } from "../../testkit/fixtures.ts";
import { composeControlPlaneDatabase } from "../database.ts";
import { PgClient, type PostgreSQLClient } from "./client.ts";
import { PostgreSQLMcpStore } from "./mcp.ts";
import { PostgreSQLMcpOAuthStore } from "./mcp-oauth.ts";
import { PGliteClient } from "./pglite-client.ts";

const task = new NoSimulationTask("oauth-store", false);
const binding = {
  projectId: "00000000-0000-4000-8000-000000000071",
  id: "00000000-0000-4000-8000-000000000072",
  url: "https://mcp.example/mcp",
};
const config = {
  name: "test",
  url: binding.url,
  description: "test",
  headers: {},
  oauth: { id: binding.id },
};
const next = {
  generation: 1,
  secretVersion: "v1",
  refreshLeaseUntil: 0,
  lastRefreshAt: 0,
  attempt: null,
};
let db: PostgreSQLClient;
let admin: PgClient | null = null;
let schema: string | null = null;
let store: PostgreSQLMcpOAuthStore;
let catalog: PostgreSQLMcpStore;
beforeEach(async () => {
  const url = process.env["PI_ORB_TEST_DATABASE_URL"];
  if (url) {
    // Network PostgreSQL uses a test-owned schema, never resets shared public tables.
    admin = new PgClient(url);
    schema = `mcp_oauth_test_${randomUUID().replaceAll("-", "")}`;
    (await admin.query(`CREATE SCHEMA ${schema}`))._unsafeUnwrap();
    const scoped = new URL(url);
    scoped.searchParams.set("options", `-c search_path=${schema}`);
    db = new PgClient(scoped.toString());
  } else db = new PGliteClient();
  const database = composeControlPlaneDatabase(db);
  (await database.migrate())._unsafeUnwrap();
  (await database.store.insertProject(task, makeProjectRow(binding.projectId)))._unsafeUnwrap();
  store = new PostgreSQLMcpOAuthStore(db);
  catalog = new PostgreSQLMcpStore(db);
  (
    await catalog.replace(task, binding.projectId, { revision: 0, servers: [config] })
  )._unsafeUnwrap();
});
afterEach(async () => {
  await db.end();
  if (admin && schema) {
    (await admin.query(`DROP SCHEMA ${schema} CASCADE`))._unsafeUnwrap();
    await admin.end();
    admin = null;
    schema = null;
  }
});
it("atomic CAS publishes one grant and one edge, and preserves outage classification", async () => {
  const outcomes = await Promise.all([
    store.cas(task, binding, null, next, "connected"),
    store.cas(task, binding, null, next, "connected"),
  ]);
  expect(outcomes.filter((o) => o.isOk())).toHaveLength(1);
  expect((await store.read(task, binding))._unsafeUnwrap()?.secretVersion).toBe("v1");
  expect((await db.query("SELECT * FROM mcp_oauth_events"))._unsafeUnwrap().rows).toHaveLength(1);
  const broken = new PostgreSQLMcpOAuthStore({
    ...db,
    transaction: () => db.query("INVALID SQL"),
  } as unknown as PostgreSQLClient);
  expect((await broken.read(task, binding))._unsafeUnwrapErr().code).toBe("unavailable");
});
it("removal fences stale refresh and re-adding the same ID cannot resurrect its grant", async () => {
  const row = (await store.cas(task, binding, null, next, "connected"))._unsafeUnwrap();
  (await catalog.replace(task, binding.projectId, { revision: 1, servers: [] }))._unsafeUnwrap();
  expect(
    (
      await store.cas(
        task,
        binding,
        row.rowVersion,
        { ...next, secretVersion: "late" },
        "refreshed",
      )
    ).isErr(),
  ).toBe(true);
  (
    await catalog.replace(task, binding.projectId, { revision: 2, servers: [config] })
  )._unsafeUnwrap();
  expect((await store.read(task, binding))._unsafeUnwrap()?.secretVersion).toBeNull();
  expect((await store.pending(task))._unsafeUnwrap()).toEqual(["v1"]);
  (await store.finish(task, "v1", false))._unsafeUnwrap();
  (await store.finish(task, "v1", false))._unsafeUnwrap();
  expect((await store.pending(task))._unsafeUnwrap()).toEqual(["v1"]);
  expect(
    (
      await db.query("SELECT * FROM mcp_oauth_events WHERE edge = 'credential_cleanup_failed'")
    )._unsafeUnwrap().rows,
  ).toHaveLength(1);
  (await store.finish(task, "v1", true))._unsafeUnwrap();
  expect((await store.pending(task))._unsafeUnwrap()).toEqual([]);
  expect((await store.cas(task, binding, row.rowVersion, next, "refreshed")).isErr()).toBe(true);
});
it("URL/project/deletion fences reject old bindings and preserve other ownership", async () => {
  (await store.cas(task, binding, null, next, "connected"))._unsafeUnwrap();
  expect(
    (await store.read(task, { ...binding, projectId: binding.id }))._unsafeUnwrapErr().code,
  ).toBe("not_found");
  expect(
    (await store.read(task, { ...binding, url: "https://elsewhere.example" }))._unsafeUnwrapErr()
      .code,
  ).toBe("not_found");
  (
    await db.query("UPDATE projects SET state = 'deleting' WHERE id = $1", [binding.projectId])
  )._unsafeUnwrap();
  expect((await store.read(task, binding))._unsafeUnwrapErr().code).toBe("not_found");
  expect((await store.cas(task, binding, 1, next, "refreshed"))._unsafeUnwrapErr().code).toBe(
    "not_found",
  );
});
