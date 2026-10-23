import { composeControlPlaneDatabase } from "../database.ts";
import { historySearchContractTests } from "./history-search.contract.ts";
import { PGliteClient } from "./pglite-client.ts";

historySearchContractTests("PGlite", async () => {
  const client = new PGliteClient();
  return { client, database: composeControlPlaneDatabase(client) };
});
