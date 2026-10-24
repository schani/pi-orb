import type { HistoryRecord } from "@pi-orb/protocol";
import { err, ok } from "neverthrow";
import { expect, it } from "vitest";
import type { CommitPullError } from "../../domain/errors.ts";
import { openOrbSqlFixture } from "../../testkit/sql-fixture.ts";
import { commitHistoryTransaction } from "./store.ts";

it("rolls public cursor/session back with a failed private commit", async () => {
  const { db, database, task, orb } = await openOrbSqlFixture("atomic-history", "running");
  {
    const record: HistoryRecord = {
      id: "atomic-record",
      parentId: null,
      timestamp: "2026-10-13T00:00:00.000Z",
      type: "message",
      role: "tool",
      content: [{ type: "text", text: "\u0000\ud800" }],
      overflow: { "\udfff": "\u0000" },
    };
    const result = await db.transaction<void, CommitPullError | { type: "private_commit_failed" }>(
      async (query) => {
        const projected = await commitHistoryTransaction(query, {
          orbId: orb.id,
          expectedCursor: null,
          session: { id: "atomic-session", timestamp: "2026-10-04T00:00:00.000Z", overflow: {} },
          records: [record],
          nextCursor: record.id,
          nextHeadId: record.id,
        });
        if (projected.isErr()) return err(projected.error);
        return err({ type: "private_commit_failed" as const });
      },
    );
    expect(result.isErr() && result.error).toEqual({ type: "private_commit_failed" });
    expect(
      (await database.store.readHistorySnapshot(task, orb.id))._unsafeUnwrap().records,
    ).toEqual([]);
    expect(
      (await database.store.getOrb(task, orb.id))._unsafeUnwrap()?.harnessSessionId,
    ).toBeNull();
    const committed = await db.transaction(async (query) => {
      const projected = await commitHistoryTransaction(query, {
        orbId: orb.id,
        expectedCursor: null,
        session: { id: "atomic-session", timestamp: "2026-10-04T00:00:00.000Z", overflow: {} },
        records: [record],
        nextCursor: record.id,
        nextHeadId: record.id,
      });
      return projected.isErr() ? err(projected.error) : ok(undefined);
    });
    expect(committed.isOk()).toBe(true);
    expect(
      (await database.store.readHistorySnapshot(task, orb.id))._unsafeUnwrap().records,
    ).toEqual([record]);
    expect((await database.store.getOrb(task, orb.id))._unsafeUnwrap()?.harnessSessionId).toBe(
      "atomic-session",
    );
  }
});
