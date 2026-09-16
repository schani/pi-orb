import { describe, it } from "vitest";
import { ownedMigrationContractTests } from "../../testkit/owned-migration-contract.ts";
import { openThrowawayPostgres } from "../../testkit/postgres.ts";

const connectionString = process.env["PI_ORB_TEST_DATABASE_URL"];
if (connectionString === undefined || connectionString === "") {
  describe("node-postgres owned migration", () => {
    it.skip("needs PI_ORB_TEST_DATABASE_URL", () => undefined);
  });
} else {
  ownedMigrationContractTests(
    "node-postgres",
    async () => (await openThrowawayPostgres(connectionString)).client,
  );
}
