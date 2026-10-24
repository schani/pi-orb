import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type {
  ConversationId,
  DocumentCreate,
  DocumentId,
  EntryId,
  Storage,
  SubmissionId,
  TaskId,
} from "@earendil-works/pi-durable";
import { ok } from "neverthrow";
import { expect, it, onTestFinished, vi } from "vitest";
import { makeOrbRow } from "../../testkit/fixtures.ts";
import { PgClient, type PostgreSQLClient } from "../pg/client.ts";
import { PGliteClient } from "../pg/pglite-client.ts";
import { initializeBareAuthority } from "./bare-authority.testkit.ts";
import type { SqlExecutor, SqlValue } from "./executor.ts";
import { PgDurableAuthority } from "./index.ts";
import { PgStorage } from "./storage.ts";

const postgres = process.env.PI_ORB_DURABLE_PG_TEST_URL;
const orbs = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000003",
] as const;
const root = 1 as ConversationId;
const child = 2 as ConversationId;
const taskId = 20 as TaskId<string>;
const documentId = 40 as DocumentId;
const copyId = 43 as DocumentId;
const latestId = 42 as DocumentId;
const worker = "worker?'";

/** Observe PgStorage's input to the executor, not a translated database statement. */
function recordSql(db: SqlExecutor, statements: string[]): SqlExecutor {
  return {
    ...db,
    get: <T>(sql: string, ...values: SqlValue[]) => {
      statements.push(sql);
      return db.get<T>(sql, ...values);
    },
    all: <T>(sql: string, ...values: SqlValue[]) => {
      statements.push(sql);
      return db.all<T>(sql, ...values);
    },
    run: (sql, ...values) => {
      statements.push(sql);
      return db.run(sql, ...values);
    },
  };
}

async function fixture(backend: string) {
  const schema = `durable_native_${randomUUID().replaceAll("-", "")}`;
  const admin = backend === "postgres" ? new PgClient(postgres!) : undefined;
  if (admin) {
    onTestFinished(async () => {
      (await admin.end())._unsafeUnwrap();
    });
  }
  let db: PostgreSQLClient;
  if (admin) {
    (await admin.query(`CREATE SCHEMA ${schema}`))._unsafeUnwrap();
    onTestFinished(async () => {
      (await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`))._unsafeUnwrap();
    });
    const url = new URL(postgres!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    db = new PgClient(url.toString());
  } else db = new PGliteClient();
  onTestFinished(async () => {
    (await db.end())._unsafeUnwrap();
  });
  const { task, database, project } = await initializeBareAuthority(db, orbs[0]);
  (
    await database.store.insertOrb(task, makeOrbRow(orbs[1], project.id, "running"))
  )._unsafeUnwrap();

  const statements: string[] = [];
  const open = PgStorage.open;
  const spy = vi.spyOn(PgStorage, "open").mockImplementation((sql) =>
    open({
      ...sql,
      ...recordSql(sql, statements),
      transaction: (callback) => sql.transaction((tx) => callback(recordSql(tx, statements))),
    }),
  );
  onTestFinished(() => spy.mockRestore());
  const authority = new PgDurableAuthority(db, () => 0);
  const storages: Storage[] = [];
  for (const orb of orbs) {
    const owner = (await authority.acquire(orb, "writer", 0, 0, 1000))._unsafeUnwrap();
    const storage = (
      await authority.open(owner, { project: async () => ok(undefined) })
    )._unsafeUnwrap();
    onTestFinished(() => storage.close(ctx));
    storages.push(storage);
  }
  return { statements, a: storages[0]!, b: storages[1]! };
}

function doc(id: DocumentId, key: string, conversationId = root) {
  return {
    id,
    kind: "tenant",
    key,
    scope: { kind: "conversation", conversationId },
    history: "rewindable",
    fork: "asOf",
  } satisfies DocumentCreate;
}

function pending(id: TaskId<string>, tenant: string) {
  return {
    id,
    conversationId: root,
    kind: worker,
    version: 1,
    input: tenant,
    background: false,
    abortRequested: false,
    state: { status: "pending" as const, checkpoint: null },
  };
}

for (const backend of ["pglite", ...(postgres ? ["postgres"] : [])]) {
  it(`${backend}: emits native SQL and isolates colliding IDs through scans, upserts, revisions and copies`, async () => {
    const { a, b, statements } = await fixture(backend);
    const initial = [];
    for (const [storage, tenant] of [
      [a, "a"],
      [b, "b"],
    ] as const) {
      const seq = await storage.commit(
        [
          { type: "conversation", value: { id: root } },
          { type: "conversation", value: { id: child, owner: { conversationId: root, taskId } } },
          ...[10, 11, 12].map((id) => ({
            type: "entry" as const,
            value: {
              id: id as EntryId,
              conversationId: root,
              kind: "message",
              data: tenant,
              ...(id === 11 ? { head: 10 as EntryId } : {}),
            },
          })),
          ...[20, 21].map((id) => ({
            type: "task" as const,
            value: pending(id as TaskId<string>, tenant),
          })),
          { type: "task", value: { ...pending(22 as TaskId<string>, tenant), kind: "excluded" } },
          ...[30, 31].map((id) => ({
            type: "submission" as const,
            value: {
              id: id as SubmissionId,
              conversationId: root,
              requestId: `request?'${id}`,
              type: "input" as const,
              status: "queued" as const,
            },
          })),
          ...[40, 41].map((id) => ({
            type: "document.create" as const,
            record: doc(id as DocumentId, `key?${id}`),
            content: { kind: "base" as const, version: 1, value: { tenant, count: 0 } },
          })),
          {
            type: "document.create",
            record: { ...doc(latestId, "latest"), history: "latest", fork: "current" },
            content: { kind: "base", version: 1, value: { tenant } },
          },
        ],
        ctx,
      );
      initial.push(seq);
      expect(seq).toBeGreaterThan(0);
      expect(await storage.conversation(root, ctx)).toEqual({ id: root });
      expect(await storage.entry(10 as EntryId, ctx)).toMatchObject({
        entry: { id: 10, data: tenant },
        commitSeq: seq,
      });
      expect(await storage.findLatestHeadMarker(root, undefined, ctx)).toMatchObject({
        id: 11,
        data: tenant,
      });
      expect(await storage.findLatestHeadMarker(root, 10 as EntryId, ctx)).toBeUndefined();
      expect(await storage.task(taskId, ctx)).toEqual(pending(taskId, tenant));
      expect(await storage.submissionByRequest(root, "request?'30", ctx)).toEqual(
        await storage.submission(30 as SubmissionId, ctx),
      );
      expect(await storage.submission(30 as SubmissionId, ctx)).toMatchObject({
        id: 30,
        status: "queued",
      });
      expect((await storage.document(documentId, "current", ctx))?.value).toEqual({
        tenant,
        count: 0,
      });
      expect(await storage.findDocument(doc(documentId, "key?40"), seq, ctx)).toMatchObject({
        id: documentId,
      });

      expect(
        (
          await storage.scanConversations(
            { ownerConversationId: root, ownerTaskId: taskId },
            1,
            undefined,
            ctx,
          )
        ).items,
      ).toEqual([{ id: child, owner: { conversationId: root, taskId } }]);
      for (const order of ["ascending", "descending"] as const) {
        const query = {
          conversationId: root,
          minEntryId: 10 as EntryId,
          maxEntryId: 11 as EntryId,
          order,
        };
        const first = await storage.scanEntries(query, 1, undefined, ctx);
        expect(first.items.map((entry) => entry.id)).toEqual([order === "ascending" ? 10 : 11]);
        expect(first.next).toBeDefined();
        const second = await storage.scanEntries(query, 1, first.next, ctx);
        expect(second.items.map((entry) => entry.id)).toEqual([order === "ascending" ? 11 : 10]);
        expect(second.next).toBeUndefined();
      }
      const query = {
        conversationId: root,
        kind: worker,
        status: "pending" as const,
        background: false,
        abortRequested: false,
      };
      const first = await storage.scanTasks(query, 1, undefined, ctx);
      expect(first.items).toEqual([pending(taskId, tenant)]);
      expect(first.next).toBeDefined();
      expect((await storage.scanTasks(query, 1, first.next, ctx)).items).toEqual([
        pending(21 as TaskId<string>, tenant),
      ]);
      const submissions = { conversationId: root, status: "queued" as const };
      const inputPage = await storage.scanSubmissions(submissions, 1, undefined, ctx);
      expect(inputPage.items.map((input) => input.id)).toEqual([30]);
      expect(inputPage.next).toBeDefined();
      expect(
        (await storage.scanSubmissions(submissions, 1, inputPage.next, ctx)).items.map(
          (input) => input.id,
        ),
      ).toEqual([31]);
      const documents = {
        scope: { kind: "conversation" as const, conversationId: root },
        kind: "tenant",
        at: seq,
      };
      const docPage = await storage.scanDocuments(documents, 1, undefined, ctx);
      expect(docPage.items.map((record) => record.id)).toEqual([40]);
      expect(docPage.next).toBeDefined();
      expect(
        (await storage.scanDocuments(documents, 1, docPage.next, ctx)).items.map(
          (record) => record.id,
        ),
      ).toEqual([41]);
    }
    expect(initial[0]).toBe(initial[1]);

    const originalB = await b.document(documentId, "current", ctx);
    expect(originalB?.value).toEqual({ tenant: "b", count: 0 });
    const changed = await a.commit(
      [
        { type: "task", value: { ...pending(taskId, "a"), abortRequested: true } },
        {
          type: "submission",
          value: {
            id: 30 as SubmissionId,
            conversationId: root,
            requestId: "request?'30",
            type: "input",
            status: "placed",
            entry: 10 as EntryId,
          },
        },
        {
          type: "document.change",
          id: documentId,
          content: { kind: "delta", version: 1, ops: [["s", ["count"], 1]] },
        },
        {
          type: "document.change",
          id: latestId,
          content: { kind: "base", version: 2, value: { tenant: "a", replaced: true } },
        },
      ],
      ctx,
    );
    expect(changed).toBeGreaterThan(initial[0]!);
    expect(await a.task(taskId, ctx)).toMatchObject({ abortRequested: true });
    expect(await b.task(taskId, ctx)).toEqual(pending(taskId, "b"));
    expect(await a.submission(30 as SubmissionId, ctx)).toMatchObject({ status: "placed" });
    expect(await b.submission(30 as SubmissionId, ctx)).toMatchObject({ status: "queued" });
    expect(await b.submissionByRequest(root, "request?'30", ctx)).toMatchObject({
      status: "queued",
    });
    expect((await a.document(documentId, "current", ctx))?.value).toEqual({
      tenant: "a",
      count: 1,
    });
    expect((await a.document(documentId, initial[0]!, ctx))?.value).toEqual({
      tenant: "a",
      count: 0,
    });
    expect(await b.document(documentId, "current", ctx)).toEqual(originalB);
    expect((await b.document(latestId, "current", ctx))?.value).toEqual({ tenant: "b" });

    for (const [storage, at] of [
      [a, initial[0]!],
      [b, "current"],
    ] as const) {
      await storage.commit(
        [
          {
            type: "document.copy",
            record: doc(copyId, "key?40", child),
            source: { id: documentId, at },
          },
        ],
        ctx,
      );
    }
    expect((await a.document(copyId, "current", ctx))?.value).toEqual({ tenant: "a", count: 0 });
    expect((await b.document(copyId, "current", ctx))?.value).toEqual({ tenant: "b", count: 0 });
    await a.commit(
      [
        { type: "document.retire", id: documentId },
        { type: "document.retire", id: latestId },
      ],
      ctx,
    );
    expect(await a.document(documentId, "current", ctx)).toBeUndefined();
    expect(await a.findDocument(doc(documentId, "key?40"), "current", ctx)).toBeUndefined();
    expect(await b.document(documentId, "current", ctx)).toEqual(originalB);
    expect((await b.document(latestId, "current", ctx))?.value).toEqual({ tenant: "b" });

    expect(statements.length).toBeGreaterThan(0);
    for (const sql of statements) {
      expect(sql, "PgStorage must emit native placeholders").not.toContain("?");
      expect(sql).not.toMatch(/INSERT OR IGNORE/i);
      const tables = [
        ...sql.matchAll(/\b(?:FROM|INTO)\s+(\w+)/gi),
        ...sql.matchAll(/^\s*UPDATE\s+(\w+)/gi),
      ].map((match) => match[1]);
      expect(tables.length).toBeGreaterThan(0);
      for (const table of tables) expect(table).toMatch(/^durable_pg_/);
      if (/^\s*INSERT/i.test(sql)) {
        expect(sql).toMatch(/\(\s*orb_id\s*,/i);
        expect(sql).toMatch(/VALUES\s*\(\s*\$1\b/i);
      } else expect(sql).toMatch(/\borb_id\s*=\s*\$1\b/i);
    }
  });
}
