import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { ConversationId, Seq, StorageWrite } from "@earendil-works/pi-durable";
import { err, errAsync, ok } from "neverthrow";
import { expect, it, vi } from "vitest";
import { PgClient, type PostgreSQLClient } from "../pg/client.ts";
import { PGliteClient } from "../pg/pglite-client.ts";
import { initializeBareAuthority } from "./bare-authority.testkit.ts";
import type { SqlValue } from "./executor.ts";
import { PgDurableAuthority } from "./index.ts";
import { PgStorage } from "./storage.ts";

const orb = "00000000-0000-4000-8000-000000000001";
const batch = (id: number): readonly StorageWrite[] => [
  { type: "conversation", value: { id: id as ConversationId } },
];
const postgres = process.env.PI_ORB_DURABLE_PG_TEST_URL;
async function fixture(backend: string) {
  const admin = backend === "postgres" ? new PgClient(postgres!) : undefined;
  const schema = `durable_grouped_${randomUUID().replaceAll("-", "")}`;
  let db: PostgreSQLClient;
  if (admin) {
    (await admin.query(`CREATE SCHEMA ${schema}`))._unsafeUnwrap();
    const url = new URL(postgres!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    db = new PgClient(url.toString());
  } else db = new PGliteClient();
  await initializeBareAuthority(db, orb);
  const authority = new PgDurableAuthority(db, () => 0);
  const owner = (await authority.acquire(orb, "writer", 0, 0, 10))._unsafeUnwrap();
  return {
    db,
    authority,
    owner,
    cleanup: async () => {
      (await db.end())._unsafeUnwrap();
      if (admin) {
        (await admin.query(`DROP SCHEMA ${schema} CASCADE`))._unsafeUnwrap();
        (await admin.end())._unsafeUnwrap();
      }
    },
  };
}

for (const backend of ["pglite", ...(postgres ? ["postgres"] : [])]) {
  it(`${backend}: receipts every grouped batch only after all native/public writes commit, then reopens`, async () => {
    const { db, authority, owner, cleanup } = await fixture(backend);
    try {
      (await db.query("CREATE TABLE grouped_public(seq bigint PRIMARY KEY)"))._unsafeUnwrap();
      const projected: number[] = [];
      const notified: number[] = [];
      const receipts: [number, Seq][] = [];
      let committed = false;
      const storage = (
        await authority.open(owner, {
          project: async (query, writes, seq) => {
            expect(receipts).toEqual([]);
            expect(notified).toEqual([]);
            projected.push(Number(seq));
            expect(writes).toHaveLength(1);
            return (await query("INSERT INTO grouped_public(seq) VALUES($1)", [seq])).map(
              () => undefined,
            );
          },
          afterCommit: (seq) => {
            committed = true;
            notified.push(Number(seq));
          },
        })
      )._unsafeUnwrap();
      const result = await storage.commit(
        [batch(1), batch(2)],
        (index, seq) => {
          expect(committed).toBe(true);
          expect(projected).toHaveLength(2);
          receipts.push([index, seq]);
        },
        ctx,
      );
      expect(result).toEqual({ stored: 2 });
      expect(receipts.map(([index]) => index)).toEqual([0, 1]);
      expect(Number(receipts[1]![1])).toBe(Number(receipts[0]![1]) + 1);
      expect(notified).toEqual(receipts.map(([, seq]) => Number(seq)));
      await storage.close(ctx);
      const reopened = (await authority.read(orb))._unsafeUnwrap();
      expect(await reopened.conversation(1 as ConversationId, ctx)).toEqual({ id: 1 });
      expect(await reopened.conversation(2 as ConversationId, ctx)).toEqual({ id: 2 });
      await reopened.close(ctx);
      expect((await db.query("SELECT * FROM grouped_public"))._unsafeUnwrap().rows).toHaveLength(2);
    } finally {
      await cleanup();
    }
  });

  it(`${backend}: commits and receipts the valid prefix at a native refusal without consuming later IDs or seqs`, async () => {
    const { db, authority, owner, cleanup } = await fixture(backend);
    try {
      (await db.query("CREATE TABLE grouped_prefix(seq bigint PRIMARY KEY)"))._unsafeUnwrap();
      const projected: number[] = [];
      const storage = (
        await authority.open(owner, {
          project: async (query, _writes, seq) => {
            projected.push(Number(seq));
            return (await query("INSERT INTO grouped_prefix(seq) VALUES($1)", [seq])).map(
              () => undefined,
            );
          },
        })
      )._unsafeUnwrap();
      const receive = vi.fn();
      const result = await storage.commit([batch(1), batch(1), batch(999)], receive, ctx);
      expect(result).toMatchObject({ stored: 1 });
      expect(result.refused).toBeDefined();
      expect(receive).toHaveBeenCalledTimes(1);
      expect(receive.mock.calls[0]![0]).toBe(0);
      expect(projected).toHaveLength(1);
      expect((await db.query("SELECT * FROM grouped_prefix"))._unsafeUnwrap().rows).toHaveLength(1);
      expect(await storage.conversation(999 as ConversationId, ctx)).toBeUndefined();
      expect(await storage.mintId()).toBe(2);
      const later = vi.fn();
      expect(await storage.commit([batch(3)], later, ctx)).toEqual({ stored: 1 });
      expect(Number(later.mock.calls[0]![1])).toBe(projected[0]! + 1);
      await storage.close(ctx);
    } finally {
      await cleanup();
    }
  });

  it(`${backend}: rolls the entire group back on a later projection failure, with no receipts or notifications`, async () => {
    const { authority, owner, cleanup } = await fixture(backend);
    try {
      let count = 0;
      const notify = vi.fn();
      const receive = vi.fn();
      const storage = (
        await authority.open(owner, {
          project: async () =>
            ++count === 2
              ? err({ type: "authority_error", code: "projection", message: "injected" })
              : ok(undefined),
          afterCommit: notify,
        })
      )._unsafeUnwrap();
      await expect(storage.commit([batch(1), batch(2)], receive, ctx)).rejects.toBeDefined();
      expect(count).toBe(2);
      expect(receive).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
      expect(await storage.conversation(1 as ConversationId, ctx)).toBeUndefined();
      await storage.close(ctx);
    } finally {
      await cleanup();
    }
  });

  it(`${backend}: rejects a SQL failure during a later batch's native checks rather than returning a prefix refusal`, async () => {
    const { authority, owner, cleanup } = await fixture(backend);
    try {
      let checkReached = false;
      const open = PgStorage.open;
      const spy = vi.spyOn(PgStorage, "open").mockImplementation((sql) =>
        open({
          ...sql,
          transaction: (callback) =>
            sql.transaction((tx) =>
              callback({
                ...tx,
                get: <T>(statement: string, ...values: SqlValue[]) => {
                  if (statement.includes("durable_pg_record_ids") && values[0] === 2) {
                    checkReached = true;
                    return tx.get<T>(
                      "SELECT missing_grouped_column FROM durable_pg_record_ids WHERE orb_id=$1",
                    );
                  }
                  return tx.get<T>(statement, ...values);
                },
              }),
            ),
        }),
      );
      const storage = (
        await authority.open(owner, { project: async () => ok(undefined) })
      )._unsafeUnwrap();
      spy.mockRestore();
      const receive = vi.fn();
      await expect(storage.commit([batch(1), batch(2)], receive, ctx)).rejects.toBeDefined();
      expect(checkReached).toBe(true);
      expect(receive).not.toHaveBeenCalled();
      expect(await storage.conversation(1 as ConversationId, ctx)).toBeUndefined();
      await storage.close(ctx);
    } finally {
      await cleanup();
    }
  });

  it(`${backend}: observer exceptions cannot undo a grouped SQL commit or suppress its durability receipts`, async () => {
    const { authority, owner, cleanup } = await fixture(backend);
    try {
      const notify = vi.fn(() => {
        // biome-ignore lint/plugin/no-throw: inject a third-party observer failure.
        throw new Error("observer failed");
      });
      const storage = (
        await authority.open(owner, {
          project: async () => ok(undefined),
          afterCommit: notify,
        })
      )._unsafeUnwrap();
      const receive = vi.fn();
      expect(await storage.commit([batch(1), batch(2)], receive, ctx)).toEqual({ stored: 2 });
      expect(notify).toHaveBeenCalledTimes(2);
      expect(receive).toHaveBeenCalledTimes(2);
      expect(await storage.conversation(2 as ConversationId, ctx)).toEqual({ id: 2 });
      await storage.close(ctx);
    } finally {
      await cleanup();
    }
  });

  it(`${backend}: an unexpected native-check exception rejects and rolls back the group`, async () => {
    const { authority, owner, cleanup } = await fixture(backend);
    try {
      const storage = (
        await authority.open(owner, { project: async () => ok(undefined) })
      )._unsafeUnwrap();
      const value = {
        get id(): ConversationId {
          // biome-ignore lint/plugin/no-throw: inject an unexpected check exception.
          throw new Error("check bug");
        },
      };
      const receive = vi.fn();
      await expect(
        storage.commit([batch(1), [{ type: "conversation", value }]], receive, ctx),
      ).rejects.toBeDefined();
      expect(receive).not.toHaveBeenCalled();
      expect(await storage.conversation(1 as ConversationId, ctx)).toBeUndefined();
      await storage.close(ctx);
    } finally {
      await cleanup();
    }
  });

  it(`${backend}: a lost COMMIT acknowledgement rejects without inventing a native refusal or notification`, async () => {
    const { db, authority, owner, cleanup } = await fixture(backend);
    try {
      const notify = vi.fn();
      const storage = (
        await authority.open(owner, {
          project: async () => ok(undefined),
          afterCommit: notify,
        })
      )._unsafeUnwrap();
      const transaction = db.transaction.bind(db);
      const spy = vi.spyOn(db, "transaction").mockImplementationOnce((callback) =>
        transaction(callback).andThen(() =>
          errAsync({
            type: "store_error",
            code: "unavailable",
            message: "COMMIT acknowledgement lost",
            retryable: true,
          }),
        ),
      );
      const receive = vi.fn();
      await expect(storage.commit([batch(1), batch(2)], receive, ctx)).rejects.toBeDefined();
      spy.mockRestore();
      expect(receive).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
      // Unknown outcome is not a rollback: independently durable history survives reopen.
      await storage.close(ctx);
      const reopened = (await authority.read(orb))._unsafeUnwrap();
      expect(await reopened.conversation(1 as ConversationId, ctx)).toEqual({ id: 1 });
      expect(await reopened.conversation(2 as ConversationId, ctx)).toEqual({ id: 2 });
      await reopened.close(ctx);
    } finally {
      await cleanup();
    }
  });

  it(`${backend}: receipts already delivered survive a later receiver rejection`, async () => {
    const { authority, owner, cleanup } = await fixture(backend);
    try {
      const storage = (
        await authority.open(owner, { project: async () => ok(undefined) })
      )._unsafeUnwrap();
      const receipts: number[] = [];
      await expect(
        storage.commit(
          [batch(1), batch(2)],
          (index) => {
            receipts.push(index);
            if (index === 1) {
              // biome-ignore lint/plugin/no-throw: inject a third-party receiver failure after durability.
              throw new Error("receiver failed");
            }
          },
          ctx,
        ),
      ).rejects.toThrow("receiver failed");
      expect(receipts).toEqual([0, 1]);
      expect(await storage.conversation(1 as ConversationId, ctx)).toEqual({ id: 1 });
      expect(await storage.conversation(2 as ConversationId, ctx)).toEqual({ id: 2 });
      await storage.close(ctx);
    } finally {
      await cleanup();
    }
  });

  it.each(["throw", "reject"] as const)(
    `${backend}: a post-COMMIT facade %s cannot suppress receipts`,
    async (mode) => {
      const { authority, owner, cleanup } = await fixture(backend);
      try {
        const open = PgStorage.open;
        const observer = vi.fn(() => {
          if (mode === "reject") return Promise.reject(new Error("observer rejected"));
          // biome-ignore lint/plugin/no-throw: inject a synchronous post-durable observer failure.
          throw new Error("observer threw");
        });
        const spy = vi
          .spyOn(PgStorage, "open")
          .mockImplementation((sql) => open({ ...sql, afterCommit: observer }));
        const storage = (
          await authority.open(owner, { project: async () => ok(undefined) })
        )._unsafeUnwrap();
        spy.mockRestore();
        const receive = vi.fn();
        expect(await storage.commit([batch(1), batch(2)], receive, ctx)).toEqual({ stored: 2 });
        expect(observer).toHaveBeenCalledTimes(1);
        expect(receive.mock.calls.map(([index]) => index)).toEqual([0, 1]);
        expect(await storage.conversation(2 as ConversationId, ctx)).toEqual({ id: 2 });
        await storage.close(ctx);
      } finally {
        await cleanup();
      }
    },
  );
}
