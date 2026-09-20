import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NoSimulationTask } from "determined";
import { afterEach, describe, expect, it } from "vitest";
import type { PostgreSQLClient } from "./client.ts";
import { runMigrations } from "./migrate.ts";
import { PostgreSQLUserStore } from "./users.ts";

const migration = "026_google_identities.sql";
const first = {
  userId: "00000000-0000-4000-8000-000000000001",
  oldIssuer: "https://cloud.google.com/iap",
  oldSubject: "accounts.google.com:old-one",
  googleSubject: "google-one",
};
const second = {
  ...first,
  userId: "00000000-0000-4000-8000-000000000002",
  oldSubject: "accounts.google.com:old-two",
  googleSubject: "google-two",
};

export function googleIdentityMigrationContracts(
  label: string,
  open: () => Promise<PostgreSQLClient>,
): void {
  describe(`${label} guarded Google identity migration`, () => {
    const clients: PostgreSQLClient[] = [];
    afterEach(async () => {
      await Promise.all(clients.splice(0).map((client) => client.end()));
    });
    async function prepare(existing = true) {
      const client = await open();
      clients.push(client);
      const dir = join(dirname(fileURLToPath(import.meta.url)), "migrations");
      (
        await client.query(
          "CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
        )
      )._unsafeUnwrap();
      for (const name of readdirSync(dir)
        .filter((name) => name.endsWith(".sql") && name < "026")
        .sort()) {
        (
          await client.transaction(async (_query, execute) =>
            execute(readFileSync(join(dir, name), "utf8")),
          )
        )._unsafeUnwrap();
        (
          await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name])
        )._unsafeUnwrap();
      }
      if (existing) {
        for (const mapping of [first, second])
          (
            await client.query(
              "INSERT INTO users VALUES ($1,$2,$3,'same@heyglide.com',now(),now())",
              [mapping.userId, mapping.oldIssuer, mapping.oldSubject],
            )
          )._unsafeUnwrap();
        (
          await client.query(
            "INSERT INTO projects (id,name,repository_url,owner_user_id,instructions_content,instructions_revision) VALUES ($1,'project','https://example.com/repo',$2,'project instructions',4)",
            ["00000000-0000-4000-8000-000000000003", first.userId],
          )
        )._unsafeUnwrap();
        (
          await client.query(
            "INSERT INTO personal_instructions (user_id,content,revision) VALUES ($1,'instructions',9)",
            [first.userId],
          )
        )._unsafeUnwrap();
        (
          await client.query(
            "INSERT INTO credential_pointers (user_id,provider,row_version,generation,secret_version,refresh_lease_until,last_refresh_at) VALUES ($1,'openai-codex',7,8,'42',123,456)",
            [first.userId],
          )
        )._unsafeUnwrap();
      }
      return client;
    }
    async function snapshot(client: PostgreSQLClient) {
      return Promise.all(
        [
          "users",
          "projects",
          "personal_instructions",
          "credential_pointers",
          "schema_migrations",
        ].map(
          async (table) =>
            (await client.query(`SELECT * FROM ${table} ORDER BY 1`))._unsafeUnwrap().rows,
        ),
      );
    }
    it("needs no inputs on a fresh database", async () => {
      const client = await prepare(false);
      expect((await runMigrations(client))._unsafeUnwrap()).toContain(migration);
    });
    it("changes only exact identity tuples, preserving UUIDs and all dependent data; reruns need no mapping", async () => {
      const client = await prepare();
      const before = await snapshot(client);
      expect(
        (await runMigrations(client, { googleIdentityMappings: [first, second] }))._unsafeUnwrap(),
      ).toContain(migration);
      const after = await snapshot(client);
      expect(after.slice(1, 4)).toEqual(before.slice(1, 4));
      expect(after[0]).toEqual(
        before[0]?.map((row, index) => ({
          ...row,
          identity_issuer: "https://accounts.google.com",
          identity_subject: index === 0 ? first.googleSubject : second.googleSubject,
        })),
      );
      expect((await runMigrations(client))._unsafeUnwrap()).toEqual([]);
      const users = new PostgreSQLUserStore(client);
      const resolved = await users.resolveUser(
        new NoSimulationTask("migrated Google identity", false),
        {
          issuer: "https://accounts.google.com",
          subject: first.googleSubject,
          email: "changed@heyglide.com",
        },
        { id: "00000000-0000-4000-8000-000000000099", now: 100 },
      );
      expect(resolved._unsafeUnwrap().id).toBe(first.userId);
      expect((await snapshot(client)).slice(1, 4)).toEqual(before.slice(1, 4));
    });
    const invalid = [
      ["missing", undefined],
      ["empty", []],
      ["incomplete", [first]],
      ["wrong UUID", [{ ...first, userId: "00000000-0000-4000-8000-000000000009" }, second]],
      ["wrong issuer", [{ ...first, oldIssuer: "iap" }, second]],
      ["wrong old subject", [{ ...first, oldSubject: "wrong" }, second]],
      ["duplicate user", [first, first, second]],
      ["duplicate destination", [first, { ...second, googleSubject: first.googleSubject }]],
      ["blank subject", [{ ...first, googleSubject: " " }, second]],
      ["whitespace subject", [{ ...first, googleSubject: "\t\n" }, second]],
      ["duplicate old tuple", [first, { ...second, oldSubject: first.oldSubject }]],
      ["invalid UUID", [{ ...first, userId: "not-a-uuid" }, second]],
      [
        "extra mapping",
        [
          first,
          second,
          {
            ...first,
            userId: "00000000-0000-4000-8000-000000000009",
            oldSubject: "extra",
            googleSubject: "extra",
          },
        ],
      ],
    ] as const;
    for (const [name, mappings] of invalid)
      it(`rejects ${name} atomically`, async () => {
        const client = await prepare();
        const before = await snapshot(client);
        const result = await runMigrations(client, {
          ...(mappings === undefined ? {} : { googleIdentityMappings: mappings }),
        });
        expect(result.isErr()).toBe(true);
        expect(await snapshot(client)).toEqual(before);
      });
    it("rejects an already-owned destination without linking by email", async () => {
      const client = await prepare();
      (
        await client.query(
          "INSERT INTO users VALUES ($1,'https://accounts.google.com',$2,'same@heyglide.com',now(),now())",
          ["00000000-0000-4000-8000-000000000009", second.googleSubject],
        )
      )._unsafeUnwrap();
      const before = await snapshot(client);
      expect(
        (await runMigrations(client, { googleIdentityMappings: [first, second] })).isErr(),
      ).toBe(true);
      expect(await snapshot(client)).toEqual(before);
    });
  });
}
