import assert from "node:assert/strict";
import { okAsync, ResultAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import { generateActivityHeadline } from "../../domain/activity-headlines.ts";
import { headlineSource } from "../../testkit/display-history.ts";
import { makeHarness } from "../../testkit/fixtures.ts";
import { openOrbSqlFixture } from "../../testkit/sql-fixture.ts";

it.each(["source", "orb"] as const)(
  "SQL %s deletion between service validation and persistence is invalidated without insertion",
  async (fence) => {
    const { db, database, task, orb } = await openOrbSqlFixture("headline deletion", "stopped");
    const store = database.store;
    const record = headlineSource("PRIVATE_SOURCE_CANARY");
    (
      await store.commitPullBatch(task, {
        orbId: orb.id,
        expectedCursor: null,
        session: { id: "session", overflow: {} },
        records: [record],
        nextCursor: record.id,
        nextHeadId: record.id,
      })
    )._unsafeUnwrap();
    const ref = {
      orbId: orb.id,
      sessionId: "session",
      recordId: record.id,
      detailKey: `${record.id}:0`,
    };
    const put = store.putActivityHeadlineIfAbsent.bind(store);
    const write = vi.spyOn(store, "putActivityHeadlineIfAbsent").mockImplementationOnce(
      (t, candidate) =>
        new ResultAsync(
          (async () => {
            if (fence === "source") {
              (
                await db.query(
                  "UPDATE orbs SET replication_cursor = NULL, replicated_head_id = NULL WHERE id = $1",
                  [orb.id],
                )
              )._unsafeUnwrap();
              (
                await db.query("DELETE FROM history_records WHERE orb_id = $1 AND record_id = $2", [
                  orb.id,
                  record.id,
                ])
              )._unsafeUnwrap();
            } else {
              const current = (await store.getOrb(t, orb.id))._unsafeUnwrap();
              assert(current !== null);
              (
                await store.requestOrbDeletion(t, {
                  orbId: orb.id,
                  expectedStateVersion: current.stateVersion,
                  now: t.wallNow(),
                  cleanupAfter: t.wallNow(),
                })
              )._unsafeUnwrap();
            }
            return await put(t, candidate);
          })(),
        ),
    );
    const h = makeHarness();
    const result = await generateActivityHeadline(
      task,
      {
        ...h.deps,
        store,
        headlineGenerator: { generate: () => okAsync("PRIVATE_HEADLINE_CANARY") },
      },
      ref,
    );
    expect(write).toHaveBeenCalledOnce();
    expect(result._unsafeUnwrapErr()).toEqual({ type: "invalidated", stage: "persistence" });
    expect((await store.readActivityHeadlines(task, orb.id, "session"))._unsafeUnwrap()).toEqual(
      [],
    );
    if (fence === "source")
      expect(
        (await store.readHistoryRecord(task, orb.id, "session", record.id))._unsafeUnwrap(),
      ).toBeNull();
  },
);
