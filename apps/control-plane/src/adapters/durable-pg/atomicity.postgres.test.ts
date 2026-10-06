import { readFile } from "node:fs/promises";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import { ok } from "neverthrow";
import { expect, it } from "vitest";
import { PgClient } from "../pg/client.ts";
import { PgDurableAuthority } from "./index.ts";

const connection = process.env.PI_ORB_DURABLE_PG_TEST_URL;
it.skipIf(!connection)(
  "real PostgreSQL isolates staged writes, rolls back public conflicts, reopens and fences failed-over owners",
  async () => {
    const admin = new PgClient(connection!);
    const schema = `durable_atomicity_${process.pid}`;
    (await admin.query(`CREATE SCHEMA ${schema}`))._unsafeUnwrap();
    const url = new URL(connection!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const db = new PgClient(url.toString());
    const other = new PgClient(url.toString());
    const orb = "00000000-0000-4000-8000-000000000001";
    let time = 0;
    try {
      (
        await db.query(
          "CREATE TABLE orbs(id uuid PRIMARY KEY, agent_admission_version bigint NOT NULL DEFAULT 0)",
        )
      )._unsafeUnwrap();
      (await db.query("INSERT INTO orbs(id) VALUES($1)", [orb]))._unsafeUnwrap();
      (
        await db.query(
          "CREATE TABLE public_transcript(id bigint PRIMARY KEY, text_value text NOT NULL, sealed boolean NOT NULL DEFAULT false)",
        )
      )._unsafeUnwrap();
      const migration = await readFile(
        new URL("../pg/migrations/034_durable_authority.sql", import.meta.url),
        "utf8",
      );
      (await db.transaction(async (_query, execute) => execute(migration)))._unsafeUnwrap();
      const authority = new PgDurableAuthority(db, () => time);
      const owner = (await authority.acquire(orb, "original", 0, 0, 10))._unsafeUnwrap();
      const storage = (
        await authority.open(owner, {
          checkpoint: async (phase) => {
            if (phase === "after_native" || phase === "after_projection") {
              // Independent connection cannot observe either half of the transaction.
              expect(
                (await other.query("SELECT id FROM durable_pg_entries"))._unsafeUnwrap().rows,
              ).toHaveLength(0);
              expect(
                (await other.query("SELECT id FROM public_transcript"))._unsafeUnwrap().rows,
              ).toHaveLength(0);
            }
          },
          project: async (query, writes) =>
            writes.some((write) => write.type === "entry")
              ? (
                  await query("INSERT INTO public_transcript(id,text_value) VALUES(2,'answer')")
                ).map(() => undefined)
              : ok(undefined),
          afterCommit: () => {
            // biome-ignore lint/plugin/no-throw: crash injection into third-party callback.
            throw new Error("lost notification");
          },
        })
      )._unsafeUnwrap();
      await storage.commit([{ type: "conversation", value: { id: 1 as ConversationId } }], ctx);
      await storage.commit(
        [
          {
            type: "entry",
            value: {
              id: 2 as EntryId,
              conversationId: 1 as ConversationId,
              kind: "public",
              data: "answer",
            },
          },
        ],
        ctx,
      );
      expect(
        (await other.query("SELECT id FROM public_transcript"))._unsafeUnwrap().rows,
      ).toHaveLength(1);
      const conflict = (
        await authority.open(owner, {
          project: async (query) =>
            (
              await query("INSERT INTO public_transcript(id,text_value) VALUES(2,'conflict')")
            ).map(() => undefined),
        })
      )._unsafeUnwrap();
      await expect(
        conflict.commit(
          [
            {
              type: "entry",
              value: {
                id: 3 as EntryId,
                conversationId: 1 as ConversationId,
                kind: "public",
                data: "never-visible",
              },
            },
          ],
          ctx,
        ),
      ).rejects.toThrow();
      expect(await conflict.entry(3 as EntryId, ctx)).toBeUndefined();
      await conflict.close(ctx);
      // Publication must take the orb lock in the same order as concurrent native commits.
      const concurrentAuthority = new PgDurableAuthority(other, () => time);
      const project = async (query: import("./executor.ts").Query) =>
        (await query("SELECT id FROM orbs WHERE id=$1 FOR UPDATE", [orb])).map(() => undefined);
      const a = (await authority.open(owner, { project }))._unsafeUnwrap();
      const b = (await concurrentAuthority.open(owner, { project }))._unsafeUnwrap();
      await Promise.all([
        a.commit([{ type: "conversation", value: { id: 4 as ConversationId } }], ctx),
        b.commit([{ type: "conversation", value: { id: 5 as ConversationId } }], ctx),
      ]);
      await a.close(ctx);
      await b.close(ctx);
      // Original runner is still alive, but lease expiry permits a new fenced owner.
      time = 10;
      const successorAuthority = new PgDurableAuthority(other, () => time);
      const successor = (
        await successorAuthority.acquire(orb, "successor", 0, time, 30)
      )._unsafeUnwrap();
      expect((await authority.validate(owner)).isErr()).toBe(true);
      await expect(storage.commit([], ctx)).rejects.toThrow("revoked");
      const reopened = (
        await successorAuthority.open(successor, { project: async () => ok(undefined) })
      )._unsafeUnwrap();
      expect((await reopened.entry(2 as EntryId, ctx))?.entry.data).toBe("answer");
      const seal = async (query: import("./executor.ts").Query) =>
        (await query("UPDATE public_transcript SET sealed=true")).map(() => undefined);
      expect((await successorAuthority.archive(successor, seal)).isOk()).toBe(true);
      expect((await successorAuthority.archive(successor, seal)).isOk()).toBe(true);
      expect((await successorAuthority.read(orb)).isErr()).toBe(true);
      expect(
        (await other.query("SELECT * FROM public_transcript"))._unsafeUnwrap().rows,
      ).toMatchObject([{ text_value: "answer", sealed: true }]);
      await reopened.close(ctx);
      await storage.close(ctx);
    } finally {
      (await db.end())._unsafeUnwrap();
      (await other.end())._unsafeUnwrap();
      (await admin.query(`DROP SCHEMA ${schema} CASCADE`))._unsafeUnwrap();
      (await admin.end())._unsafeUnwrap();
    }
  },
);
