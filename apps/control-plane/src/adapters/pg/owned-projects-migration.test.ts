import { ownedMigrationContractTests } from "../../testkit/owned-migration-contract.ts";
import { PGliteClient } from "./pglite-client.ts";

ownedMigrationContractTests("PGlite", async () => new PGliteClient());
