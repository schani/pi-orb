import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { composeControlPlaneDatabase } from "../adapters/database.ts";
import { PgClient } from "../adapters/pg/client.ts";
import { openThrowawayPostgres } from "./postgres.ts";
import type { StoreContractSubject } from "./store-contract.ts";

const url = process.env["PI_ORB_TEST_DATABASE_URL"];
const subjects: StoreContractSubject[] = [];
afterEach(async () => {
  await Promise.all(subjects.splice(0).map((subject) => subject.database.close()));
});

it.skipIf(!url)("keeps two active PostgreSQL subjects and their migrations isolated", async () => {
  if (!url) return;
  const first = await openThrowawayPostgres(url);
  subjects.push(first);
  expect(
    (await first.client.query("SELECT current_schemas(false)::text[] AS schemas"))._unsafeUnwrap()
      .rows[0]?.schemas,
  ).toEqual([expect.stringMatching(/^test_/), "public"]);
  (await first.client.query("CREATE TABLE isolation_marker (value text)"))._unsafeUnwrap();
  (await first.client.query("INSERT INTO isolation_marker VALUES ('first')"))._unsafeUnwrap();
  const second = await openThrowawayPostgres(url);
  subjects.push(second);
  (await second.client.query("CREATE TABLE isolation_marker (value text)"))._unsafeUnwrap();
  (await second.client.query("INSERT INTO isolation_marker VALUES ('second')"))._unsafeUnwrap();
  const migrations = await Promise.all(subjects.map((subject) => subject.database.migrate()));
  for (const result of migrations) result._unsafeUnwrap();
  for (const [index, subject] of subjects.entries()) {
    expect(
      (
        await subject.client.query(
          "SELECT indexdef FROM pg_indexes WHERE schemaname=current_schema() AND indexname='history_records_search_idx'",
        )
      )._unsafeUnwrap().rows[0]?.indexdef,
    ).toContain("USING bm25");
    expect(
      (await subject.client.query("SELECT value FROM isolation_marker"))._unsafeUnwrap().rows,
    ).toEqual([{ value: index === 0 ? "first" : "second" }]);
  }
  (await second.database.close())._unsafeUnwrap();
  subjects.pop();
  expect(
    (
      await first.client.query(
        "SELECT extnamespace::regnamespace::text AS schema FROM pg_extension WHERE extname = 'pg_textsearch'",
      )
    )._unsafeUnwrap().rows,
  ).toEqual([{ schema: "public" }]);
  expect(
    (await first.client.query("SELECT value FROM isolation_marker"))._unsafeUnwrap().rows,
  ).toEqual([{ value: "first" }]);
});

it.skipIf(!url)(
  "migrates a fresh PostgreSQL database in public with pg_textsearch 1.3.1",
  async () => {
    if (!url) return;
    const name = `history_${randomUUID().replaceAll("-", "")}`;
    const admin = new PgClient(url);
    const created = await admin.query(`CREATE DATABASE "${name}"`);
    if (created.isErr()) {
      await admin.end();
      created._unsafeUnwrap();
    }
    const connection = new URL(url);
    connection.pathname = `/${name}`;
    connection.searchParams.delete("options");
    const client = new PgClient(connection.toString());
    const database = composeControlPlaneDatabase(client);
    try {
      (await database.migrate())._unsafeUnwrap();
      expect(
        (
          await client.query(
            "SELECT current_schema() AS schema, extversion, extnamespace::regnamespace::text AS extension_schema FROM pg_extension WHERE extname='pg_textsearch'",
          )
        )._unsafeUnwrap().rows,
      ).toEqual([{ schema: "public", extversion: "1.3.1", extension_schema: "public" }]);
      expect(
        (
          await client.query(
            "SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='history_records_search_idx'",
          )
        )._unsafeUnwrap().rows[0]?.indexdef,
      ).toContain("USING bm25");
    } finally {
      const closed = await database.close();
      const dropped = await admin.query(`DROP DATABASE "${name}"`);
      const ended = await admin.end();
      closed._unsafeUnwrap();
      dropped._unsafeUnwrap();
      ended._unsafeUnwrap();
    }
  },
);
