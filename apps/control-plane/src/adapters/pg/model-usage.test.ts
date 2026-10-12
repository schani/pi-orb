import { composeControlPlaneDatabase } from "../database.ts";
import { modelUsageLedgerContractTests } from "./model-usage.contract.ts";
import { PGliteClient } from "./pglite-client.ts";

modelUsageLedgerContractTests("PGlite", async () => {
  const client = new PGliteClient();
  return { database: composeControlPlaneDatabase(client), client };
});
