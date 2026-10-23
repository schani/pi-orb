import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { NoSimulationTask } from "determined";
import { ResultAsync } from "neverthrow";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { makeOrbRow, makeProjectRow } from "../../testkit/fixtures.ts";
import { composeControlPlaneDatabase } from "../database.ts";
import { jsonParam, mapPgError, PgClient } from "./client.ts";
import { runMigrations } from "./migrate.ts";

const migration = "044_lossless_history_json.sql";
const searchMigration = "049_history_search.sql";

// Real relation locks, not PGlite; sessions and backoff gates belong to each schema.
export function historyMigrationContractTests(label: string, connectionString: () => string) {
  describe(`${label} history migration lock order`, () => {
    it.each([
      { name: "snapshot commit", held: "orbs", outcome: "commit" },
      {
        name: "history commit releases partial orbs lock",
        held: "history_records",
        outcome: "commit",
      },
      { name: "mixed-order three-session commit", held: "orbs", outcome: "commit", mixed: true },
      { name: "exhaustion before DDL", held: "history_records", outcome: "exhaustion" },
      { name: "ledger rollback", held: "orbs", outcome: "rollback" },
    ])("$name", async ({ name, held, outcome, mixed }) => {
      const schema = `history_migration_${randomUUID().replaceAll("-", "")}`;
      const url = new URL(connectionString());
      url.searchParams.set(
        "options",
        `-c search_path=${schema},pg_catalog -c statement_timeout=10000`,
      );
      url.searchParams.set("application_name", schema);
      const client = new PgClient(url.toString());
      const reader = new pg.Client({ connectionString: url.toString() });
      const query = (sql: string, values: unknown[] = []) =>
        ResultAsync.fromPromise(reader.query(sql, values), mapPgError);
      const stages: string[] = [];
      let pending: ReturnType<typeof runMigrations> | undefined;
      let inverse: pg.Client | undefined;
      let schemaOid: number | undefined;
      try {
        (await ResultAsync.fromPromise(reader.connect(), mapPgError))._unsafeUnwrap();
        (await query(`CREATE SCHEMA ${schema}`))._unsafeUnwrap();
        (
          await client.query(
            "CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
          )
        )._unsafeUnwrap();
        (
          await client.query("INSERT INTO schema_migrations (name) VALUES ($1), ($2)", [
            migration,
            searchMigration,
          ])
        )._unsafeUnwrap();
        (await runMigrations(client))._unsafeUnwrap();

        const database = composeControlPlaneDatabase(client);
        const task = new NoSimulationTask("history migration", false);
        const project = makeProjectRow(randomUUID());
        const orb = makeOrbRow(randomUUID(), project.id, "stopped");
        (
          await database.users.resolveUser(
            task,
            { issuer: "test", subject: "owner", email: null },
            { id: project.ownerUserId, now: 0 },
          )
        )._unsafeUnwrap();
        (await database.store.insertProject(task, project))._unsafeUnwrap();
        (await database.store.insertOrb(task, orb))._unsafeUnwrap();
        const session = { id: "migration-session", overflow: { retained: true } };
        const record = {
          id: "migration-record",
          parentId: null,
          timestamp: "2026-10-13T00:00:00.000Z",
          type: "message",
          role: "user",
          content: [{ type: "text", text: "retained" }],
          overflow: { nested: { retained: true } },
        };
        (
          await client.query(
            "UPDATE orbs SET harness_session_id=$2, harness_session_header=$3::jsonb WHERE id=$1",
            [orb.id, session.id, jsonParam(session)],
          )
        )._unsafeUnwrap();
        (
          await client.query(
            "INSERT INTO history_records (orb_id, record_id, parent_id, record) VALUES ($1,$2,NULL,$3::jsonb)",
            [orb.id, record.id, jsonParam(record)],
          )
        )._unsafeUnwrap();
        (
          await client.query("DELETE FROM schema_migrations WHERE name IN ($1, $2)", [
            migration,
            searchMigration,
          ])
        )._unsafeUnwrap();
        if (outcome === "rollback") {
          // Fail after both ALTERs, at the runner's ledger INSERT.
          (
            await client.query(`ALTER TABLE schema_migrations ADD CHECK (name <> '${migration}')`)
          )._unsafeUnwrap();
        }

        schemaOid = Number(
          (await query("SELECT oid FROM pg_namespace WHERE nspname=$1", [schema]))._unsafeUnwrap()
            .rows[0]?.["oid"],
        );
        (
          await query(`CREATE SEQUENCE backoff_calls;
              CREATE FUNCTION pg_sleep(seconds double precision) RETURNS void LANGUAGE plpgsql AS $$
              BEGIN
                IF seconds <> 0.25 THEN RAISE EXCEPTION 'unexpected backoff'; END IF;
                PERFORM nextval('backoff_calls');
                PERFORM pg_advisory_xact_lock(${schemaOid}, 44);
              END $$;`)
        )._unsafeUnwrap();
        (await query("SELECT pg_advisory_lock($1,44)", [schemaOid]))._unsafeUnwrap();
        (await query("BEGIN"))._unsafeUnwrap();
        (await query(`SELECT * FROM ${held}`))._unsafeUnwrap();
        pending = runMigrations(client, {
          observe: (name, stage) => stages.push(`${name}:${stage}`),
        });

        // Shadow only this schema's unqualified pg_sleep. Observe the owned
        // advisory wait after contention rollback, without elapsed-time barriers.
        const deadline = performance.now() + 5_000;
        let locks: pg.QueryResultRow[] = [];
        while (performance.now() < deadline) {
          locks = (
            await query(
              `SELECT l.locktype, c.relname AS relation, l.mode, l.granted
                   FROM pg_locks l
                   LEFT JOIN pg_class c ON c.oid=l.relation
                   JOIN pg_stat_activity a ON a.pid=l.pid
                  WHERE a.application_name=$1 AND l.pid <> pg_backend_pid()
                    AND (l.locktype='advisory' OR
                      (c.relnamespace=current_schema()::regnamespace
                        AND c.relname IN ('orbs', 'history_records')))
                  ORDER BY c.relname, l.mode`,
              [schema],
            )
          )._unsafeUnwrap().rows;
          if (locks.some((lock) => lock["granted"] === false)) break;
        }
        console.info(
          JSON.stringify({ event: "history-migration-backoff-checkpoint", name, locks }),
        );
        expect(locks).toEqual([
          { locktype: "advisory", relation: null, mode: "ExclusiveLock", granted: false },
        ]);
        if (mixed) {
          // The already-live inverse-order SELECT must not queue behind migration.
          inverse = new pg.Client({ connectionString: url.toString() });
          (await ResultAsync.fromPromise(inverse.connect(), mapPgError))._unsafeUnwrap();
          const sql = readFileSync(new URL("./store.ts", import.meta.url), "utf8").match(
            /`(SELECT h\.record FROM history_records h JOIN orbs o ON o\.id = h\.orb_id[\s\S]*?)`/u,
          )?.[1];
          expect(sql).toBeDefined();
          const selected = await ResultAsync.fromPromise(
            inverse.query(sql ?? "", [orb.id, record.id, session.id]),
            mapPgError,
          );
          expect(selected._unsafeUnwrap().rows).toEqual([{ record }]);
        }

        // The snapshot can still finish its history access during backoff.
        expect(
          (
            await query("SELECT record FROM history_records WHERE orb_id=$1", [orb.id])
          )._unsafeUnwrap().rows,
        ).toEqual([{ record }]);
        expect(stages).toEqual([`${migration}:started`]);
        if (outcome !== "exhaustion") (await query("COMMIT"))._unsafeUnwrap();
        (await query("SELECT pg_advisory_unlock($1,44)", [schemaOid]))._unsafeUnwrap();
        const migrated = await pending;
        // Exhaustion leaves the reader open until every NOWAIT attempt fails.
        (await query("ROLLBACK"))._unsafeUnwrap();
        expect((await query("SELECT last_value FROM backoff_calls"))._unsafeUnwrap().rows).toEqual([
          { last_value: outcome === "exhaustion" ? "119" : "1" },
        ]);
        if (outcome === "commit") {
          expect(migrated._unsafeUnwrap()).toEqual([migration, searchMigration]);
          expect(stages).toEqual([
            `${migration}:started`,
            `${migration}:applied`,
            `${searchMigration}:started`,
            `${searchMigration}:applied`,
          ]);
        } else {
          expect(migrated.isErr() && migrated.error.sqlState).toBe(
            outcome === "exhaustion" ? "55P03" : "23514",
          );
          expect(stages).toEqual([`${migration}:started`]);
        }
        expect(
          (
            await query(
              "SELECT pg_typeof(record)::text AS record_type, pg_typeof(harness_session_header)::text AS session_type, record, harness_session_header AS session FROM history_records JOIN orbs ON orbs.id=orb_id WHERE orbs.id=$1",
              [orb.id],
            )
          )._unsafeUnwrap().rows,
        ).toEqual([
          {
            record_type: outcome === "commit" ? "json" : "jsonb",
            session_type: outcome === "commit" ? "json" : "jsonb",
            record,
            session,
          },
        ]);
        expect(
          (
            await query("SELECT name FROM schema_migrations WHERE name IN ($1, $2) ORDER BY name", [
              migration,
              searchMigration,
            ])
          )._unsafeUnwrap().rows,
        ).toEqual(outcome === "commit" ? [{ name: migration }, { name: searchMigration }] : []);
        expect(
          (
            await query(
              "SELECT indexname FROM pg_indexes WHERE schemaname=current_schema() AND indexname='history_records_search_idx'",
            )
          )._unsafeUnwrap().rows,
        ).toEqual(outcome === "commit" ? [{ indexname: "history_records_search_idx" }] : []);
        const constraints = (
          await query(
            `SELECT conname FROM pg_constraint
                WHERE connamespace=current_schema()::regnamespace
                  AND conname IN ('history_records_check', 'history_records_check1', 'orbs_check1')
                ORDER BY conname`,
          )
        )._unsafeUnwrap().rows;
        expect(constraints).toEqual(
          outcome === "commit"
            ? []
            : [
                { conname: "history_records_check" },
                { conname: "history_records_check1" },
                { conname: "orbs_check1" },
              ],
        );
      } finally {
        // Release only our reader before draining our migration; no backend kills.
        await query("ROLLBACK");
        if (schemaOid !== undefined) await query("SELECT pg_advisory_unlock($1,44)", [schemaOid]);
        if (pending !== undefined) await pending;
        if (inverse !== undefined) await ResultAsync.fromPromise(inverse.end(), mapPgError);
        (await client.end())._unsafeUnwrap();
        await query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        (await ResultAsync.fromPromise(reader.end(), mapPgError))._unsafeUnwrap();
      }
    });
  });
}
