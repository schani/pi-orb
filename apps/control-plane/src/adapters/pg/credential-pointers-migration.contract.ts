import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { err, ok } from "neverthrow";
import { afterEach, describe, expect, it } from "vitest";
import type { StoreError } from "../../domain/errors.ts";
import type { PostgreSQLClient } from "./client.ts";
import { runMigrations } from "./migrate.ts";

const OWNER = {
  userId: "00000000-0000-4000-8000-000000000001",
  identityIssuer: "issuer",
  identitySubject: "subject",
};

async function prepareLegacy(
  client: PostgreSQLClient,
  configureOwner = true,
): Promise<PostgreSQLClient> {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "migrations");
  const names = readdirSync(dir)
    .filter((name) => name.endsWith(".sql") && name < "024")
    .sort();
  (
    await client.query(
      "CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    )
  )._unsafeUnwrap();
  for (const name of names) {
    const result = await client.transaction<void, StoreError>(async (query, execute) => {
      if (name === "023_owned_projects_and_personal_instructions.sql" && configureOwner) {
        const configured = await query(
          `SELECT set_config('pi_orb.original_user_id', $1, true),
                  set_config('pi_orb.original_identity_issuer', $2, true),
                  set_config('pi_orb.original_identity_subject', $3, true)`,
          [OWNER.userId, OWNER.identityIssuer, OWNER.identitySubject],
        );
        if (configured.isErr()) return err(configured.error);
      }
      const executed = await execute(readFileSync(join(dir, name), "utf8"));
      return executed.isErr() ? err(executed.error) : ok(undefined);
    });
    result._unsafeUnwrap();
    (
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name])
    )._unsafeUnwrap();
  }
  return client;
}

export function credentialPointerMigrationContractTests(
  label: string,
  open: () => Promise<PostgreSQLClient>,
): void {
  describe(`${label} credential pointer ownership migration`, () => {
    const clients: PostgreSQLClient[] = [];
    afterEach(async () => {
      await Promise.all(clients.splice(0).map((client) => client.end()));
    });

    it("fails closed and rolls back existing pointers without an exact mapping", async () => {
      const client = await prepareLegacy(await open());
      clients.push(client);
      await client.query(
        `INSERT INTO credential_pointers
       (provider, row_version, generation, secret_version, refresh_lease_until, last_refresh_at)
       VALUES ('openai-codex', 7, 8, '42', 123, 456)`,
      );
      expect((await runMigrations(client)).isErr()).toBe(true);
      expect((await client.query("SELECT user_id FROM credential_pointers")).isErr()).toBe(true);
      expect(
        (
          await client.query("SELECT generation, secret_version FROM credential_pointers")
        )._unsafeUnwrap().rows[0],
      ).toMatchObject({ generation: 8, secret_version: "42" });
    });

    it("inserts the exact configured owner when migration 023 left no users", async () => {
      const client = await prepareLegacy(await open(), false);
      clients.push(client);
      (
        await client.query(
          `INSERT INTO credential_pointers
           (provider, row_version, generation, secret_version, refresh_lease_until, last_refresh_at)
           VALUES ('openai-codex', 1, 1, '7', 0, 0)`,
        )
      )._unsafeUnwrap();

      expect((await runMigrations(client, { originalOwner: OWNER })).isOk()).toBe(true);
      expect(
        (
          await client.query(
            "SELECT id, identity_issuer, identity_subject FROM users WHERE id = $1",
            [OWNER.userId],
          )
        )._unsafeUnwrap().rows[0],
      ).toEqual({
        id: OWNER.userId,
        identity_issuer: OWNER.identityIssuer,
        identity_subject: OWNER.identitySubject,
      });
      expect(
        (await client.query("SELECT user_id FROM credential_pointers"))._unsafeUnwrap().rows[0],
      ).toEqual({ user_id: OWNER.userId });
    });

    it("rolls back when the configured owner conflicts with an existing identity", async () => {
      const client = await prepareLegacy(await open(), false);
      clients.push(client);
      (
        await client.query(
          `INSERT INTO users (id, identity_issuer, identity_subject, created_at, updated_at)
           VALUES ($1, 'other-issuer', 'other-subject', now(), now())`,
          [OWNER.userId],
        )
      )._unsafeUnwrap();
      (
        await client.query(
          `INSERT INTO credential_pointers
           (provider, row_version, generation, secret_version, refresh_lease_until, last_refresh_at)
           VALUES ('openai-codex', 1, 1, '7', 0, 0)`,
        )
      )._unsafeUnwrap();

      expect((await runMigrations(client, { originalOwner: OWNER })).isErr()).toBe(true);
      expect((await client.query("SELECT user_id FROM credential_pointers")).isErr()).toBe(true);
      expect(
        (await client.query("SELECT identity_issuer FROM users"))._unsafeUnwrap().rows[0],
      ).toEqual({ identity_issuer: "other-issuer" });
    });

    it("preserves exact pointer state and permits the same provider for two users", async () => {
      const client = await prepareLegacy(await open());
      clients.push(client);
      await client.query(
        `INSERT INTO credential_pointers
       (provider, row_version, generation, secret_version, refresh_lease_until, last_refresh_at)
       VALUES ('openai-codex', 7, 8, '42', 123, 456)`,
      );
      expect((await runMigrations(client, { originalOwner: OWNER })).isOk()).toBe(true);
      const migrated = (await client.query("SELECT * FROM credential_pointers"))._unsafeUnwrap()
        .rows[0];
      expect(migrated).toMatchObject({
        user_id: OWNER.userId,
        provider: "openai-codex",
        row_version: 7,
        generation: 8,
        secret_version: "42",
      });
      expect(String(migrated?.refresh_lease_until)).toBe("123");
      expect(String(migrated?.last_refresh_at)).toBe("456");
      const other = "00000000-0000-4000-8000-000000000002";
      await client.query(
        `INSERT INTO users (id, identity_issuer, identity_subject, created_at, updated_at)
       VALUES ($1, 'issuer', 'other', now(), now())`,
        [other],
      );
      expect(
        (
          await client.query(
            `INSERT INTO credential_pointers
           (user_id, provider, row_version, generation, secret_version, refresh_lease_until, last_refresh_at)
           VALUES ($1, 'openai-codex', 1, 1, '99', 0, 0)`,
            [other],
          )
        ).isOk(),
      ).toBe(true);
    });
  });
}
