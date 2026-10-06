import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { errAsync } from "neverthrow";
import { expect, it } from "vitest";
import { PgClient } from "./client.ts";
import { PgResourceSnapshots } from "./resource-snapshots.ts";

const url = process.env["PI_ORB_TEST_DATABASE_URL"];
it.skipIf(!url)("resource snapshot atomicity and admission on real PostgreSQL", async () => {
  if (!url) return;
  const schema = `resource_${randomUUID().replaceAll("-", "")}`;
  const admin = new PgClient(url);
  expect((await admin.query(`CREATE SCHEMA ${schema}`)).isOk()).toBe(true);
  const scoped = new URL(url);
  scoped.searchParams.set("options", `-csearch_path=${schema}`);
  const client = new PgClient(scoped.href);
  const reader = new PgClient(scoped.href);
  const orbId = "00000000-0000-4000-8000-000000000001";
  try {
    expect((await client.query("CREATE TABLE orbs(id uuid PRIMARY KEY)")).isOk()).toBe(true);
    const migration = await readFile(
      new URL("./migrations/036_resource_snapshots.sql", import.meta.url),
      "utf8",
    );
    expect((await client.transaction(async (_query, execute) => execute(migration))).isOk()).toBe(
      true,
    );
    await client.query("INSERT INTO orbs VALUES($1)", [orbId]);
    const snapshot = {
      orbId,
      commitSha: "a".repeat(40),
      instructionPath: null,
      skillRoot: null,
      files: [{ path: "asset", sha256: "invalid", bytes: Buffer.from([0, 255]) }],
    };
    const store = new PgResourceSnapshots(client);
    expect((await store.put(snapshot)).isErr()).toBe(true);
    const reopened = new PgResourceSnapshots(reader);
    expect((await reopened.get(orbId))._unsafeUnwrap()).toBe(null);
    const guard = new PgResourceSnapshots(client, () =>
      errAsync({
        type: "store_error",
        code: "invariant",
        message: "Admission revoked",
        retryable: false,
      }),
    );
    expect((await guard.put({ ...snapshot, files: [] })).isErr()).toBe(true);
    expect((await reopened.get(orbId))._unsafeUnwrap()).toBe(null);
    const [a, b] = await Promise.all([
      store.put({ ...snapshot, files: [] }),
      new PgResourceSnapshots(reader).put({ ...snapshot, commitSha: "b".repeat(40), files: [] }),
    ]);
    expect(a.isOk() && b.isOk() && a.value.commitSha === b.value.commitSha).toBe(true);
    expect((await reopened.get(orbId))._unsafeUnwrap()?.commitSha).toBe(
      a._unsafeUnwrap().commitSha,
    );
    await store.remove(orbId);
    expect((await reopened.get(orbId))._unsafeUnwrap()).toBe(null);
  } finally {
    await client.end();
    await reader.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
