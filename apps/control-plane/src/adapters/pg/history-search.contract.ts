import assert from "node:assert/strict";
import type { HistoryRecord } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { err, errAsync, ok } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommitPullError, StoreError } from "../../domain/errors.ts";
import { makeOrbRow, makeProjectRow, seedTestUser, TEST_USER_ID } from "../../testkit/fixtures.ts";
import type { StoreContractSubject } from "../../testkit/store-contract.ts";
import { arrayParam } from "./client.ts";
import { backfillHistorySearch, HISTORY_SEARCH_SQL } from "./history-search.ts";
import { runMigrations } from "./migrate.ts";
import { commitHistoryTransaction } from "./store.ts";

const task = new NoSimulationTask("history-search", false);
const PROJECT = "00000000-0000-4000-8000-000000000001";
const OTHER_PROJECT = "00000000-0000-4000-8000-000000000002";
const ORB = "00000000-0000-4000-8000-000000000011";
const SECOND = "00000000-0000-4000-8000-000000000012";
const THIRD = "00000000-0000-4000-8000-000000000013";
const record = (id: string, text: string, parentId: string | null = null): HistoryRecord => ({
  id,
  parentId,
  type: "message",
  role: "user",
  timestamp: "2026-10-23T00:00:00.000Z",
  content: [{ type: "text", text }],
  overflow: {},
});

export function historySearchContractTests(
  name: string,
  open: () => Promise<StoreContractSubject>,
): void {
  describe(`${name} history search`, () => {
    let subject: StoreContractSubject;
    beforeEach(async () => {
      subject = await open();
      (await subject.database.migrate())._unsafeUnwrap();
      (await seedTestUser(task, subject.database.users))._unsafeUnwrap();
      for (const id of [PROJECT, OTHER_PROJECT])
        (await subject.database.store.insertProject(task, makeProjectRow(id)))._unsafeUnwrap();
      for (const [id, projectId] of [
        [ORB, PROJECT],
        [SECOND, PROJECT],
        [THIRD, OTHER_PROJECT],
      ] as const)
        (
          await subject.database.store.insertOrb(task, makeOrbRow(id, projectId, "running"))
        )._unsafeUnwrap();
    });
    afterEach(async () => {
      (await subject.database.close())._unsafeUnwrap();
    });
    const commit = async (
      orbId: string,
      records: HistoryRecord[],
      expectedCursor: string | null = null,
    ) => {
      const last = records.at(-1)?.id ?? expectedCursor;
      assert(last !== null);
      return subject.database.store.commitPullBatch(task, {
        orbId,
        expectedCursor,
        session: { id: `session-${orbId}`, overflow: {} },
        records,
        nextCursor: last,
        nextHeadId: last,
      });
    };
    const search = async (terms: string[], extra = {}) =>
      (
        await subject.database.store.searchHistory(task, {
          ownerUserId: TEST_USER_ID,
          terms,
          limit: 50,
          ...extra,
        })
      )._unsafeUnwrap();

    it("uses all eligible documents and candidates for BM25, ranks before limit, and deduplicates terms", async () => {
      const documents = [
        record("a", "apple banana"),
        record("b", "apple apple apple banana", "a"),
        record("c", "banana", "b"),
        record("d", "orange orange orange orange orange", "c"),
      ];
      (await commit(ORB, documents))._unsafeUnwrap();
      const result = await search(["apple", "apple"], { limit: 1 });
      expect(result.documentCount).toBe(4);
      expect(result.candidateCount).toBe(2);
      expect(result.hits.map((hit) => hit.recordId)).toEqual(["b"]);
      const expected =
        (Math.log(1 + (4 - 2 + 0.5) / (2 + 0.5)) * 3 * 2.2) / (3 + 1.2 * (0.25 + (0.75 * 4) / 3));
      expect(result.hits[0]?.score).toBeCloseTo(expected, 12);
      expect(result.hits[0]).toMatchObject({
        orbId: ORB,
        sessionId: `session-${ORB}`,
        name: null,
        projectName: `project-${PROJECT}`,
        record: documents[1],
      });
    });

    it("scopes both statistics and hits by owner, project and orb, retaining archived history", async () => {
      (await commit(ORB, [record("a", "apple")]))._unsafeUnwrap();
      (await commit(SECOND, [record("b", "orange")]))._unsafeUnwrap();
      (await commit(THIRD, [record("c", "apple apple")]))._unsafeUnwrap();
      (
        await subject.client.query("UPDATE orbs SET state = 'archived' WHERE id = $1", [ORB])
      )._unsafeUnwrap();
      expect((await search(["apple"])).documentCount).toBe(3);
      expect((await search(["apple"], { projectId: PROJECT })).documentCount).toBe(2);
      expect((await search(["apple"], { orbId: ORB })).documentCount).toBe(1);
      expect(
        await search(["apple"], { ownerUserId: "00000000-0000-4000-8000-000000000098" }),
      ).toEqual({ hits: [], documentCount: 0, candidateCount: 0 });
      (
        await subject.client.query("UPDATE orbs SET state = 'deleting' WHERE id = $1", [ORB])
      )._unsafeUnwrap();
      expect((await search(["apple"])).hits.map((hit) => hit.orbId)).toEqual([THIRD]);
      (
        await subject.client.query("UPDATE projects SET state = 'deleting' WHERE id = $1", [
          OTHER_PROJECT,
        ])
      )._unsafeUnwrap();
      expect((await search(["apple"])).hits).toEqual([]);
    });

    it("follows Pi cursor ancestry, not replicated head, while Claude includes every committed branch", async () => {
      const docs = [
        record("root", "visible"),
        record("branch", "needle", "root"),
        record("cursor", "visible", "root"),
      ];
      (await commit(ORB, docs))._unsafeUnwrap();
      (
        await subject.client.query("UPDATE orbs SET replicated_head_id = 'branch' WHERE id = $1", [
          ORB,
        ])
      )._unsafeUnwrap();
      expect(await search(["needle"], { orbId: ORB })).toEqual({
        hits: [],
        documentCount: 2,
        candidateCount: 0,
      });
      (
        await subject.client.query("UPDATE orbs SET harness = 'claude' WHERE id = $1", [ORB])
      )._unsafeUnwrap();
      const result = await search(["needle"], { orbId: ORB });
      expect(result.documentCount).toBe(3);
      expect(result.hits.map((hit) => hit.recordId)).toEqual(["branch"]);
    });

    it("keeps source JSON lossless, excludes hidden and empty documents, and orders ties deterministically", async () => {
      const source = record("a", "needle\u0000\ud800");
      source.overflow = { "\udfff": "\u0000private" };
      const hidden: HistoryRecord = {
        id: "hidden",
        parentId: "a",
        timestamp: source.timestamp,
        type: "event",
        eventType: "custom",
        custom: { customType: "private", display: false },
        content: [{ type: "text", text: "private needle" }],
        overflow: {},
      };
      (
        await commit(ORB, [
          source,
          hidden,
          record("b", "needle", "hidden"),
          record("empty", "", "b"),
        ])
      )._unsafeUnwrap();
      const result = await search(["needle"]);
      expect(result.documentCount).toBe(2);
      expect(result.hits.map((hit) => hit.recordId)).toEqual(["a", "b"]);
      expect(result.hits[0]?.record).toEqual(source);
      expect((await search(["private"])).hits).toEqual([]);
      expect(await search([])).toEqual({ hits: [], documentCount: 0, candidateCount: 0 });
    });

    it("projects atomically, rolls back with the enclosing native transaction, and retries idempotently", async () => {
      const params = {
        orbId: ORB,
        expectedCursor: null,
        session: { id: `session-${ORB}`, overflow: {} },
        records: [record("a", "needle")],
        nextCursor: "a",
        nextHeadId: "a",
      };
      const failed = await subject.client.transaction<void, CommitPullError | { type: "injected" }>(
        async (query) => {
          const committed = await commitHistoryTransaction(query, params);
          return committed.isErr() ? err(committed.error) : err({ type: "injected" as const });
        },
      );
      expect(failed.isErr()).toBe(true);
      expect(
        (await subject.client.query("SELECT * FROM history_search_documents"))._unsafeUnwrap().rows,
      ).toEqual([]);
      expect((await search(["needle"])).hits).toEqual([]);
      (await subject.database.store.commitPullBatch(task, params))._unsafeUnwrap();
      (
        await subject.database.store.commitPullBatch(task, { ...params, expectedCursor: "a" })
      )._unsafeUnwrap();
      expect(
        (await subject.client.query("SELECT * FROM history_search_documents"))._unsafeUnwrap().rows,
      ).toHaveLength(1);
      const conflict = await subject.database.store.commitPullBatch(task, {
        ...params,
        expectedCursor: "a",
        records: [record("a", "different")],
      });
      expect(conflict.isErr()).toBe(true);
      expect((await search(["needle"])).hits).toHaveLength(1);
    });

    it("reports index-stage failures and rolls back source publication", async () => {
      (
        await subject.client.query(
          "ALTER TABLE history_search_documents ADD CONSTRAINT injected_failure CHECK (token_count = 0)",
        )
      )._unsafeUnwrap();
      const result = await commit(ORB, [record("a", "needle")]);
      expect(result.isErr()).toBe(true);
      if (result.isErr())
        expect("message" in result.error && result.error.message).toContain("history-search index");
      expect(
        (await subject.client.query("SELECT * FROM history_records"))._unsafeUnwrap().rows,
      ).toEqual([]);
      expect(
        (await subject.database.store.getOrb(task, ORB))._unsafeUnwrap()?.replicationCursor,
      ).toBeNull();
    });

    it("backfills bounded atomic batches, resumes migration once, marks empty records and cascades deletion", async () => {
      const docs = Array.from({ length: 503 }, (_, i) =>
        record(
          `r-${String(i).padStart(4, "0")}`,
          i % 2 ? "needle" : "",
          i ? `r-${String(i - 1).padStart(4, "0")}` : null,
        ),
      );
      (await commit(ORB, docs))._unsafeUnwrap();
      (await subject.client.query("DELETE FROM history_search_documents"))._unsafeUnwrap();
      (
        await subject.client.query(
          "DELETE FROM schema_migrations WHERE name = '049_history_search.sql'",
        )
      )._unsafeUnwrap();
      let inserts = 0;
      const failure: StoreError = {
        type: "store_error",
        code: "unavailable",
        retryable: true,
        message: "injected",
      };
      const transaction = subject.client.transaction.bind(subject.client);
      const interrupted = {
        query: subject.client.query.bind(subject.client),
        end: subject.client.end.bind(subject.client),
        transaction: ((f: Parameters<typeof transaction>[0]) =>
          transaction((query, execute) =>
            f(
              (sql, values) =>
                /INSERT INTO history_search_documents/u.test(sql) && ++inserts === 502
                  ? errAsync(failure)
                  : query(sql, values),
              execute,
            ),
          )) as typeof transaction,
      };
      expect((await runMigrations(interrupted)).isErr()).toBe(true);
      expect(
        (await subject.client.query("SELECT * FROM history_search_documents"))._unsafeUnwrap().rows,
      ).toHaveLength(500);
      expect(
        (
          await subject.client.query(
            "SELECT * FROM schema_migrations WHERE name = '049_history_search.sql'",
          )
        )._unsafeUnwrap().rows,
      ).toEqual([]);
      expect((await runMigrations(subject.client))._unsafeUnwrap()).toEqual([
        "049_history_search.sql",
      ]);
      expect(
        (await subject.client.query("SELECT * FROM history_search_documents"))._unsafeUnwrap().rows,
      ).toHaveLength(503);
      expect((await runMigrations(subject.client))._unsafeUnwrap()).toEqual([]);
      expect((await backfillHistorySearch(subject.client))._unsafeUnwrap()).toBe(0);
      expect((await search(["needle"])).documentCount).toBe(251);
      (
        await subject.client.query(
          "UPDATE orbs SET replication_cursor = NULL, replicated_head_id = NULL",
        )
      )._unsafeUnwrap();
      (
        await subject.client.query("DELETE FROM history_records WHERE orb_id = $1", [ORB])
      )._unsafeUnwrap();
      expect(
        (await subject.client.query("SELECT * FROM history_search_documents"))._unsafeUnwrap().rows,
      ).toEqual([]);
    });

    it("supports the GIN jsonb_ops candidate operator in the actual ranked query plan", async () => {
      (await commit(ORB, [record("a", "needle")]))._unsafeUnwrap();
      // A one-row fixture correctly favors the orb PK; model a selective term in a larger scope.
      (
        await subject.client.query(
          `INSERT INTO history_records (orb_id, record_id, parent_id, record)
         SELECT $1, 'hay-' || n, NULL, json_build_object('id', 'hay-' || n, 'parentId', NULL,
           'type', 'message', 'role', 'user', 'timestamp', '2026-10-23T00:00:00.000Z',
           'content', json_build_array(json_build_object('type', 'text', 'text', 'haystack')), 'overflow', '{}')
         FROM generate_series(1, 2000) n`,
          [ORB],
        )
      )._unsafeUnwrap();
      (await backfillHistorySearch(subject.client))._unsafeUnwrap();
      (await subject.client.query("ANALYZE history_search_documents"))._unsafeUnwrap();
      const index = (
        await subject.client.query(
          "SELECT indexdef FROM pg_indexes WHERE indexname = 'history_search_documents_terms_idx'",
        )
      )._unsafeUnwrap().rows[0]?.["indexdef"];
      expect(index).toContain("USING gin (term_frequencies)");
      const explained = await subject.client.transaction(async (query) => {
        const set = await query("SET LOCAL enable_seqscan = off");
        if (set.isErr()) return err(set.error);
        const result = await query(`EXPLAIN (FORMAT JSON) ${HISTORY_SEARCH_SQL}`, [
          TEST_USER_ID,
          null,
          null,
          arrayParam(["needle"]),
          10,
        ]);
        return result.isErr() ? err(result.error) : ok(result.value.rows);
      });
      expect(explained.isOk()).toBe(true);
      expect(JSON.stringify(explained._unsafeUnwrap())).toContain(
        "history_search_documents_terms_idx",
      );
    });
  });
}
