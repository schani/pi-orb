import { SessionFailed, StorageRequestError } from "@earendil-works/pi-durable";
import type { AuthorityError } from "./index.ts";

/** Fatal Storage failures retain their typed cause across the third-party Session boundary. */
export class StorageFailure extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StorageFailure";
  }
}

/** Decode only our typed cause, including a failed Session wrapping its original failure. */
export function storageAuthorityError(error: unknown): AuthorityError | undefined {
  while (error instanceof SessionFailed) error = error.cause;
  if (!(error instanceof StorageFailure)) return undefined;
  const cause = error.cause;
  if (
    cause &&
    typeof cause === "object" &&
    "type" in cause &&
    cause.type === "store_error" &&
    "code" in cause
  ) {
    if (cause.code === "unavailable")
      return {
        type: "authority_error",
        code: "unavailable",
        message: "Durable authority database unavailable",
      };
    if (cause.code === "corruption" || cause.code === "invariant")
      return {
        type: "authority_error",
        code: "history_integrity",
        message: "Durable storage integrity failure",
      };
  }
  if (
    !cause ||
    typeof cause !== "object" ||
    !("type" in cause) ||
    cause.type !== "authority_error" ||
    !("code" in cause) ||
    (cause.code !== "legacy_backend" &&
      cause.code !== "history_integrity" &&
      cause.code !== "busy" &&
      cause.code !== "unavailable" &&
      cause.code !== "stale_owner" &&
      cause.code !== "missing" &&
      cause.code !== "projection" &&
      cause.code !== "closed") ||
    !("message" in cause) ||
    typeof cause.message !== "string"
  )
    return undefined;
  return { type: "authority_error", code: cause.code, message: cause.message };
}

/** Durable Storage methods signal fatal failures by rejecting, not Result. */
export function rejectStorage(message: string, options?: { cause?: unknown }): never {
  // biome-ignore lint/plugin/no-throw: third-party Durable Storage contract requires promise rejection.
  throw new StorageFailure(message, options);
}

/** Only invalid, effect-free reads may leave the Session usable. */
export function rejectStorageRequest(message: string): never {
  // biome-ignore lint/plugin/no-throw: third-party Durable Storage invalid-read contract requires promise rejection.
  throw new StorageRequestError(message);
}
