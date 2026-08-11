import { storeContractTests } from "../../testkit/store-contract.ts";
import { composeControlPlaneDatabase } from "../database.ts";
import { PGliteClient } from "./pglite-client.ts";

storeContractTests("PGlite", async () => {
  const client = new PGliteClient();
  return { database: composeControlPlaneDatabase(client), client };
});
