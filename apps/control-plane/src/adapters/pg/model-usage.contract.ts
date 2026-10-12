import { NoSimulationTask } from "determined";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCall } from "../../domain/model-usage.ts";
import { makeOrbRow, makeProjectRow, seedTestUser, TEST_USER_ID } from "../../testkit/fixtures.ts";
import type { StoreContractSubject } from "../../testkit/store-contract.ts";
import type { ControlPlaneDatabase } from "../database.ts";
import type { PostgreSQLClient } from "./client.ts";
import { PostgreSQLModelUsageLedger } from "./model-usage.ts";

const PROJECT = "00000000-0000-4000-8000-0000000000a1";
const ARCHIVED = "00000000-0000-4000-8000-0000000000b1";
const DELETED = "00000000-0000-4000-8000-0000000000b2";

const AT = Date.UTC(2026, 9, 12, 8, 30, 0, 125);

const call = (orbId: string, overrides: Partial<ModelCall> = {}): ModelCall => ({
  ownerUserId: TEST_USER_ID,
  orbId,
  use: "root",
  provider: "openai-codex",
  model: "gpt-6-astra",
  outcome: "stop",
  input: 120,
  output: 30,
  cacheRead: 4_000,
  cacheWrite: 7,
  durationMs: 2_345,
  ...overrides,
});

/** The ledger adapter on both drivers: PGlite in the unit run, node-postgres where a server exists. */
export function modelUsageLedgerContractTests(
  name: string,
  open: () => Promise<StoreContractSubject>,
): void {
  describe(`${name} model usage ledger`, () => {
    const task = new NoSimulationTask("model usage ledger", false);
    let database: ControlPlaneDatabase;
    let client: PostgreSQLClient;
    let statements: string[];
    let ledger: PostgreSQLModelUsageLedger;

    beforeEach(async () => {
      const subject = await open();
      database = subject.database;
      client = subject.client;
      expect((await database.migrate()).isOk()).toBe(true);
      statements = [];
      const transaction = client.transaction.bind(client);
      const observed: PostgreSQLClient = {
        query: (text, values) => client.query(text, values),
        end: () => client.end(),
        transaction: (f) =>
          transaction((query, execute) =>
            f(
              (text, values) => {
                statements.push(text);
                return query(text, values);
              },
              (text) => {
                statements.push(text);
                return execute(text);
              },
            ),
          ),
      };
      ledger = new PostgreSQLModelUsageLedger(observed);
    });

    afterEach(async () => {
      expect((await database.close()).isOk()).toBe(true);
    });

    const rows = async () =>
      (await client.query("SELECT * FROM model_calls ORDER BY id"))._unsafeUnwrap().rows;

    it("inserts one content-free row per call without waiting for the WAL flush", async () => {
      const clock = vi.spyOn(task, "wallNow").mockReturnValue(AT);
      ledger.record(task, call(ARCHIVED));
      const { durationMs: _untimed, ...failed } = call(DELETED, {
        use: "turn_summary",
        model: "gpt-6-luna",
        outcome: "error",
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      });
      ledger.record(task, failed);
      expect((await ledger.drain()).isOk()).toBe(true);
      const stored = await rows();
      expect(stored).toHaveLength(2);
      expect(
        stored.map(({ id: _id, ...row }) => ({ ...row, at: (row["at"] as Date).getTime() })),
      ).toEqual([
        {
          at: AT,
          owner_user_id: TEST_USER_ID,
          orb_id: ARCHIVED,
          use: "root",
          provider: "openai-codex",
          model: "gpt-6-astra",
          outcome: "stop",
          input: 120,
          output: 30,
          cache_read: 4_000,
          cache_write: 7,
          duration_ms: 2_345,
        },
        {
          at: AT,
          owner_user_id: TEST_USER_ID,
          orb_id: DELETED,
          use: "turn_summary",
          provider: "openai-codex",
          model: "gpt-6-luna",
          outcome: "error",
          input: 0,
          output: 0,
          cache_read: 0,
          cache_write: 0,
          duration_ms: null,
        },
      ]);
      expect(statements.filter((text) => /synchronous_commit/.test(text))).toEqual([
        "SET LOCAL synchronous_commit = off",
        "SET LOCAL synchronous_commit = off",
      ]);
      clock.mockRestore();
    });

    it("keeps rows through orb archival and deletion", async () => {
      expect((await seedTestUser(task, database.users)).isOk()).toBe(true);
      expect((await database.store.insertProject(task, makeProjectRow(PROJECT))).isOk()).toBe(true);
      expect(
        (await database.store.insertOrb(task, makeOrbRow(ARCHIVED, PROJECT, "stopped"))).isOk(),
      ).toBe(true);
      expect(
        (await database.store.insertOrb(task, makeOrbRow(DELETED, PROJECT, "deleting"))).isOk(),
      ).toBe(true);
      ledger.record(task, call(ARCHIVED));
      ledger.record(task, call(DELETED, { use: "subagent" }));
      expect((await ledger.drain()).isOk()).toBe(true);

      const archiving = (
        await database.store.requestOrbArchive(task, {
          orbId: ARCHIVED,
          expectedStateVersion: 0,
          now: 1,
          cleanupAfter: 1,
        })
      )._unsafeUnwrap();
      (
        await database.store.sealOrbArchive(task, {
          orbId: ARCHIVED,
          expectedStateVersion: archiving.stateVersion,
          now: 2,
          cursor: null,
          headId: null,
        })
      )._unsafeUnwrap();
      expect(
        (
          await database.store.finalizeOrbArchive(task, {
            orbId: ARCHIVED,
            expectedStateVersion: archiving.stateVersion,
            now: 3,
          })
        )._unsafeUnwrap().state,
      ).toBe("archived");
      (
        await database.store.finalizeOrbDeletion(task, { orbId: DELETED, expectedStateVersion: 0 })
      )._unsafeUnwrap();
      expect((await database.store.getOrb(task, DELETED))._unsafeUnwrap()).toBeNull();

      expect((await rows()).map((row) => [row["orb_id"], row["use"]])).toEqual([
        [ARCHIVED, "root"],
        [DELETED, "subagent"],
      ]);
    });

    it("logs one edge when writes start failing and one when they recover", async () => {
      const log = vi.spyOn(task, "log");
      const edges = () =>
        log.mock.calls
          .map(([line]) => String(line))
          .filter((line) => line.includes("model_usage."));
      ledger.record(task, call(ARCHIVED));
      expect((await ledger.drain()).isOk()).toBe(true);
      expect(edges()).toEqual([]);

      (await client.query("ALTER TABLE model_calls RENAME TO model_calls_away"))._unsafeUnwrap();
      for (let index = 0; index < 3; index++) ledger.record(task, call(ARCHIVED));
      expect((await ledger.drain()).isOk()).toBe(true);
      ledger.record(task, call(ARCHIVED));
      expect((await ledger.drain()).isOk()).toBe(true);
      expect(edges()).toEqual(["lifecycle: model_usage.write_failed code=invariant"]);

      (await client.query("ALTER TABLE model_calls_away RENAME TO model_calls"))._unsafeUnwrap();
      ledger.record(task, call(ARCHIVED));
      ledger.record(task, call(ARCHIVED));
      expect((await ledger.drain()).isOk()).toBe(true);
      expect(edges()).toEqual([
        "lifecycle: model_usage.write_failed code=invariant",
        "lifecycle: model_usage.write_recovered",
      ]);
      expect(await rows()).toHaveLength(3);
      log.mockRestore();
    });
  });
}
