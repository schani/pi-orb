import { errAsync, okAsync } from "neverthrow";
import { expect, it } from "vitest";
import type { StoreError } from "./domain/errors.ts";
import { migrateDatabase } from "./migrate.ts";

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
        migrate: (observe) => {
          observe?.("015_example.sql", "started");
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
