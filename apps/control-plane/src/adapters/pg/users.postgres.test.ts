import { describe, expect, it } from "vitest";
import { openThrowawayPostgres } from "../../testkit/postgres.ts";
import { userStoreContractTests } from "../../testkit/users-contract.ts";

const connectionString = process.env["PI_ORB_TEST_DATABASE_URL"];

if (connectionString === undefined || connectionString === "") {
  describe("node-postgres users contract", () => {
    it.skip("needs PI_ORB_TEST_DATABASE_URL", () => undefined);
  });
} else {
  userStoreContractTests("node-postgres", async () => {
    const subject = await openThrowawayPostgres(connectionString);
    expect((await subject.database.migrate()).isOk()).toBe(true);
    return subject;
  });
}
