import { randomUUID } from "node:crypto";
import { NoSimulationTask } from "determined";
import { ok } from "neverthrow";
import { beforeEach, describe, expect, it } from "vitest";
import type { ProjectSecretsDeps } from "../../domain/ports.ts";
import {
  deleteProjectSecret,
  getProjectSecretSnapshot,
  putProjectSecret,
} from "../../domain/project-secrets.ts";
import { FakeSecretStore } from "../../testkit/broker.ts";
import { makeProjectRow, seedTestUser } from "../../testkit/fixtures.ts";
import { openThrowawayPostgres } from "../../testkit/postgres.ts";
import { composeControlPlaneDatabase } from "../database.ts";
import { PgClient, type PostgreSQLClient } from "./client.ts";
import { PostgreSQLMcpStore } from "./mcp.ts";
import { PGliteClient } from "./pglite-client.ts";

const task = new NoSimulationTask("mcp-store", false);
const P = "00000000-0000-4000-8000-000000000071";
const Q = "00000000-0000-4000-8000-000000000072";
const url = process.env["PI_ORB_TEST_DATABASE_URL"];
describe.each(["PGlite", ...(url ? ["PostgreSQL"] : [])])("%s mcp", (backend) => {
  let db: PostgreSQLClient;
  let store: PostgreSQLMcpStore;
  let secrets: ProjectSecretsDeps;
  beforeEach(async ({ onTestFinished }) => {
    const subject =
      backend === "PostgreSQL" && url
        ? await openThrowawayPostgres(url)
        : (() => {
            const client = new PGliteClient();
            return { client, database: composeControlPlaneDatabase(client) };
          })();
    onTestFinished(async () => {
      const closed = await subject.database.close();
      expect(closed.isOk(), JSON.stringify(closed)).toBe(true);
    });
    db = subject.client;
    const database = subject.database;
    (await database.migrate())._unsafeUnwrap();
    (await seedTestUser(task, database.users))._unsafeUnwrap();
    (await database.store.insertProject(task, makeProjectRow(P)))._unsafeUnwrap();
    (await database.store.insertProject(task, makeProjectRow(Q)))._unsafeUnwrap();
    store = new PostgreSQLMcpStore(db);
    secrets = { pointers: database.projectSecrets, secrets: new FakeSecretStore() };
    (await putProjectSecret(task, secrets, P, "POSTHOG_KEY", "synthetic-value"))._unsafeUnwrap();
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

  it("refuses publication and reads after the project deletion fence", async () => {
    (await db.query("UPDATE projects SET state = 'deleting' WHERE id = $1", [P]))._unsafeUnwrap();
    expect(
      (await store.replace(task, P, { revision: 0, servers: [] }))._unsafeUnwrapErr().code,
    ).toBe("conflict");
    expect((await store.read(task, P)).isErr()).toBe(true);
  });

  it.skipIf(backend !== "PostgreSQL")(
    "waits for the project row lock and observes the committed deletion fence",
    async () => {
      if (!url) return;
      const schema = String(
        (await db.query("SELECT current_schema() AS schema"))._unsafeUnwrap().rows[0]?.schema,
      );
      const peerUrl = new URL(url);
      const applicationName = `audit-${randomUUID()}`;
      peerUrl.searchParams.set("options", `-c search_path=${schema}`);
      peerUrl.searchParams.set("application_name", applicationName);
      const peer = new PgClient(peerUrl.toString());
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: (pid: number) => void;
      const locked = new Promise<number>((resolve) => {
        entered = resolve;
      });
      const holder = db.transaction(async (query) => {
        (await query("SELECT id FROM projects WHERE id = $1 FOR UPDATE", [P]))._unsafeUnwrap();
        (await query("UPDATE projects SET state = 'deleting' WHERE id = $1", [P]))._unsafeUnwrap();
        entered(
          Number((await query("SELECT pg_backend_pid() AS pid"))._unsafeUnwrap().rows[0]?.pid),
        );
        await released;
        return ok(undefined);
      });
      let writing: ReturnType<PostgreSQLMcpStore["replace"]> | undefined;
      try {
        const pid = await Promise.race([
          locked,
          holder.then((result) => {
            result._unsafeUnwrap();
            throw new Error("holder finished before lock acknowledgement");
          }),
        ]);
        writing = new PostgreSQLMcpStore(peer).replace(task, P, { revision: 0, servers: [] });
        await expect
          .poll(
            async () =>
              (
                await db.query(
                  `SELECT count(*)::int AS blocked FROM pg_stat_activity
        WHERE application_name = $1 AND wait_event_type = 'Lock'
        AND query LIKE '%FOR UPDATE%' AND $2::int = ANY(pg_blocking_pids(pid))`,
                  [applicationName, pid],
                )
              )._unsafeUnwrap().rows[0]?.blocked,
          )
          .toBe(1);
        release();
        (await holder)._unsafeUnwrap();
        expect((await writing)._unsafeUnwrapErr().code).toBe("conflict");
        expect(
          (
            await db.query("SELECT revision FROM project_mcp WHERE project_id = $1", [P])
          )._unsafeUnwrap().rows,
        ).toEqual([]);
      } finally {
        release();
        await holder;
        if (writing) await writing;
        (await peer.end())._unsafeUnwrap();
      }
    },
  );
});
