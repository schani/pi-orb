import { randomUUID } from "node:crypto";
import type { OrbState } from "@pi-orb/protocol";
import { NoSimulationTask, type SimulationTask } from "determined";
import { onTestFinished } from "vitest";
import { composeControlPlaneDatabase } from "../adapters/database.ts";
import { PGliteClient } from "../adapters/pg/pglite-client.ts";
import { makeOrbRow, makeProjectRow, seedTestUser } from "./fixtures.ts";
import { openThrowawayPostgres } from "./postgres.ts";

async function openSqlFixture(connection?: string) {
  const subject = connection ? await openThrowawayPostgres(connection) : undefined;
  const db = subject?.client ?? new PGliteClient();
  onTestFinished(async () => {
    (await db.end())._unsafeUnwrap();
  });
  return { db, database: subject?.database ?? composeControlPlaneDatabase(db) };
}

export async function openOrbSqlFixture(name: string, state: OrbState) {
  const fixture = await openSqlFixture();
  const { database } = fixture;
  const task = new NoSimulationTask(name, false);
  const project = makeProjectRow(randomUUID());
  const orb = makeOrbRow(randomUUID(), project.id, state);
  (await database.migrate())._unsafeUnwrap();
  (await seedTestUser(task, database.users))._unsafeUnwrap();
  (await database.store.insertProject(task, project))._unsafeUnwrap();
  const inserted = (await database.store.insertOrb(task, orb))._unsafeUnwrap();
  return { ...fixture, task, project, orb, inserted };
}

export const ALICE = "00000000-0000-4000-8000-000000000001";
export const BOB = "00000000-0000-4000-8000-000000000002";

export async function openTwoUserSqlFixture(task: SimulationTask) {
  const fixture = await openSqlFixture(process.env.PI_ORB_TEST_DATABASE_URL);
  const migrations = (await fixture.database.migrate())._unsafeUnwrap();
  for (const [id, subject] of [
    [ALICE, "alice"],
    [BOB, "bob"],
  ] as const)
    (
      await fixture.database.users.resolveUser(
        task,
        { issuer: "test", subject, email: null },
        { id, now: 0 },
      )
    )._unsafeUnwrap();
  return { ...fixture, migrations };
}
