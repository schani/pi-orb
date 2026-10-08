import { StorageRejected } from "@earendil-works/pi-durable";
import type { AuthorityError } from "./index.ts";

/** Decode only our typed terminal cause at the third-party rejection boundary. */
export function storageAuthorityError(error: unknown): AuthorityError | undefined {
  if (!(error instanceof StorageRejected)) return undefined;
  const cause = error.cause;
  if (
    !cause ||
    typeof cause !== "object" ||
    !("type" in cause) ||
    cause.type !== "authority_error" ||
    !("code" in cause) ||
    (cause.code !== "legacy_backend" && cause.code !== "history_integrity") ||
    !("message" in cause) ||
    typeof cause.message !== "string"
  )
    return undefined;
  return { type: "authority_error", code: cause.code, message: cause.message };
}

/** Durable's third-party Storage interface signals rejection by throwing, not Result. */
export function rejectStorage(message: string, options?: { cause?: unknown }): never {
  // biome-ignore lint/plugin/no-throw: third-party Durable Storage contract requires promise rejection.
  throw new StorageRejected(message, options);
}
