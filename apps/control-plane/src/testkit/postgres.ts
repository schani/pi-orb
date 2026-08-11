import { expect } from "vitest";
import { composeControlPlaneDatabase } from "../adapters/database.ts";
import { PgClient } from "../adapters/pg/client.ts";
import type { StoreContractSubject } from "./store-contract.ts";

/**
 * Open the store contract against a real PostgreSQL server over the
 * node-postgres driver.
 *
 * PGlite is not a faithful stand-in for it — the two drivers bind parameters
 * differently (see the parameter-intent note in `adapters/pg/client.ts` and
 * `docs/postmortems/2026-08-11-orb-message-jsonb-param-encoding.md`) — so the
 * contract has to be exercised here too.
 *
 * The database is reset per test by dropping and recreating `public`, so the
 * connection string must point at a throwaway database.
 */
export async function openThrowawayPostgres(
  connectionString: string,
): Promise<StoreContractSubject> {
  const reset = new PgClient(connectionString);
  const dropped = await reset.query("DROP SCHEMA IF EXISTS public CASCADE");
  expect(dropped.isOk(), `reset schema: ${dropped.isErr() ? dropped.error.message : ""}`).toBe(
    true,
  );
  const created = await reset.query("CREATE SCHEMA public");
  expect(created.isOk()).toBe(true);
  expect((await reset.end()).isOk()).toBe(true);
  const client = new PgClient(connectionString);
  return { database: composeControlPlaneDatabase(client), client };
}
