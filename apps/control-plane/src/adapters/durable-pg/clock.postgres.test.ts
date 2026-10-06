import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { PgClient } from "../pg/client.ts";
import { PgDurableAuthority } from "./index.ts";

it("uses locked database time, not skewed caller clocks, for acquisition and renewal", async () => {
  const connection = process.env.PI_ORB_DURABLE_PG_TEST_URL!;
  const admin = new PgClient(connection);
  const schema = `durable_clock_${randomUUID().replaceAll("-", "")}`;
  (await admin.query(`CREATE SCHEMA ${schema}`))._unsafeUnwrap();
  const url = new URL(connection);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const db = new PgClient(url.toString());
  const other = new PgClient(url.toString());
  const orb = "00000000-0000-4000-8000-000000000001";
  try {
    (
      await db.query(
        "CREATE TABLE orbs(id uuid PRIMARY KEY, agent_admission_version bigint NOT NULL DEFAULT 0)",
      )
    )._unsafeUnwrap();
    (await db.query("INSERT INTO orbs(id) VALUES($1)", [orb]))._unsafeUnwrap();
    const migration = await readFile(
      new URL("../pg/migrations/034_durable_authority.sql", import.meta.url),
      "utf8",
    );
    (await db.transaction(async (_q, execute) => execute(migration)))._unsafeUnwrap();
    const authority = new PgDurableAuthority(db);
    const rival = new PgDurableAuthority(other);
    const owner = (await authority.acquire(orb, "old", 0, -1e12, -1e12 + 60_000))._unsafeUnwrap();
    expect((await authority.validate(owner)).isOk()).toBe(true);
    expect((await rival.acquire(orb, "rival", 0, 1e15, 1e15 + 60_000)).isErr()).toBe(true);
    expect((await authority.renew(owner, 1e15, 1e15 + 120_000)).isOk()).toBe(true);
    const remaining = (
      await db.query(
        "SELECT lease_until-floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS remaining FROM durable_pg_owners",
      )
    )._unsafeUnwrap();
    expect(Number(remaining.rows[0]?.remaining)).toBeGreaterThan(60_000);
    expect(Number(remaining.rows[0]?.remaining)).toBeLessThanOrEqual(120_000);
    const events = (
      await db.query(
        "SELECT recorded_at-floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS age FROM durable_pg_owner_events",
      )
    )._unsafeUnwrap();
    expect(Number(events.rows[0]?.age)).toBeLessThanOrEqual(0);
    expect(Number(events.rows[0]?.age)).toBeGreaterThan(-60_000);
    expect((await authority.release(owner)).isOk()).toBe(true);
    expect((await rival.acquire(orb, "rival", 0, -1e12, -1e12 + 60_000)).isOk()).toBe(true);
  } finally {
    (await db.end())._unsafeUnwrap();
    (await other.end())._unsafeUnwrap();
    (await admin.query(`DROP SCHEMA ${schema} CASCADE`))._unsafeUnwrap();
    (await admin.end())._unsafeUnwrap();
  }
});
