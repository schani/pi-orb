import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ControlPlaneDatabase, openControlPlaneDatabase } from "./adapters/database.ts";

export async function migrateDatabase(
  database: Pick<ControlPlaneDatabase, "migrate" | "close">,
  log: (line: string) => void,
): Promise<number> {
  const migrated = await database.migrate((name, stage) => {
    log(`lifecycle: migration-${stage} name=${JSON.stringify(name)}`);
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
  const opened = openControlPlaneDatabase({ kind: "postgresql", connectionString });
  if (opened.isErr()) {
    console.error("migration: cannot initialize database adapter");
    process.exitCode = 1;
    return;
  }
  process.exitCode = await migrateDatabase(opened.value, console.log);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) void main();
