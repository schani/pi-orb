import { NoSimulationTask } from "determined";
import { ownedProjectsContractTests } from "../../testkit/owned-projects-contract.ts";
import { composeControlPlaneDatabase } from "../database.ts";
import { PGliteClient } from "./pglite-client.ts";

const task = new NoSimulationTask("PGlite owned projects", false);
ownedProjectsContractTests("PGlite", async () => {
  const database = composeControlPlaneDatabase(new PGliteClient());
  (await database.migrate())._unsafeUnwrap();
  return {
    store: database.store,
    seedUser: async (id, subject) => {
      (
        await database.users.resolveUser(
          task,
          { issuer: "test", subject, email: null },
          { id, now: 0 },
        )
      )._unsafeUnwrap();
    },
    close: async () => {
      await database.close();
    },
  };
});
