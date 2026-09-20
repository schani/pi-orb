import { readFileSync } from "node:fs";
import { errAsync, okAsync } from "neverthrow";
import { expect, it } from "vitest";
import type { StoreError } from "./domain/errors.ts";
import { migrateDatabase, migrationOwnerInput, originalOwnerMigrationInput } from "./migrate.ts";

it("accepts original-owner migration input only when all fields are present", () => {
  expect(originalOwnerMigrationInput({})._unsafeUnwrap()).toBeUndefined();
  expect(originalOwnerMigrationInput({ PI_ORB_ORIGINAL_USER_ID: "bad" }).isErr()).toBe(true);
  expect(
    originalOwnerMigrationInput({
      PI_ORB_ORIGINAL_USER_ID: "00000000-0000-4000-8000-000000000001",
      PI_ORB_ORIGINAL_IDENTITY_ISSUER: "   ",
      PI_ORB_ORIGINAL_IDENTITY_SUBJECT: "subject",
    }).isErr(),
  ).toBe(true);
  expect(
    originalOwnerMigrationInput({
      PI_ORB_ORIGINAL_USER_ID: "00000000-0000-4000-8000-000000000001",
      PI_ORB_ORIGINAL_IDENTITY_ISSUER: "issuer",
      PI_ORB_ORIGINAL_IDENTITY_SUBJECT: "subject",
    })._unsafeUnwrap(),
  ).toEqual({
    userId: "00000000-0000-4000-8000-000000000001",
    identityIssuer: "issuer",
    identitySubject: "subject",
  });
});

it("selects the credential owner independently while rejecting partial or conflicting inputs", () => {
  const userId = "00000000-0000-4000-8000-000000000001";
  expect(migrationOwnerInput({ PI_ORB_USER_ID: userId })._unsafeUnwrap()).toEqual({
    credentialOwnerUserId: userId,
  });
  expect(
    migrationOwnerInput({
      PI_ORB_USER_ID: userId,
      PI_ORB_ORIGINAL_USER_ID: userId,
    }).isErr(),
  ).toBe(true);
  expect(
    migrationOwnerInput({
      PI_ORB_USER_ID: userId,
      PI_ORB_ORIGINAL_USER_ID: "00000000-0000-4000-8000-000000000002",
      PI_ORB_ORIGINAL_IDENTITY_ISSUER: "issuer",
      PI_ORB_ORIGINAL_IDENTITY_SUBJECT: "subject",
    }).isErr(),
  ).toBe(true);
});

it("uses the shared owner input for local startup migrations", () => {
  const main = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
  expect(main).toContain("const migrationOwner = migrationOwnerInput(process.env)");
  expect(main).toContain("database.migrate(migrationOwner._unsafeUnwrap())");
  expect(main).not.toContain("originalOwnerMigrationInput(process.env)");
});

it("closes after migration failure and logs only typed codes", async () => {
  const lines: string[] = [];
  let closed = false;
  const error: StoreError = {
    type: "store_error",
    code: "invariant",
    message: "private-sentinel",
    retryable: false,
  };
  expect(
    await migrateDatabase(
      {
        migrate: (options) => {
          options?.observe?.("015_example.sql", "started");
          return errAsync(error);
        },
        close: () => {
          closed = true;
          return okAsync(undefined);
        },
      },
      (line) => lines.push(line),
    ),
  ).toBe(1);
  expect(closed).toBe(true);
  expect(lines.join("\n")).toContain("015_example.sql");
  expect(lines.join("\n")).not.toContain("private-sentinel");
});

it("logs credential owner resolution without identity values", async () => {
  const lines: string[] = [];
  expect(
    await migrateDatabase(
      {
        migrate: (options) => {
          options?.observeOwnerResolution?.("users", "resolved");
          return okAsync([]);
        },
        close: () => okAsync(undefined),
      },
      (line) => lines.push(line),
      { credentialOwnerUserId: "00000000-0000-4000-8000-000000000001" },
    ),
  ).toBe(0);
  expect(lines).toContain("lifecycle: migration-owner-resolution source=users outcome=resolved");
  expect(lines.join("\n")).not.toContain("00000000");
});

it("passes verified Google mappings only to the migration job and logs counts, not identities", async () => {
  const lines: string[] = [];
  const googleIdentityMappings = [
    {
      userId: "00000000-0000-4000-8000-000000000001",
      oldIssuer: "https://cloud.google.com/iap",
      oldSubject: "private-old-subject",
      googleSubject: "private-google-subject",
    },
  ];
  expect(
    await migrateDatabase(
      {
        migrate: (options) => {
          expect(options?.googleIdentityMappings).toEqual(googleIdentityMappings);
          options?.observe?.("026_google_identities.sql", "applied");
          return okAsync(["026_google_identities.sql"]);
        },
        close: () => okAsync(undefined),
      },
      (line) => lines.push(line),
      { googleIdentityMappings },
    ),
  ).toBe(0);
  expect(lines).toContain("lifecycle: migration-google-identities mapped=1");
  expect(lines.join("\n")).not.toContain("private-");
  expect(lines.join("\n")).not.toContain("00000000");
  const main = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
  expect(main).not.toContain("googleIdentityMigrationInput");
  expect(
    migrationOwnerInput({
      PI_ORB_GOOGLE_IDENTITY_MAPPINGS: JSON.stringify(googleIdentityMappings),
    })._unsafeUnwrap(),
  ).toEqual({});
});

it("reports successful migration and treats close failure as a failed job", async () => {
  const lines: string[] = [];
  expect(
    await migrateDatabase(
      {
        migrate: () => okAsync(["015_example.sql"]),
        close: () =>
          errAsync({
            type: "store_error",
            code: "unavailable",
            message: "private-sentinel",
            retryable: true,
          }),
      },
      (line) => lines.push(line),
    ),
  ).toBe(1);
  expect(lines).toContain("lifecycle: migration-checked applied=1");
  expect(lines.join("\n")).not.toContain("private-sentinel");
});
