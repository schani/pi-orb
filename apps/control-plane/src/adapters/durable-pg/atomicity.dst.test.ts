import { readFile } from "node:fs/promises";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import { ok, ResultAsync } from "neverthrow";
import { expect, it } from "vitest";
import { runDst } from "../../testkit/sim.ts";
import { PGliteClient } from "../pg/pglite-client.ts";
import { PgDurableAuthority, readTransactionStorage } from "./index.ts";

const orb = "00000000-0000-4000-8000-000000000001";
async function initialize(db: PGliteClient) {
  (
    await db.query(
      "CREATE TABLE orbs(id uuid PRIMARY KEY, agent_admission_version bigint NOT NULL DEFAULT 0)",
    )
  )._unsafeUnwrap();
  (await db.query("INSERT INTO orbs(id) VALUES($1)", [orb]))._unsafeUnwrap();
  (
    await db.query(
      "CREATE TABLE public_transcript(id bigint PRIMARY KEY, sealed boolean NOT NULL DEFAULT false)",
    )
  )._unsafeUnwrap();
  const migration = await readFile(
    new URL("../pg/migrations/035_durable_authority.sql", import.meta.url),
    "utf8",
  );
  (await db.transaction(async (_q, execute) => execute(migration)))._unsafeUnwrap();
  (
    await db.query(
      "ALTER TABLE durable_pg_owner_events DROP CONSTRAINT durable_pg_owner_events_outcome_check, ADD CHECK (outcome IN ('acquired','released','archived','draining'))",
    )
  )._unsafeUnwrap();
}
for (const failAt of [
  "before_native",
  "after_native",
  "after_projection",
  "after_commit",
] as const) {
  it(`atomic native/public commit at crash phase ${failAt}`, async () => {
    const db = new PGliteClient();
    try {
      await initialize(db);
      const authority = new PgDurableAuthority(db, () => 0);
      const owner = (await authority.acquire(orb, "writer", 0, 0, 10))._unsafeUnwrap();
      const storage = (
        await authority.open(owner, {
          checkpoint: async (phase) => {
            if (phase === failAt) {
              // biome-ignore lint/plugin/no-throw: crash injection into third-party callback.
              throw new Error("simulated crash");
            }
          },
          project: async (query) => {
            const reader = await readTransactionStorage(query, orb);
            expect(await reader.conversation(1 as ConversationId, ctx)).toEqual({ id: 1 });
            await reader.close(ctx);
            return (await query("INSERT INTO public_transcript(id) VALUES(1)")).map(
              () => undefined,
            );
          },
          afterCommit: () => {
            // biome-ignore lint/plugin/no-throw: crash injection into third-party callback.
            throw new Error("notification lost");
          },
        })
      )._unsafeUnwrap();
      const committed = await ResultAsync.fromPromise(
        storage.commit([{ type: "conversation", value: { id: 1 as ConversationId } }], ctx),
        () => "crashed",
      );
      const expected = failAt === "after_commit";
      expect(committed.isOk()).toBe(expected);
      expect(await storage.conversation(1 as ConversationId, ctx)).toEqual(
        expected ? { id: 1 } : undefined,
      );
      expect((await db.query("SELECT * FROM public_transcript"))._unsafeUnwrap().rows).toHaveLength(
        expected ? 1 : 0,
      );
      await storage.close(ctx);
    } finally {
      (await db.end())._unsafeUnwrap();
    }
  });
}
it("DST schedules old-owner commits, Stop ABA and archive cleanup without half-public history", async () => {
  const db = new PGliteClient();
  try {
    await initialize(db);
    await runDst({ name: "durable-pg-ownership-atomicity", iterations: 10 }, async (sim) => {
      (
        await db.query("UPDATE orbs SET agent_admission_version=0 WHERE id=$1", [orb])
      )._unsafeUnwrap();
      (await db.query("DELETE FROM public_transcript"))._unsafeUnwrap();
      for (const table of [
        "owners",
        "owner_events",
        "document_revisions",
        "documents",
        "submissions",
        "tasks",
        "entries",
        "conversations",
        "record_ids",
        "durable_metadata",
      ])
        (await db.query(`DELETE FROM durable_pg_${table} WHERE orb_id=$1`, [orb]))._unsafeUnwrap();
      const authority = new PgDurableAuthority(db, () => 0);
      const owner = (await authority.acquire(orb, "old", 0, 0, 10))._unsafeUnwrap();
      const setup = (
        await authority.open(owner, { project: async () => ok(undefined) })
      )._unsafeUnwrap();
      await setup.commit([{ type: "conversation", value: { id: 1 as ConversationId } }], ctx);
      await setup.close(ctx);
      const result = await sim.runTasks([
        {
          name: "commit",
          f: async (task) => {
            const opened = await authority.open(owner, {
              checkpoint: (phase) => task.checkpoint(phase),
              project: async (query) =>
                (await query("INSERT INTO public_transcript(id) VALUES(2)")).map(() => undefined),
            });
            // Archive may have already removed authority before this stale owner opens it.
            if (opened.isErr()) {
              expect(opened.error.code).toBe("missing");
              return;
            }
            const storage = opened.value;
            await task.checkpoint("before-drain");
            await authority.beginDrain(owner, storage);
            await task.checkpoint("before-old-commit");
            await ResultAsync.fromPromise(
              storage.commit(
                [
                  {
                    type: "entry",
                    value: {
                      id: 2 as EntryId,
                      conversationId: 1 as ConversationId,
                      kind: "public",
                      data: "visible",
                    },
                  },
                ],
                ctx,
              ),
              () => "revoked",
            );
            await storage.close(ctx);
          },
        },
        {
          name: "stop-start",
          f: async (task) => {
            await task.checkpoint("before-stop-aba");
            (
              await db.query("UPDATE orbs SET agent_admission_version=2 WHERE id=$1", [orb])
            )._unsafeUnwrap();
            await task.checkpoint("after-stop-aba");
          },
        },
        {
          name: "archive",
          f: async (task) => {
            await task.checkpoint("before-archive");
            await authority.archive(owner, async (query) =>
              (await query("UPDATE public_transcript SET sealed=true")).map(() => undefined),
            );
            await task.checkpoint("after-archive");
          },
        },
      ]);
      expect(result.isErr() ? result.error : null).toBeNull();
      const native = (
        await db.query("SELECT id FROM durable_pg_entries WHERE orb_id=$1", [orb])
      )._unsafeUnwrap().rows;
      const publicRows = (await db.query("SELECT * FROM public_transcript"))._unsafeUnwrap().rows;
      const archived = (
        await db.query("SELECT archived FROM durable_pg_owners WHERE orb_id=$1", [orb])
      )._unsafeUnwrap().rows[0]?.archived;
      if (archived) {
        expect(native).toHaveLength(0);
        expect(publicRows.every((row) => row.sealed)).toBe(true);
      } else expect(native.length).toBe(publicRows.length);
      expect((await authority.validate(owner)).isErr()).toBe(true);
    });
  } finally {
    (await db.end())._unsafeUnwrap();
  }
});
