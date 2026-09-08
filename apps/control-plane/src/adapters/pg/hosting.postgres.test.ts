import { describe, it } from "vitest";
import { openThrowawayPostgres } from "../../testkit/postgres.ts";
import { hostingStoreContractTests, postgreSQLHostingContractSubject } from "./hosting.contract.ts";
import { PostgreSQLHostingStore } from "./hosting.ts";

const connectionString = process.env["PI_ORB_TEST_DATABASE_URL"];

if (connectionString === undefined || connectionString === "") {
  describe("node-postgres hosting store contract", () => {
    it.skip("needs PI_ORB_TEST_DATABASE_URL", () => undefined);
  });
} else {
  hostingStoreContractTests("node-postgres", async () => {
    const subject = await openThrowawayPostgres(connectionString);
    return postgreSQLHostingContractSubject(
      subject.client,
      new PostgreSQLHostingStore(subject.client),
      async () => {
        await subject.database.close();
      },
    );
  });
}
