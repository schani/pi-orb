import { NoSimulationTask } from "determined";
import { afterEach, beforeEach, expect, it } from "vitest";
import { makeProjectRow } from "../../testkit/fixtures.ts";
import { composeControlPlaneDatabase } from "../database.ts";
import { PostgreSQLMcpStore } from "./mcp.ts";
import { PGliteClient } from "./pglite-client.ts";

const task = new NoSimulationTask("mcp-store", false);
const P = "00000000-0000-4000-8000-000000000071";
const Q = "00000000-0000-4000-8000-000000000072";
let db: PGliteClient;
let store: PostgreSQLMcpStore;
beforeEach(async () => {
  db = new PGliteClient();
  const database = composeControlPlaneDatabase(db);
  (await database.migrate())._unsafeUnwrap();
  (await database.store.insertProject(task, makeProjectRow(P)))._unsafeUnwrap();
  (await database.store.insertProject(task, makeProjectRow(Q)))._unsafeUnwrap();
  store = new PostgreSQLMcpStore(db);
});
afterEach(async () => {
  await db.end();
});
it("fences concurrent writes by revision and isolates projects", async () => {
  const config = {
    name: "posthog",
    description: "Analytics",
    url: "https://mcp.posthog.com/mcp",
    headers: { Authorization: { secret: "POSTHOG_KEY", prefix: "Bearer " as const } },
  };
  const results = await Promise.all([
    store.replace(task, P, { revision: 0, servers: [config] }),
    store.replace(task, P, { revision: 0, servers: [] }),
  ]);
  expect(results.filter((r) => r.isOk())).toHaveLength(1);
  expect((await store.read(task, P))._unsafeUnwrap().revision).toBe(1);
  expect((await store.read(task, Q))._unsafeUnwrap()).toEqual({ revision: 0, servers: [] });
  expect(
    (await store.read(task, "00000000-0000-4000-8000-000000000099"))._unsafeUnwrapErr().code,
  ).toBe("not_found");
});
it("treats malformed project IDs as missing resources, not storage outages", async () => {
  expect((await store.read(task, "missing-project"))._unsafeUnwrapErr().code).toBe("not_found");
});

it("refuses publication after the project deletion fence and cascades cleanup", async () => {
  (await db.query("UPDATE projects SET state = 'deleting' WHERE id = $1", [P]))._unsafeUnwrap();
  expect((await store.replace(task, P, { revision: 0, servers: [] }))._unsafeUnwrapErr().code).toBe(
    "conflict",
  );
  expect((await store.read(task, P)).isErr()).toBe(true);
});
