import { describe, it } from "vitest";
import { historyMigrationContractTests } from "./history-migration.contract.ts";

const url = process.env["PI_ORB_TEST_DATABASE_URL"];
if (url === undefined) {
  describe("PostgreSQL history migration lock order", () => {
    it.skip("needs PI_ORB_TEST_DATABASE_URL (an owned throwaway server)", () => {});
  });
} else {
  historyMigrationContractTests("PostgreSQL", () => url);
}
