import { credentialPointerMigrationContractTests } from "./credential-pointers-migration.contract.ts";
import { PGliteClient } from "./pglite-client.ts";

credentialPointerMigrationContractTests("PGlite", async () => new PGliteClient());
