import { CLAUDE_MODEL_CALL_EVENT, type HistoryRecord } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { okAsync } from "neverthrow";
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
  costUsd: 0.0125,
  durationMs: 2_345,
  responseId: "resp_1",
  ttftMs: 410,
  thinkingMs: 1_900,
  sessionId: "session_1",
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
      const {
        durationMs: _untimed,
        costUsd: _uncosted,
        responseId: _unidentified,
        ttftMs: _unstreamed,
        thinkingMs: _unreasoned,
        sessionId: _sessionless,
        ...failed
      } = call(DELETED, {
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
          cost_usd: 0.0125,
          duration_ms: 2_345,
          response_id: "resp_1",
          ttft_ms: 410,
          thinking_ms: 1_900,
          session_id: "session_1",
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
          cost_usd: null,
          duration_ms: null,
          response_id: null,
          ttft_ms: null,
          thinking_ms: null,
          session_id: null,
        },
      ]);
      expect(statements.filter((text) => /synchronous_commit/.test(text))).toEqual([
        "SET LOCAL synchronous_commit = off",
        "SET LOCAL synchronous_commit = off",
      ]);
      clock.mockRestore();
    });

    it("inserts one row per newly replicated Claude model call, in the history commit", async () => {
      (await seedTestUser(task, database.users))._unsafeUnwrap();
      (await database.store.insertProject(task, makeProjectRow(PROJECT)))._unsafeUnwrap();
      (
        await database.store.insertOrb(task, makeOrbRow(ARCHIVED, PROJECT, "running"))
      )._unsafeUnwrap();
      const event = (id: string, eventType: string, overflow: object): HistoryRecord => ({
        id,
        parentId: null,
        timestamp: "2026-10-14T00:00:01.000Z",
        type: "event",
        eventType,
        content: [{ type: "text", text: "" }],
        custom: { customType: eventType, display: false },
        overflow: overflow as HistoryRecord["overflow"],
      });
      const usage = {
        outcome: "ok",
        at: "2026-10-14T00:00:00.500Z",
        model: "claude-opus-5-5",
        querySource: "agent:custom",
        input: 3,
        output: 200,
        cacheRead: 40_000,
        cacheWrite: 1_500,
        costUsd: 0.042,
        durationMs: 4_100,
      };
      const records = [
        event("call", CLAUDE_MODEL_CALL_EVENT, usage),
        event("other", "claude.steering_result", usage),
        event("malformed", CLAUDE_MODEL_CALL_EVENT, { ...usage, input: "3" }),
      ];
      const commit = (expectedCursor: string | null, nextCursor: string) =>
        database.store.commitPullBatch(task, {
          orbId: ARCHIVED,
          expectedCursor,
          session: { id: "session", overflow: {} },
          records,
          nextCursor,
          nextHeadId: "malformed",
        });
      (await commit(null, "malformed"))._unsafeUnwrap();
      // A redelivered batch inserts no history rows, so it inserts no usage rows.
      (await commit("malformed", "malformed"))._unsafeUnwrap();
      expect(
        (await rows()).map(({ id: _id, ...row }) => ({
          ...row,
          at: (row["at"] as Date).getTime(),
        })),
      ).toEqual([
        {
          at: Date.parse("2026-10-14T00:00:00.500Z"),
          owner_user_id: TEST_USER_ID,
          orb_id: ARCHIVED,
          use: "subagent",
          provider: "anthropic",
          model: "claude-opus-5-5",
          outcome: "ok",
          input: 3,
          output: 200,
          cache_read: 40_000,
          cache_write: 1_500,
          cost_usd: 0.042,
          duration_ms: 4_100,
          response_id: null,
          ttft_ms: null,
          thinking_ms: null,
          session_id: null,
        },
      ]);
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

    it("reads owner-scoped half-open buckets and retains nameless deleted orbs", async () => {
      const boundaries = [AT, AT + 900_000, AT + 1_800_000];
      const clock = vi.spyOn(task, "wallNow").mockReturnValue(AT);
      ledger.record(task, call(ARCHIVED));
      ledger.record(task, call(ARCHIVED, { ownerUserId: "other" }));
      await ledger.drain();
      clock.mockReturnValue(AT + 900_000);
      ledger.record(task, call(DELETED, { use: "subagent" }));
      ledger.record(
        task,
        call(DELETED, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, outcome: "error" }),
      );
      await ledger.drain();
      clock.mockReturnValue(AT + 1_800_000);
      ledger.record(task, call(DELETED));
      await ledger.drain();
      clock.mockReturnValue(AT - 1);
      ledger.record(task, call(DELETED));
      await ledger.drain();
      clock.mockRestore();
      const result = (await ledger.read(task, TEST_USER_ID, boundaries))._unsafeUnwrap();
      expect(result.buckets).toHaveLength(3);
      expect(result.buckets.find((row) => row.at === AT)).toMatchObject({
        use: "root",
        input: 120,
        output: 30,
        cacheRead: 4000,
        cacheWrite: 7,
        calls: 1,
      });
      expect(
        result.buckets
          .filter((row) => row.at === AT + 900_000)
          .reduce((sum, row) => sum + row.calls, 0),
      ).toBe(2);
      expect(result.orbs.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
        {
          id: ARCHIVED,
          name: null,
          input: 120,
          output: 30,
          cacheRead: 4000,
          cacheWrite: 7,
          calls: 1,
        },
        {
          id: DELETED,
          name: null,
          input: 120,
          output: 30,
          cacheRead: 4000,
          cacheWrite: 7,
          calls: 2,
        },
      ]);
      expect((await ledger.read(task, "no-calls", boundaries))._unsafeUnwrap()).toEqual({
        buckets: [],
        orbs: [],
      });
    });

    it("separates orbs sharing a bucket, use and model without duplicating totals", async () => {
      const clock = vi.spyOn(task, "wallNow").mockReturnValue(AT);
      ledger.record(task, call(ARCHIVED));
      ledger.record(task, call(ARCHIVED));
      ledger.record(task, call(DELETED));
      ledger.record(task, call(DELETED, { ownerUserId: "other" }));
      await ledger.drain();
      clock.mockRestore();
      const result = (await ledger.read(task, TEST_USER_ID, [AT, AT + 900000]))._unsafeUnwrap();
      expect(result.buckets.sort((a, b) => a.orbId.localeCompare(b.orbId))).toEqual([
        {
          at: AT,
          orbId: ARCHIVED,
          use: "root",
          provider: "openai-codex",
          model: "gpt-6-astra",
          input: 240,
          output: 60,
          cacheRead: 8000,
          cacheWrite: 14,
          calls: 2,
        },
        {
          at: AT,
          orbId: DELETED,
          use: "root",
          provider: "openai-codex",
          model: "gpt-6-astra",
          input: 120,
          output: 30,
          cacheRead: 4000,
          cacheWrite: 7,
          calls: 1,
        },
      ]);
      for (const orb of result.orbs) {
        const buckets = result.buckets.filter((row) => row.orbId === orb.id);
        for (const key of ["input", "output", "cacheRead", "cacheWrite", "calls"] as const)
          expect(buckets.reduce((sum, row) => sum + row[key], 0)).toBe(orb[key]);
      }
    });

    it("never discloses another owner's orb name through the ledger join", async () => {
      (await seedTestUser(task, database.users))._unsafeUnwrap();
      (await database.store.insertProject(task, makeProjectRow(PROJECT)))._unsafeUnwrap();
      (
        await database.store.insertOrb(task, {
          ...makeOrbRow(ARCHIVED, PROJECT, "stopped"),
          name: "Mine",
        })
      )._unsafeUnwrap();
      const clock = vi.spyOn(task, "wallNow").mockReturnValue(AT);
      ledger.record(task, call(ARCHIVED));
      ledger.record(task, call(ARCHIVED, { ownerUserId: "other" }));
      await ledger.drain();
      clock.mockRestore();
      expect(
        (await ledger.read(task, TEST_USER_ID, [AT, AT + 900000]))._unsafeUnwrap().orbs[0]?.name,
      ).toBe("Mine");
      expect(
        (await ledger.read(task, "other", [AT, AT + 900000]))._unsafeUnwrap().orbs[0]?.name,
      ).toBeNull();
    });

    it("rejects malformed aggregate rows without accepting an out-of-range bucket", async () => {
      const bucket = {
        kind: "bucket",
        bucket: 0,
        orbId: DELETED,
        use: "root",
        provider: "p",
        model: "m",
        input: 1,
        output: 2,
        cacheRead: 3,
        cacheWrite: 0,
        calls: 1,
      };
      const orb = {
        kind: "orb",
        id: DELETED,
        name: null,
        input: 1,
        output: 2,
        cacheRead: 3,
        cacheWrite: 0,
        calls: 1,
      };
      const query = vi.spyOn(client, "query");
      try {
        for (const row of [
          { ...bucket, bucket: 1 },
          { ...bucket, bucket: -1 },
          { ...bucket, bucket: 0.5 },
          { ...bucket, bucket: "0" },
          { ...bucket, bucket: NaN },
          { ...bucket, use: null },
          { ...bucket, orbId: null },
          { ...bucket, orbId: 7 },
          { ...bucket, provider: null },
          { ...bucket, model: 7 },
          { ...bucket, input: -1 },
          { ...bucket, calls: 1.5 },
          { ...bucket, cacheRead: Number.MAX_SAFE_INTEGER + 1 },
          { ...orb, id: 7 },
          { ...orb, name: 7 },
          { ...orb, kind: "unknown" },
        ]) {
          query.mockReturnValueOnce(okAsync({ rows: [row], rowCount: 1 }));
          const result = await ledger.read(task, TEST_USER_ID, [AT, AT + 900000]);
          expect(result.isErr()).toBe(true);
          expect(result._unsafeUnwrapErr().code).toBe("invariant");
        }
        query.mockReturnValueOnce(okAsync({ rows: [bucket, orb], rowCount: 2 }));
        const valid = (await ledger.read(task, TEST_USER_ID, [AT, AT + 900000]))._unsafeUnwrap();
        expect(valid.buckets[0]?.at).toBe(AT);
        expect(valid.orbs[0]?.name).toBeNull();
      } finally {
        query.mockRestore();
      }
    });

    it("reads one turn's root calls by response id and other calls by start", async () => {
      // The ledger stamps `at` inside its insert transaction, so the clock holds until it drains.
      const at = async (offset: number, recorded: ModelCall) => {
        const clock = vi.spyOn(task, "wallNow").mockReturnValue(AT + offset);
        ledger.record(task, recorded);
        expect((await ledger.drain()).isOk()).toBe(true);
        clock.mockRestore();
      };
      await at(1_000, call(ARCHIVED, { responseId: "in-turn" }));
      await at(2_000, call(ARCHIVED, { responseId: "other-turn" }));
      await at(-1, call(ARCHIVED, { responseId: "in-turn-before-window" }));
      await at(3_000, call(ARCHIVED, { use: "subagent", durationMs: 2_000, responseId: "sub" }));
      await at(
        3_000,
        call(ARCHIVED, { use: "subagent", durationMs: 3_001, responseId: "starts-before" }),
      );
      await at(
        9_999,
        call(ARCHIVED, { use: "turn_summary", durationMs: 0, responseId: "summary" }),
      );
      await at(
        11_000,
        call(ARCHIVED, { use: "headline", durationMs: 1_000, responseId: "starts-at-until" }),
      );
      await at(5_000, call(DELETED, { use: "subagent", responseId: "other-orb" }));
      const {
        durationMs: _a,
        costUsd: _b,
        responseId: _c,
        ttftMs: _d,
        thinkingMs: _e,
        sessionId: _f,
        ...bare
      } = call(ARCHIVED, { use: "compaction" });
      await at(4_000, bare);
      const query = { responseIds: ["in-turn", "in-turn-before-window", "sub"], from: AT };
      const read = await ledger.readTurnCalls(task, ARCHIVED, { ...query, until: AT + 10_000 });
      const expected = (offset: number, overrides: Partial<ModelCall>) => {
        const { ownerUserId: _o, orbId: _i, ...row } = call(ARCHIVED, overrides);
        return { ...row, at: AT + offset };
      };
      const { ownerUserId: _o, orbId: _i, ...compaction } = bare;
      expect(read._unsafeUnwrap()).toEqual([
        expected(1_000, { responseId: "in-turn" }),
        expected(3_000, { use: "subagent", durationMs: 2_000, responseId: "sub" }),
        { ...compaction, at: AT + 4_000 },
        expected(9_999, { use: "turn_summary", durationMs: 0, responseId: "summary" }),
      ]);
      expect(
        (await ledger.readTurnCalls(task, ARCHIVED, { ...query, until: AT + 10_001 }))
          ._unsafeUnwrap()
          .map((row) => row.responseId ?? null),
      ).toEqual(["in-turn", "sub", null, "summary", "starts-at-until"]);
    });

    it("rejects malformed turn call rows", async () => {
      const row = {
        at: new Date(AT),
        use: "root",
        provider: "p",
        model: "m",
        outcome: "stop",
        input: 1,
        output: 2,
        cacheRead: 3,
        cacheWrite: 0,
        costUsd: null,
        durationMs: null,
        responseId: "r",
        ttftMs: null,
        thinkingMs: null,
      };
      const query = vi.spyOn(client, "query");
      try {
        for (const bad of [
          { ...row, at: "2026" },
          { ...row, use: null },
          { ...row, input: -1 },
          { ...row, output: 1.5 },
          { ...row, costUsd: "0.1" },
          { ...row, durationMs: -1 },
          { ...row, responseId: 7 },
          { ...row, ttftMs: "1" },
          { ...row, extra: 1 },
        ]) {
          query.mockReturnValueOnce(okAsync({ rows: [bad], rowCount: 1 }));
          const result = await ledger.readTurnCalls(task, ARCHIVED, {
            responseIds: [],
            from: AT,
            until: AT,
          });
          expect(result._unsafeUnwrapErr().code).toBe("invariant");
        }
        query.mockReturnValueOnce(okAsync({ rows: [row], rowCount: 1 }));
        expect(
          (
            await ledger.readTurnCalls(task, ARCHIVED, { responseIds: [], from: AT, until: AT })
          )._unsafeUnwrap(),
        ).toEqual([
          {
            at: AT,
            use: "root",
            provider: "p",
            model: "m",
            outcome: "stop",
            input: 1,
            output: 2,
            cacheRead: 3,
            cacheWrite: 0,
            responseId: "r",
          },
        ]);
      } finally {
        query.mockRestore();
      }
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
