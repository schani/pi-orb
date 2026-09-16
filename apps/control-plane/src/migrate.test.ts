import { errAsync, okAsync } from "neverthrow";
import { expect, it } from "vitest";
import type { StoreError } from "./domain/errors.ts";
import { migrateDatabase, originalOwnerMigrationInput } from "./migrate.ts";

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
