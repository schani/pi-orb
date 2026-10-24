import { randomUUID } from "node:crypto";
import { ok, ResultAsync } from "neverthrow";
import { expect } from "vitest";
import { composeControlPlaneDatabase } from "../adapters/database.ts";
import { PgClient, type PostgreSQLClient } from "../adapters/pg/client.ts";
import type { StoreContractSubject } from "./store-contract.ts";

/** Real node-postgres subject with an owned schema and pool-wide search_path. */
export async function openThrowawayPostgres(
  connectionString: string,
): Promise<StoreContractSubject> {
  const url = new URL(connectionString);
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  const admin = new PgClient(connectionString);
  const created = await admin.query(`CREATE SCHEMA "${schema}"`);
  if (created.isErr()) {
    await admin.end();
    created._unsafeUnwrap();
  }
  url.searchParams.set(
    "options",
    `${url.searchParams.get("options") ?? ""} -c search_path=${schema}`.trim(),
  );
  class SubjectClient extends PgClient {
    override end() {
      return new ResultAsync(
        (async () => {
          const ended = await super.end();
          const dropped = await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
          const closed = await admin.end();
          if (ended.isErr()) return ended;
          if (dropped.isErr()) return dropped.map(() => undefined);
          return closed;
        })(),
      );
    }
  }
  const client = new SubjectClient(url.toString());
  return { database: composeControlPlaneDatabase(client), client };
}

export async function assertProjectDeletionFence<T, E extends { code: string }>(
  db: PostgreSQLClient,
  connectionString: string,
  projectId: string,
  write: (peer: PgClient) => ResultAsync<T, E>,
): Promise<void> {
  const schema = String(
    (await db.query("SELECT current_schema() AS schema"))._unsafeUnwrap().rows[0]?.schema,
  );
  const peerUrl = new URL(connectionString);
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
    (await query("SELECT id FROM projects WHERE id = $1 FOR UPDATE", [projectId]))._unsafeUnwrap();
    (
      await query("UPDATE projects SET state = 'deleting' WHERE id = $1", [projectId])
    )._unsafeUnwrap();
    entered(Number((await query("SELECT pg_backend_pid() AS pid"))._unsafeUnwrap().rows[0]?.pid));
    await released;
    return ok(undefined);
  });
  let writing: ReturnType<typeof write> | undefined;
  try {
    const pid = await Promise.race([
      locked,
      holder.then((result) => {
        result._unsafeUnwrap();
        throw new Error("holder finished before lock acknowledgement");
      }),
    ]);
    writing = write(peer);
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
  } finally {
    release();
    await holder;
    if (writing) await writing;
    (await peer.end())._unsafeUnwrap();
  }
}
