import { describe, it } from "vitest";
import { openThrowawayPostgres } from "../../testkit/postgres.ts";
import { historySearchContractTests } from "./history-search.contract.ts";

const url = process.env["PI_ORB_TEST_DATABASE_URL"];
if (url) historySearchContractTests("PostgreSQL", () => openThrowawayPostgres(url));
else
  describe("PostgreSQL history search", () => {
    it.skip("needs PI_ORB_TEST_DATABASE_URL", () => {});
  });
