import { NoSimulationTask } from "determined";
import { describe, it } from "vitest";
import { ownedProjectsContractTests } from "../../testkit/owned-projects-contract.ts";
import { openThrowawayPostgres } from "../../testkit/postgres.ts";

const connectionString = process.env["PI_ORB_TEST_DATABASE_URL"];
const task = new NoSimulationTask("node-postgres owned projects", false);
if (connectionString === undefined || connectionString === "") {
  describe("node-postgres owned projects", () => {
    it.skip("needs PI_ORB_TEST_DATABASE_URL", () => undefined);
  });
} else {
  ownedProjectsContractTests("node-postgres", async () => {
    const subject = await openThrowawayPostgres(connectionString);
    (await subject.database.migrate())._unsafeUnwrap();
    return {
      store: subject.database.store,
      seedUser: async (id, userSubject) => {
        (
          await subject.database.users.resolveUser(
            task,
            { issuer: "test", subject: userSubject, email: null },
            { id, now: 0 },
          )
        )._unsafeUnwrap();
      },
      close: async () => {
        await subject.database.close();
      },
    };
  });
}
