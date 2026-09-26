import { googleIdentityMigrationContracts } from "./google-identity-migration.contract.ts";
import { PGliteClient } from "./pglite-client.ts";

googleIdentityMigrationContracts("PGlite", async () => new PGliteClient());
