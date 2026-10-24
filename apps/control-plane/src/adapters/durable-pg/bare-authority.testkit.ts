import { NoSimulationTask } from "determined";
import { makeOrbRow, makeProjectRow, seedTestUser } from "../../testkit/fixtures.ts";
import { composeControlPlaneDatabase } from "../database.ts";
import type { PostgreSQLClient } from "../pg/client.ts";
import { runMigrations } from "../pg/migrate.ts";

export async function initializeBareAuthority(db: PostgreSQLClient, orb: string) {
  (await runMigrations(db))._unsafeUnwrap();
  const task = new NoSimulationTask("conformance", false);
  const database = composeControlPlaneDatabase(db);
  const project = makeProjectRow("00000000-0000-4000-8000-000000000002");
  (await seedTestUser(task, database.users))._unsafeUnwrap();
  (await database.store.insertProject(task, project))._unsafeUnwrap();
  (await database.store.insertOrb(task, makeOrbRow(orb, project.id, "running")))._unsafeUnwrap();
  return { task, database, project };
}
