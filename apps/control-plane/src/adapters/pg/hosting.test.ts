import { hostingStoreContractTests, postgreSQLHostingContractSubject } from "./hosting.contract.ts";
import { PostgreSQLHostingStore } from "./hosting.ts";
import { PGliteClient } from "./pglite-client.ts";

hostingStoreContractTests("PGlite", async () => {
  const client = new PGliteClient();
  return postgreSQLHostingContractSubject(client, new PostgreSQLHostingStore(client), async () => {
    await client.end();
  });
});
