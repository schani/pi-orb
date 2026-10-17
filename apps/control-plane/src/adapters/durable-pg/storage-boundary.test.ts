import { SessionFailed, StorageRequestError } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import type { AuthorityError } from "./index.ts";
import { StorageFailure, storageAuthorityError } from "./storage-boundary.ts";

it.each<AuthorityError["code"]>([
  "stale_owner",
  "closed",
  "busy",
  "unavailable",
  "projection",
  "missing",
  "legacy_backend",
  "history_integrity",
])("preserves typed %s authority through a failed Session", (code) => {
  const cause: AuthorityError = { type: "authority_error", code, message: "typed authority" };
  expect(
    storageAuthorityError(new SessionFailed(new StorageFailure("storage failed", { cause }))),
  ).toEqual(cause);
  expect(storageAuthorityError(new StorageRequestError("invalid read"))).toBeUndefined();
  expect(storageAuthorityError(new Error("untyped"))).toBeUndefined();
});

it.each([
  { code: "unavailable", expected: "unavailable" },
  { code: "corruption", expected: "history_integrity" },
  { code: "invariant", expected: "history_integrity" },
])("distinguishes $code storage failure from an invalid request", ({ code, expected }) => {
  const error = new StorageFailure("database failed", {
    cause: {
      type: "store_error",
      code,
      message: "private database diagnostic",
      retryable: code === "unavailable",
    },
  });
  expect(storageAuthorityError(new SessionFailed(error))).toMatchObject({
    type: "authority_error",
    code: expected,
  });
  expect(JSON.stringify(storageAuthorityError(error))).not.toContain("private database diagnostic");
});
