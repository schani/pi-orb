import { readFile } from "node:fs/promises";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { err, ok } from "neverthrow";
import { expect, it } from "vitest";
import { PGliteClient } from "../pg/pglite-client.ts";
import { PgDurableAuthority } from "./index.ts";

const orb = "00000000-0000-4000-8000-000000000001";
async function fixture() {
  const db = new PGliteClient();
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
  (await db.transaction(async (_query, execute) => execute(migration)))._unsafeUnwrap();
  let time = 0;
  return {
    db,
    authority: new PgDurableAuthority(db, () => time),
    setTime: (value: number) => {
      time = value;
    },
  };
}
it("rolls native history back when public projection rejects and recovers committed data without notification", async () => {
  const { db, authority } = await fixture();
  try {
    const owner = (await authority.acquire(orb, "a", 0, 0, 10))._unsafeUnwrap();
    const failed = (
      await authority.open(owner, {
        project: async () =>
          err({ type: "authority_error", code: "projection", message: "public conflict" }),
      })
    )._unsafeUnwrap();
    await expect(
      failed.commit([{ type: "conversation", value: { id: 1 as ConversationId } }], ctx),
    ).rejects.toBeDefined();
    expect(await failed.conversation(1 as ConversationId, ctx)).toBeUndefined();
    await failed.close(ctx);
    const storage = (
      await authority.open(owner, {
        project: async (query) => {
          const result = await query("CREATE TABLE committed_public(id integer PRIMARY KEY)");
          return result.isErr() ? err(result.error) : ok(undefined);
        },
        afterCommit: () => {
          /* notification deliberately lost */
        },
      })
    )._unsafeUnwrap();
    await storage.commit([{ type: "conversation", value: { id: 1 as ConversationId } }], ctx);
    const reader = (await authority.read(orb))._unsafeUnwrap();
    expect(await reader.conversation(1 as ConversationId, ctx)).toEqual({ id: 1 });
    await reader.close(ctx);
    await storage.close(ctx);
  } finally {
    (await db.end())._unsafeUnwrap();
  }
});
it("fences expired owners and admission ABA while retaining independently sealed public data", async () => {
  const { db, authority, setTime } = await fixture();
  try {
    const old = (await authority.acquire(orb, "old", 0, 0, 10))._unsafeUnwrap();
    const storage = (
      await authority.open(old, { project: async () => ok(undefined) })
    )._unsafeUnwrap();
    expect((await authority.acquire(orb, "new", 0, 5, 15)).isErr()).toBe(true);
    setTime(10);
    const next = (await authority.acquire(orb, "new", 0, 10, 20))._unsafeUnwrap();
    await expect(
      storage.commit([{ type: "conversation", value: { id: 1 as ConversationId } }], ctx),
    ).rejects.toBeDefined();
    (
      await db.query("UPDATE orbs SET agent_admission_version=2 WHERE id=$1", [orb])
    )._unsafeUnwrap();
    expect((await authority.renew(next, 11, 30)).isErr()).toBe(true);
    await storage.close(ctx);
  } finally {
    (await db.end())._unsafeUnwrap();
  }
});
