import { expect } from "vitest";
import { userStoreContractTests } from "../../testkit/users-contract.ts";
import { composeControlPlaneDatabase } from "../database.ts";
import { PGliteClient } from "./pglite-client.ts";

userStoreContractTests("PGlite", async () => {
  const client = new PGliteClient();
  const database = composeControlPlaneDatabase(client);
  expect((await database.migrate()).isOk()).toBe(true);
  return { database, client };
});
