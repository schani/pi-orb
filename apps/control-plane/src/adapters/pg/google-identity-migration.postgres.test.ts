import { describe, it } from "vitest";
import { openThrowawayPostgres } from "../../testkit/postgres.ts";
import { googleIdentityMigrationContracts } from "./google-identity-migration.contract.ts";

const connectionString = process.env["PI_ORB_TEST_DATABASE_URL"];
if (connectionString === undefined || connectionString === "") {
  describe("node-postgres Google identity migration", () => {
    it.skip("needs PI_ORB_TEST_DATABASE_URL", () => undefined);
  });
} else {
  googleIdentityMigrationContracts(
    "node-postgres",
    async () => (await openThrowawayPostgres(connectionString)).client,
  );
}
