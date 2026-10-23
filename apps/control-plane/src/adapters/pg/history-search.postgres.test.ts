import { NoSimulationTask } from "determined";
import { err, ok, ResultAsync } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StoreError } from "../../domain/errors.ts";
import { makeOrbRow, makeProjectRow, seedTestUser, TEST_USER_ID } from "../../testkit/fixtures.ts";
import { openThrowawayPostgres } from "../../testkit/postgres.ts";
import type { StoreContractSubject } from "../../testkit/store-contract.ts";
import type { PostgreSQLClient } from "./client.ts";
import { historySearchContractTests } from "./history-search.contract.ts";
import { backfillHistorySearch, searchHistory } from "./history-search.ts";
import { commitHistoryTransaction } from "./store.ts";

const connectionString = process.env["PI_ORB_TEST_DATABASE_URL"];
if (connectionString === undefined || connectionString === "") {
  describe("PostgreSQL history search", () => {
    it.skip("needs PI_ORB_TEST_DATABASE_URL", () => {});
  });
} else {
  historySearchContractTests("PostgreSQL", () => openThrowawayPostgres(connectionString));
  describe("PostgreSQL history search concurrency", () => {
    const task = new NoSimulationTask("history-search-concurrency", false);
    const projectId = "00000000-0000-4000-8000-000000000021";
    const orbId = "00000000-0000-4000-8000-000000000031";
    const otherId = "00000000-0000-4000-8000-000000000032";
    let subject: StoreContractSubject;
    const deferred = () => {
      let resolve = () => {};
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    };
    const batch = (id = orbId, next = "a", previous: string | null = null) => ({
      orbId: id,
      expectedCursor: previous,
      session: { id: "session", overflow: {} },
      records: [
        {
          id: next,
          parentId: previous,
          timestamp: "2026-10-23T00:00:00.000Z",
          type: "message" as const,
          role: "user" as const,
          content: [{ type: "text" as const, text: "needle" }],
          overflow: {},
        },
      ],
      nextCursor: next,
      nextHeadId: next,
    });
    const params = { ownerUserId: TEST_USER_ID, terms: ["needle"], limit: 10 };
    const blocked = async (fragment: string) => {
      const result = (
        await subject.client.query(
          `SELECT count(*)::integer AS n FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid()
           AND wait_event_type = 'Lock' AND query LIKE $1`,
          [`%${fragment}%`],
        )
      )._unsafeUnwrap();
      return Number(result.rows[0]?.["n"]);
    };
    beforeEach(async () => {
      subject = await openThrowawayPostgres(connectionString);
      (await subject.database.migrate())._unsafeUnwrap();
      (await seedTestUser(task, subject.database.users))._unsafeUnwrap();
      (await subject.database.store.insertProject(task, makeProjectRow(projectId)))._unsafeUnwrap();
      for (const id of [orbId, otherId])
        (
          await subject.database.store.insertOrb(task, makeOrbRow(id, projectId, "running"))
        )._unsafeUnwrap();
    });
    afterEach(async () => {
      (await subject.database.close())._unsafeUnwrap();
    });

    it("does not expose source/index/cursor before the publishing transaction commits", async () => {
      const entered = deferred();
      const release = deferred();
      const publishing = subject.client.transaction(async (query) => {
        const outcome = await commitHistoryTransaction(query, batch());
        entered.resolve();
        await release.promise;
        return outcome;
      });
      try {
        await entered.promise;
        expect((await subject.database.store.searchHistory(task, params))._unsafeUnwrap()).toEqual({
          hits: [],
          documentCount: 0,
          candidateCount: 0,
        });
        expect(
          (await subject.client.query("SELECT * FROM history_search_documents"))._unsafeUnwrap()
            .rows,
        ).toEqual([]);
        expect(
          (await subject.client.query("SELECT * FROM history_records"))._unsafeUnwrap().rows,
        ).toEqual([]);
      } finally {
        release.resolve();
      }
      (await publishing)._unsafeUnwrap();
      expect(
        (await subject.database.store.searchHistory(task, params))._unsafeUnwrap().hits,
      ).toHaveLength(1);
    });

    it("ranks against one statement snapshot while a concurrent commit advances the cursor", async () => {
      (await subject.database.store.commitPullBatch(task, batch()))._unsafeUnwrap();
      const entered = deferred();
      const release = deferred();
      const locker = subject.client.transaction<void, StoreError>(async (query) => {
        const locked = await query("SELECT pg_advisory_xact_lock(9049)");
        if (locked.isErr()) return err(locked.error);
        entered.resolve();
        await release.promise;
        return ok(undefined);
      });
      await entered.promise;
      const observed: PostgreSQLClient = {
        query: (sql, values) =>
          subject.client.query(
            sql
              .replace(
                "scope AS MATERIALIZED (",
                "gate AS MATERIALIZED (SELECT pg_advisory_xact_lock(9049)), scope AS MATERIALIZED (",
              )
              .replace("FROM orbs o JOIN projects", "FROM gate CROSS JOIN orbs o JOIN projects"),
            values,
          ),
        transaction: subject.client.transaction.bind(subject.client),
        end: subject.client.end.bind(subject.client),
      };
      const searching = searchHistory(observed, params);
      try {
        await expect.poll(() => blocked("gate AS MATERIALIZED")).toBe(1);
        (
          await subject.database.store.commitPullBatch(task, batch(orbId, "b", "a"))
        )._unsafeUnwrap();
      } finally {
        release.resolve();
      }
      (await locker)._unsafeUnwrap();
      const snapshot = (await searching)._unsafeUnwrap();
      expect(snapshot.documentCount).toBe(1);
      expect(snapshot.candidateCount).toBe(1);
      expect(snapshot.hits.map((hit) => hit.recordId)).toEqual(["a"]);
      expect(
        (await subject.database.store.searchHistory(task, params))._unsafeUnwrap().documentCount,
      ).toBe(2);
    });

    it("continues after a waited-on committer fills the selected orb, without skipping the next orb", async () => {
      for (const id of [orbId, otherId])
        (await subject.database.store.commitPullBatch(task, batch(id)))._unsafeUnwrap();
      (await subject.client.query("DELETE FROM history_search_documents"))._unsafeUnwrap();
      const entered = deferred();
      const release = deferred();
      const publishing = subject.client.transaction(async (query) => {
        const outcome = await commitHistoryTransaction(query, { ...batch(), expectedCursor: "a" });
        entered.resolve();
        await release.promise;
        return outcome;
      });
      await entered.promise;
      const selectedSizes: number[] = [];
      const observed: PostgreSQLClient = {
        query: subject.client.query.bind(subject.client),
        end: subject.client.end.bind(subject.client),
        transaction: (f) =>
          subject.client.transaction((query, execute) =>
            f(
              (sql, values) =>
                query(sql, values).map((result) => {
                  if (sql.includes("SELECT h.record FROM history_records"))
                    selectedSizes.push(result.rows.length);
                  return result;
                }),
              execute,
            ),
          ),
      };
      const backfilling = backfillHistorySearch(observed);
      try {
        await expect.poll(() => blocked("SELECT o.id FROM orbs o")).toBe(1);
      } finally {
        release.resolve();
      }
      (await publishing)._unsafeUnwrap();
      expect((await backfilling)._unsafeUnwrap()).toBe(1);
      expect(selectedSizes).toEqual([0, 1]);
      expect(
        (await subject.database.store.searchHistory(task, params))._unsafeUnwrap().documentCount,
      ).toBe(2);
    });

    it.each(["archive", "delete"] as const)(
      "serializes backfill with %s through the orb fence",
      async (action) => {
        (await subject.database.store.commitPullBatch(task, batch()))._unsafeUnwrap();
        if (action === "delete")
          (
            await subject.database.store.requestOrbDeletion(task, {
              orbId,
              expectedStateVersion: 0,
              now: 0,
              cleanupAfter: 0,
            })
          )._unsafeUnwrap();
        (await subject.client.query("DELETE FROM history_search_documents"))._unsafeUnwrap();
        const entered = deferred();
        const release = deferred();
        const observed: PostgreSQLClient = {
          query: subject.client.query.bind(subject.client),
          end: subject.client.end.bind(subject.client),
          transaction: (f) =>
            subject.client.transaction((query, execute) =>
              f((sql, values) => {
                const outcome = query(sql, values);
                if (!sql.includes("SELECT h.record FROM history_records")) return outcome;
                return outcome.andThen(
                  (result) =>
                    new ResultAsync(
                      (async () => {
                        entered.resolve();
                        await release.promise;
                        return ok(result);
                      })(),
                    ),
                );
              }, execute),
            ),
        };
        const backfilling = backfillHistorySearch(observed);
        await entered.promise;
        const mutation =
          action === "delete"
            ? subject.database.store.finalizeOrbDeletion(task, { orbId, expectedStateVersion: 1 })
            : subject.database.store.requestOrbArchive(task, {
                orbId,
                expectedStateVersion: 0,
                now: 0,
                cleanupAfter: 0,
              });
        try {
          await expect
            .poll(() =>
              blocked(
                action === "delete"
                  ? "SELECT state, state_version FROM orbs"
                  : "UPDATE orbs SET state = 'archiving'",
              ),
            )
            .toBe(1);
        } finally {
          release.resolve();
        }
        (await backfilling)._unsafeUnwrap();
        (await mutation)._unsafeUnwrap();
        const remaining = (
          await subject.client.query("SELECT * FROM history_search_documents")
        )._unsafeUnwrap().rows;
        expect(remaining).toHaveLength(action === "delete" ? 0 : 1);
        expect(
          (await subject.database.store.searchHistory(task, params))._unsafeUnwrap().documentCount,
        ).toBe(action === "delete" ? 0 : 1);
      },
    );
  });
}
