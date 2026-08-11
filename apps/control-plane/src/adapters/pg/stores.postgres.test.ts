import { describe, it } from "vitest";
import { openThrowawayPostgres } from "../../testkit/postgres.ts";
import { storeContractTests } from "../../testkit/store-contract.ts";

/**
 * The same store contract over the node-postgres driver. Opt-in, because it
 * needs a server: `PI_ORB_TEST_DATABASE_URL=postgres://… npx vitest run
 * apps/control-plane/src/adapters/pg`. The default unit run stays PGlite-only,
 * and `npm run test:e2e` provisions a container for
 * `e2e/postgres-store.e2e.test.ts`, which runs this same contract (docs/testing.md).
 *
 * Each test drops and recreates schema `public`: point the variable at a
 * throwaway database only.
 */
const connectionString = process.env["PI_ORB_TEST_DATABASE_URL"];

if (connectionString === undefined || connectionString === "") {
  describe("node-postgres store contract", () => {
    it.skip("needs PI_ORB_TEST_DATABASE_URL (a throwaway database; see e2e/postgres-store.e2e.test.ts)", () => {
      // Registered as skipped so the opt-in is visible in the default run.
    });
  });
} else {
  storeContractTests("node-postgres", () => openThrowawayPostgres(connectionString));
}
