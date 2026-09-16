import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { err, ok } from "neverthrow";
import { afterEach, describe, expect, it } from "vitest";
import type { PostgreSQLClient } from "../adapters/pg/client.ts";
import { type OriginalOwnerMigrationInput, runMigrations } from "../adapters/pg/migrate.ts";
import type { StoreError } from "../domain/errors.ts";

const OWNER: OriginalOwnerMigrationInput = {
  userId: "00000000-0000-4000-8000-000000000001",
  identityIssuer: "issuer",
  identitySubject: "subject",
};

export function ownedMigrationContractTests(
  label: string,
  open: () => Promise<PostgreSQLClient>,
): void {
  describe(`${label} owned migration`, () => {
    const clients: PostgreSQLClient[] = [];
    afterEach(async () => {
      await Promise.all(clients.splice(0).map((client) => client.end()));
    });
    const fresh = async () => {
      const client = await open();
      clients.push(client);
      return client;
    };
    const legacy = async () => {
      const client = await fresh();
      const dir = join(dirname(fileURLToPath(import.meta.url)), "../adapters/pg/migrations");
      const names = readdirSync(dir)
        .filter((name) => name.endsWith(".sql") && name < "022")
        .sort();
      (
        await client.query(
          "CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
        )
      )._unsafeUnwrap();
      for (const name of names) {
        const result = await client.transaction<void, StoreError>(async (_query, execute) => {
          const executed = await execute(readFileSync(join(dir, name), "utf8"));
          return executed.isErr() ? err(executed.error) : ok(undefined);
        });
        result._unsafeUnwrap();
        (
          await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name])
        )._unsafeUnwrap();
      }
      return client;
    };

    it("migrates an empty database without an owner", async () => {
      const client = await fresh();
      expect((await runMigrations(client)).isOk()).toBe(true);
      expect((await client.query("SELECT * FROM users"))._unsafeUnwrap().rows).toEqual([]);
      expect(
        (await client.query("SELECT * FROM personal_instructions"))._unsafeUnwrap().rows,
      ).toEqual([]);
    });

    it("rolls back legacy projects or nonempty instructions without an owner", async () => {
      for (const kind of ["project", "instructions"] as const) {
        const client = await legacy();
        if (kind === "project")
          (
            await client.query(
              "INSERT INTO projects (id, name, repository_url) VALUES ($1, 'p', 'https://example.test/r')",
              ["10000000-0000-4000-8000-000000000001"],
            )
          )._unsafeUnwrap();
        else
          (
            await client.query("UPDATE personal_instructions SET content = 'legacy', revision = 7")
          )._unsafeUnwrap();
        const result = await runMigrations(client);
        expect(result.isErr() && result.error.code).toBe("invariant");
        expect((await client.query("SELECT owner_user_id FROM projects")).isErr()).toBe(true);
      }
    });

    it("maps exact ownership and preserves both instruction scopes", async () => {
      const client = await legacy();
      const projectId = "10000000-0000-4000-8000-000000000001";
      await client.query(
        "INSERT INTO projects (id, name, repository_url) VALUES ($1, 'p', 'https://example.test/r')",
        [projectId],
      );
      await client.query(
        "UPDATE personal_instructions SET content = 'legacy', revision = 7, updated_at = '2020-01-01T00:00:00Z'",
      );
      await client.query(
        "UPDATE projects SET instructions_content = 'project', instructions_revision = 4 WHERE id = $1",
        [projectId],
      );
      expect((await runMigrations(client, { originalOwner: OWNER })).isOk()).toBe(true);
      expect(
        (await client.query("SELECT owner_user_id FROM projects"))._unsafeUnwrap().rows[0]?.[
          "owner_user_id"
        ],
      ).toBe(OWNER.userId);
      const personal = (
        await client.query(
          "SELECT user_id, content, revision::text AS revision, updated_at FROM personal_instructions",
        )
      )._unsafeUnwrap().rows[0];
      expect(personal).toMatchObject({ user_id: OWNER.userId, content: "legacy", revision: "7" });
      expect(new Date(String(personal?.["updated_at"])).toISOString()).toBe(
        "2020-01-01T00:00:00.000Z",
      );
      expect(
        (
          await client.query(
            "SELECT instructions_content, instructions_revision::text AS instructions_revision FROM projects",
          )
        )._unsafeUnwrap().rows[0],
      ).toMatchObject({ instructions_content: "project", instructions_revision: "4" });
      expect(
        (
          await runMigrations(client, {
            originalOwner: {
              userId: "00000000-0000-4000-8000-000000000099",
              identityIssuer: "different",
              identitySubject: "different",
            },
          })
        )._unsafeUnwrap(),
      ).toEqual([]);
      expect(
        (await client.query("SELECT owner_user_id FROM projects"))._unsafeUnwrap().rows[0]?.[
          "owner_user_id"
        ],
      ).toBe(OWNER.userId);
    });

    it("preserves initial legacy settings and rejects conflicting mappings", async () => {
      const client = await legacy();
      expect((await runMigrations(client, { originalOwner: OWNER })).isOk()).toBe(true);
      expect(
        (
          await client.query(
            "SELECT user_id, content, revision::text AS revision FROM personal_instructions",
          )
        )._unsafeUnwrap().rows[0],
      ).toMatchObject({ user_id: OWNER.userId, content: "", revision: "0" });
      const conflict = await legacy();
      await conflict.query(
        "INSERT INTO users (id, identity_issuer, identity_subject, created_at, updated_at) VALUES ($1, 'other', 'other', now(), now())",
        [OWNER.userId],
      );
      const result = await runMigrations(conflict, { originalOwner: OWNER });
      expect(result.isErr() && result.error.code).toBe("invariant");
      expect((await conflict.query("SELECT owner_user_id FROM projects")).isErr()).toBe(true);
    });
  });
}
