import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { ok } from "neverthrow";
import { expect, it } from "vitest";
import { PgClient } from "../pg/client.ts";
import { PgDurableAuthority } from "./index.ts";

it("real PostgreSQL bounds stop cleanup to its storage while fencing admission, release and archive", async () => {
  const admin = new PgClient(process.env.PI_ORB_DURABLE_PG_TEST_URL!);
  const schema = `durable_drain_${randomUUID().replaceAll("-", "")}`;
  (await admin.query(`CREATE SCHEMA ${schema}`))._unsafeUnwrap();
  const url = new URL(process.env.PI_ORB_DURABLE_PG_TEST_URL!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const db = new PgClient(url.toString());
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
    const authority = new PgDurableAuthority(db, () => 0);
    const owner = (await authority.acquire(orb, "old", 0, 0, 100))._unsafeUnwrap();
    const project = async (query: import("./executor.ts").Query) =>
      (await query("CREATE TABLE IF NOT EXISTS public_terminal(id integer)")).map(() => undefined);
    const storage = (await authority.open(owner, { project }))._unsafeUnwrap();
    const undrained = (await authority.open(owner, { project }))._unsafeUnwrap();
    (await db.query("UPDATE orbs SET agent_admission_version=1"))._unsafeUnwrap();
    await expect(storage.commit([], ctx)).rejects.toThrow("admission");
    expect((await authority.beginDrain(owner, storage)).isOk()).toBe(true);
    expect((await authority.validate(owner)).isErr()).toBe(true);
    expect((await authority.ownedTransaction(owner, async () => ok(undefined))).isErr()).toBe(true);
    await expect(undrained.commit([], ctx)).rejects.toThrow("admission");
    await storage.mintId();
    await storage.commit([{ type: "conversation", value: { id: 1 as ConversationId } }], ctx);
    expect((await authority.release(owner)).isOk()).toBe(true);
    expect((await authority.release(owner)).isOk()).toBe(true);
    const successor = (await authority.acquire(orb, "new", 1, 0, 100))._unsafeUnwrap();
    expect((await authority.release(owner)).isErr()).toBe(true);
    expect((await authority.validate(successor)).isOk()).toBe(true);
    await expect(storage.commit([], ctx)).rejects.toThrow("revoked");
    expect((await authority.beginDrain(owner, storage)).isErr()).toBe(true);
    const fresh = (await authority.open(successor, { project }))._unsafeUnwrap();
    (await db.query("UPDATE orbs SET agent_admission_version=2"))._unsafeUnwrap();
    expect((await authority.beginDrain(successor, fresh)).isOk()).toBe(true);
    expect((await authority.archive(successor, async () => ok(undefined))).isOk()).toBe(true);
    expect(
      (await db.query("SELECT * FROM durable_pg_conversations"))._unsafeUnwrap().rows,
    ).toHaveLength(0);
    expect((await db.query("SELECT * FROM public_terminal")).isOk()).toBe(true);
    await storage.close(ctx);
    await undrained.close(ctx);
    await fresh.close(ctx);
  } finally {
    (await db.end())._unsafeUnwrap();
    (await admin.query(`DROP SCHEMA ${schema} CASCADE`))._unsafeUnwrap();
    (await admin.end())._unsafeUnwrap();
  }
});
