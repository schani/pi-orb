import { describe, it } from "vitest";
import { openThrowawayPostgres } from "../../testkit/postgres.ts";
import { modelUsageLedgerContractTests } from "./model-usage.contract.ts";

const connectionString = process.env["PI_ORB_TEST_DATABASE_URL"];

if (connectionString === undefined || connectionString === "") {
  describe("node-postgres model usage ledger", () => {
    it.skip("needs PI_ORB_TEST_DATABASE_URL", () => undefined);
  });
} else {
  modelUsageLedgerContractTests("node-postgres", () => openThrowawayPostgres(connectionString));
}
