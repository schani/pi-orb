import { NoSimulationTask } from "determined";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { ProjectSecretsDeps } from "../../domain/ports.ts";
import {
  deleteProjectSecret,
  getProjectSecretSnapshot,
  putProjectSecret,
} from "../../domain/project-secrets.ts";
import { FakeSecretStore } from "../../testkit/broker.ts";
import { makeProjectRow } from "../../testkit/fixtures.ts";
import { composeControlPlaneDatabase } from "../database.ts";
import { PostgreSQLMcpStore } from "./mcp.ts";
import { PGliteClient } from "./pglite-client.ts";

const task = new NoSimulationTask("mcp-store", false);
const P = "00000000-0000-4000-8000-000000000071";
const Q = "00000000-0000-4000-8000-000000000072";
let db: PGliteClient;
let store: PostgreSQLMcpStore;
let secrets: ProjectSecretsDeps;
beforeEach(async () => {
  db = new PGliteClient();
  const database = composeControlPlaneDatabase(db);
  (await database.migrate())._unsafeUnwrap();
  (await database.store.insertProject(task, makeProjectRow(P)))._unsafeUnwrap();
  (await database.store.insertProject(task, makeProjectRow(Q)))._unsafeUnwrap();
  store = new PostgreSQLMcpStore(db);
  secrets = { pointers: database.projectSecrets, secrets: new FakeSecretStore() };
  (await putProjectSecret(task, secrets, P, "POSTHOG_KEY", "synthetic-value"))._unsafeUnwrap();
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
it.each(["catalog-first", "delete-first"])(
  "protects the dependency in both commit orders: %s",
  async (order) => {
    const catalog = {
      revision: 0,
      servers: [
        {
          name: "service",
          description: "Service",
          url: "https://example.com/mcp",
          headers: { "X-Api-Key": { secret: "POSTHOG_KEY" } },
        },
      ],
    };
    if (order === "catalog-first") {
      (await store.replace(task, P, catalog))._unsafeUnwrap();
      const blocked = await deleteProjectSecret(task, secrets, P, "POSTHOG_KEY");
      expect(blocked._unsafeUnwrapErr()).toMatchObject({
        type: "project_secret_conflict",
        message: "Cannot delete POSTHOG_KEY: used by MCP service",
      });
      expect(
        (await getProjectSecretSnapshot(task, secrets, P))._unsafeUnwrap().values["POSTHOG_KEY"],
      ).toBe("synthetic-value");
      (await putProjectSecret(task, secrets, P, "POSTHOG_KEY", "replacement"))._unsafeUnwrap();
      (await store.replace(task, P, { revision: 1, servers: [] }))._unsafeUnwrap();
      (await deleteProjectSecret(task, secrets, P, "POSTHOG_KEY"))._unsafeUnwrap();
    } else {
      (await deleteProjectSecret(task, secrets, P, "POSTHOG_KEY"))._unsafeUnwrap();
      expect((await store.replace(task, P, catalog))._unsafeUnwrapErr().code).toBe("conflict");
      expect((await store.read(task, P))._unsafeUnwrap().servers).toEqual([]);
    }
  },
);
it("isolates project references and does not treat literals as secret bindings", async () => {
  const server = {
    name: "service",
    description: "Service",
    url: "https://example.com/mcp",
    headers: { Authorization: { secret: "POSTHOG_KEY", prefix: "Bearer " as const } },
  };
  expect((await store.replace(task, Q, { revision: 0, servers: [server] })).isErr()).toBe(true);
  (await putProjectSecret(task, secrets, Q, "POSTHOG_KEY", "other-project"))._unsafeUnwrap();
  (await store.replace(task, Q, { revision: 0, servers: [server] }))._unsafeUnwrap();
  (
    await store.replace(task, P, {
      revision: 0,
      servers: [{ ...server, headers: { "X-Label": { literal: "POSTHOG_KEY" } } }],
    })
  )._unsafeUnwrap();
  (await deleteProjectSecret(task, secrets, P, "POSTHOG_KEY"))._unsafeUnwrap();
  expect(
    (await getProjectSecretSnapshot(task, secrets, Q))._unsafeUnwrap().values["POSTHOG_KEY"],
  ).toBe("other-project");
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
