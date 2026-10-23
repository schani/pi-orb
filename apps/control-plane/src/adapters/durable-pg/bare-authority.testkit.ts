import { readFile } from "node:fs/promises";
import type { PostgreSQLClient } from "../pg/client.ts";

export async function initializeBareAuthority(db: PostgreSQLClient, orb: string) {
  (
    await db.query(
      "CREATE TABLE orbs(id uuid PRIMARY KEY, agent_admission_version bigint NOT NULL DEFAULT 0)",
    )
  )._unsafeUnwrap();
  (await db.query("INSERT INTO orbs(id) VALUES($1)", [orb]))._unsafeUnwrap();
  const migration = await readFile(
    new URL("../pg/migrations/036_durable_authority.sql", import.meta.url),
    "utf8",
  );
  (await db.transaction(async (_q, execute) => execute(migration)))._unsafeUnwrap();
}
