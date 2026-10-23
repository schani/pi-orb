import { NoSimulationTask } from "determined";
import { describe, expect, it } from "vitest";
import { makeOrbRow, makeProjectRow, TEST_USER_ID } from "../../testkit/fixtures.ts";
import { openThrowawayPostgres } from "../../testkit/postgres.ts";
import { composeControlPlaneDatabase } from "../database.ts";
import { jsonParam } from "./client.ts";
import { PGliteClient } from "./pglite-client.ts";

const task = new NoSimulationTask("orb harness migration", false);

const url = process.env["PI_ORB_TEST_DATABASE_URL"];
describe.each(["PGlite", ...(url ? ["PostgreSQL"] : [])])("%s orb harness migration", (driver) => {
  it("defaults existing orbs to Pi and persists Claude across state changes", async () => {
    const subject =
      driver === "PostgreSQL"
        ? await openThrowawayPostgres(url ?? "")
        : (() => {
            const client = new PGliteClient();
            return { client, database: composeControlPlaneDatabase(client) };
          })();
    const { client, database } = subject;
    try {
      (
        await client.query(
          "CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
        )
      )._unsafeUnwrap();
      (
        await client.query(
          "INSERT INTO schema_migrations (name) VALUES ('044_lossless_history_json.sql'), ('049_history_search.sql')",
        )
      )._unsafeUnwrap();
      expect((await database.migrate()).isOk()).toBe(true);
      const project = makeProjectRow("00000000-0000-4000-8000-000000000011");
      const orb = makeOrbRow("00000000-0000-4000-8000-000000000012", project.id, "creating");
      expect(
        (
          await client.query(
            "INSERT INTO users (id, identity_issuer, identity_subject, created_at, updated_at) VALUES ($1, 'test', 'owner', now(), now())",
            [TEST_USER_ID],
          )
        ).isOk(),
      ).toBe(true);
      expect((await database.store.insertProject(task, project)).isOk()).toBe(true);
      expect((await database.store.insertOrb(task, orb)).isOk()).toBe(true);
      expect((await client.query("ALTER TABLE orbs DROP COLUMN harness")).isOk()).toBe(true);
      expect(
        (
          await client.query("DELETE FROM schema_migrations WHERE name = '029_orb_harness.sql'")
        ).isOk(),
      ).toBe(true);
      expect((await database.migrate())._unsafeUnwrap()).toEqual(["029_orb_harness.sql"]);
      expect((await database.store.getOrb(task, orb.id))._unsafeUnwrap()?.harness).toBe("pi");
      (await client.query("ALTER TABLE orbs DROP COLUMN initial_model"))._unsafeUnwrap();
      (
        await client.query("DELETE FROM schema_migrations WHERE name = '046_orb_initial_model.sql'")
      )._unsafeUnwrap();
      expect((await database.migrate())._unsafeUnwrap()).toEqual(["046_orb_initial_model.sql"]);
      expect((await database.store.getOrb(task, orb.id))._unsafeUnwrap()?.initialModel).toBeNull();
      for (const invalid of [
        null,
        [],
        {},
        { provider: "", id: "opus" },
        { provider: "claude", id: "" },
        { provider: "claude", id: "opus", extra: true },
        { provider: 1, id: "opus" },
      ])
        expect(
          (
            await client.query("UPDATE orbs SET initial_model=$2::jsonb WHERE id=$1", [
              orb.id,
              JSON.stringify(invalid),
            ])
          ).isErr(),
        ).toBe(true);
      const initialModel = { provider: "claude", id: "sonnet" };
      (
        await client.query("UPDATE orbs SET initial_model=$2::jsonb WHERE id=$1", [
          orb.id,
          jsonParam(initialModel),
        ])
      )._unsafeUnwrap();
      expect((await database.store.getOrb(task, orb.id))._unsafeUnwrap()?.initialModel).toEqual(
        initialModel,
      );
      const claude = {
        ...orb,
        id: "00000000-0000-4000-8000-000000000013",
        harness: "claude" as const,
      };
      expect((await database.store.insertOrb(task, claude)).isOk()).toBe(true);
      for (const state of ["starting", "running", "stopping", "stopped", "starting"]) {
        expect(
          (
            await client.query("UPDATE orbs SET state = $2 WHERE id = $1", [claude.id, state])
          ).isOk(),
        ).toBe(true);
        expect((await database.store.getOrb(task, claude.id))._unsafeUnwrap()?.harness).toBe(
          "claude",
        );
      }
      expect(
        (
          await client.query("UPDATE orbs SET harness = 'unknown' WHERE id = $1", [claude.id])
        ).isErr(),
      ).toBe(true);
      const session = { id: "migrated-session", overflow: { nested: "retained" } };
      const record = {
        id: "migrated-record",
        parentId: null,
        timestamp: "2026-10-13T00:00:00.000Z",
        type: "message",
        role: "user",
        content: [{ type: "text", text: "retained" }],
        overflow: { native: { retained: true } },
      };
      (
        await client.query(
          "UPDATE orbs SET harness_session_id=$2, harness_session_header=$3::jsonb WHERE id=$1",
          [orb.id, session.id, jsonParam(session)],
        )
      )._unsafeUnwrap();
      (
        await client.query(
          "INSERT INTO history_records (orb_id,record_id,parent_id,record) VALUES ($1,$2,NULL,$3::jsonb)",
          [orb.id, record.id, jsonParam(record)],
        )
      )._unsafeUnwrap();
      (
        await client.query(
          "UPDATE orbs SET replication_cursor=$2, replicated_head_id=$2 WHERE id=$1",
          [orb.id, record.id],
        )
      )._unsafeUnwrap();
      (
        await client.query(
          "DELETE FROM schema_migrations WHERE name='044_lossless_history_json.sql'",
        )
      )._unsafeUnwrap();
      expect((await database.migrate())._unsafeUnwrap()).toEqual(["044_lossless_history_json.sql"]);
      expect(
        (
          await client.query(
            "SELECT pg_typeof(record)::text AS record_type, pg_typeof(harness_session_header)::text AS session_type FROM history_records JOIN orbs ON orbs.id=orb_id WHERE orbs.id=$1",
            [orb.id],
          )
        )._unsafeUnwrap().rows[0],
      ).toEqual({ record_type: "json", session_type: "json" });
      expect((await database.store.readHistorySnapshot(task, orb.id))._unsafeUnwrap()).toEqual({
        session,
        records: [record],
        cursor: record.id,
        headId: record.id,
      });
      for (const payload of ["[]", "null", '"scalar"', "{"]) {
        for (const sql of [
          "UPDATE history_records SET record=$2::text::json WHERE orb_id=$1",
          "UPDATE orbs SET harness_session_header=$2::text::json WHERE id=$1",
        ])
          expect((await client.query(sql, [orb.id, payload])).isErr()).toBe(true);
      }
      for (const sql of [
        "UPDATE orbs SET harness_session_header=NULL WHERE id=$1",
        "UPDATE orbs SET replication_cursor='missing' WHERE id=$1",
        "UPDATE history_records SET parent_id='missing' WHERE orb_id=$1",
      ])
        expect((await client.query(sql, [orb.id])).isErr()).toBe(true);
      expect((await database.migrate())._unsafeUnwrap()).toEqual([]);
    } finally {
      expect((await database.close()).isOk()).toBe(true);
    }
  });
});
