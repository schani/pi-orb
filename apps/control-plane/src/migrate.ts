import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { err, ok, type Result } from "neverthrow";
import { type ControlPlaneDatabase, openControlPlaneDatabase } from "./adapters/database.ts";
import type { GoogleIdentityMapping, OriginalOwnerMigrationInput } from "./adapters/pg/migrate.ts";
import { googleIdentityMigrationInput } from "./google-identity-migration-input.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function originalOwnerMigrationInput(
  env: NodeJS.ProcessEnv,
): Result<OriginalOwnerMigrationInput | undefined, string> {
  const userId = env["PI_ORB_ORIGINAL_USER_ID"];
  const identityIssuer = env["PI_ORB_ORIGINAL_IDENTITY_ISSUER"];
  const identitySubject = env["PI_ORB_ORIGINAL_IDENTITY_SUBJECT"];
  const values = [userId, identityIssuer, identitySubject];
  if (values.every((value) => value === undefined || value === "")) return ok(undefined);
  if (values.some((value) => value === undefined || value?.trim() === ""))
    return err("original owner variables must be set together");
  if (!UUID.test(userId ?? "")) return err("PI_ORB_ORIGINAL_USER_ID must be a UUID");
  return ok({
    userId: userId ?? "",
    identityIssuer: identityIssuer ?? "",
    identitySubject: identitySubject ?? "",
  });
}

export interface MigrationOwnerInput {
  readonly originalOwner?: OriginalOwnerMigrationInput;
  readonly credentialOwnerUserId?: string;
}

export function migrationOwnerInput(env: NodeJS.ProcessEnv): Result<MigrationOwnerInput, string> {
  const originalOwner = originalOwnerMigrationInput(env);
  if (originalOwner.isErr()) return err(originalOwner.error);
  const credentialOwnerUserId = env["PI_ORB_USER_ID"];
  if (
    credentialOwnerUserId !== undefined &&
    credentialOwnerUserId !== "" &&
    !UUID.test(credentialOwnerUserId)
  )
    return err("PI_ORB_USER_ID must be a UUID");
  if (
    originalOwner.value !== undefined &&
    credentialOwnerUserId !== undefined &&
    credentialOwnerUserId !== "" &&
    originalOwner.value.userId !== credentialOwnerUserId
  )
    return err("PI_ORB_USER_ID conflicts with PI_ORB_ORIGINAL_USER_ID");
  return ok({
    ...(originalOwner.value === undefined ? {} : { originalOwner: originalOwner.value }),
    ...(credentialOwnerUserId === undefined || credentialOwnerUserId === ""
      ? {}
      : { credentialOwnerUserId }),
  });
}

export async function migrateDatabase(
  database: Pick<ControlPlaneDatabase, "migrate" | "close">,
  log: (line: string) => void,
  owner: MigrationOwnerInput & {
    readonly googleIdentityMappings?: readonly GoogleIdentityMapping[];
  } = {},
): Promise<number> {
  const migrated = await database.migrate({
    ...owner,
    observe: (name, stage) => {
      log(`lifecycle: migration-${stage} name=${JSON.stringify(name)}`);
      if (name === "023_owned_projects_and_personal_instructions.sql" && stage === "applied")
        log(`lifecycle: migration-owner-mapping configured=${owner.originalOwner !== undefined}`);
      if (name === "027_google_identities.sql" && stage === "applied")
        log(
          `lifecycle: migration-google-identities mapped=${owner.googleIdentityMappings?.length ?? 0}`,
        );
    },
    observeOwnerResolution: (source, outcome) => {
      log(`lifecycle: migration-owner-resolution source=${source} outcome=${outcome}`);
    },
  });
  // Error messages can contain database values. The last started filename and
  // typed error code identify the failure without disclosing those values.
  if (migrated.isErr()) log(`lifecycle: migration-failed code=${migrated.error.code}`);
  else log(`lifecycle: migration-checked applied=${migrated.value.length}`);
  const closed = await database.close();
  if (closed.isErr()) log(`lifecycle: migration-close-failed code=${closed.error.code}`);
  return migrated.isErr() || closed.isErr() ? 1 : 0;
}

async function main(): Promise<void> {
  const connectionString = process.env["DATABASE_URL"];
  if (connectionString === undefined || connectionString === "") {
    console.error("migration: DATABASE_URL is required");
    process.exitCode = 1;
    return;
  }
  const owner = migrationOwnerInput(process.env);
  if (owner.isErr()) {
    console.error(`migration: ${owner.error}`);
    process.exitCode = 1;
    return;
  }
  const identities = googleIdentityMigrationInput(process.env);
  if (identities.isErr()) {
    console.error(`migration: ${identities.error}`);
    process.exitCode = 1;
    return;
  }
  const opened = openControlPlaneDatabase({ kind: "postgresql", connectionString });
  if (opened.isErr()) {
    console.error("migration: cannot initialize database adapter");
    process.exitCode = 1;
    return;
  }
  process.exitCode = await migrateDatabase(opened.value, console.log, {
    ...owner.value,
    ...(identities.value === undefined ? {} : { googleIdentityMappings: identities.value }),
  });
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) void main();
