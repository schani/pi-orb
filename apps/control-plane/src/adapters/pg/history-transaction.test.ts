import { randomUUID } from "node:crypto";
import { NoSimulationTask } from "determined";
import { err, ok } from "neverthrow";
import { expect, it } from "vitest";
import type { CommitPullError } from "../../domain/errors.ts";
import { makeOrbRow, makeProjectRow } from "../../testkit/fixtures.ts";
import { composeControlPlaneDatabase } from "../database.ts";
import { PGliteClient } from "./pglite-client.ts";
import { commitHistoryTransaction } from "./store.ts";

it("rolls public cursor/session back with a failed private commit", async () => {
  const db = new PGliteClient();
  const database = composeControlPlaneDatabase(db);
  const task = new NoSimulationTask("atomic-history", false);
  const project = makeProjectRow(randomUUID());
  const orb = makeOrbRow(randomUUID(), project.id, "running");
  try {
    (await database.migrate())._unsafeUnwrap();
    (
      await database.users.resolveUser(
        task,
        { issuer: "test", subject: "owner", email: null },
        { id: project.ownerUserId, now: 0 },
      )
    )._unsafeUnwrap();
    (await database.store.insertProject(task, project))._unsafeUnwrap();
    (await database.store.insertOrb(task, orb))._unsafeUnwrap();
    const result = await db.transaction<void, CommitPullError | { type: "private_commit_failed" }>(
      async (query) => {
        const projected = await commitHistoryTransaction(query, {
          orbId: orb.id,
          expectedCursor: null,
          session: { id: "atomic-session", timestamp: "2026-10-04T00:00:00.000Z", overflow: {} },
          records: [],
          nextCursor: null,
          nextHeadId: null,
        });
        if (projected.isErr()) return err(projected.error);
        return err({ type: "private_commit_failed" as const });
      },
    );
    expect(result.isErr()).toBe(true);
    expect(
      (await database.store.getOrb(task, orb.id))._unsafeUnwrap()?.harnessSessionId,
    ).toBeNull();
    const committed = await db.transaction(async (query) => {
      const projected = await commitHistoryTransaction(query, {
        orbId: orb.id,
        expectedCursor: null,
        session: { id: "atomic-session", timestamp: "2026-10-04T00:00:00.000Z", overflow: {} },
        records: [],
        nextCursor: null,
        nextHeadId: null,
      });
      return projected.isErr() ? err(projected.error) : ok(undefined);
    });
    expect(committed.isOk()).toBe(true);
    expect((await database.store.getOrb(task, orb.id))._unsafeUnwrap()?.harnessSessionId).toBe(
      "atomic-session",
    );
  } finally {
    await database.close();
  }
});
