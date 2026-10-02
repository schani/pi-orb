import Iron from "@hapi/iron";
import { err, errAsync, ok, type Result, ResultAsync } from "neverthrow";
import type { SealedCookies } from "../domain/application-auth.ts";
import type { IdentityVerificationError } from "../domain/identity.ts";

/** Expiry is authenticated inside the envelope and checked using the service clock. */
export function createSealedAuthCookies(
  secret: string,
): Result<SealedCookies, IdentityVerificationError> {
  if (secret.length < 32)
    return err({ type: "identity_unavailable", message: "Cookie sealing key is too short" });
  const options = { ...Iron.defaults, ttl: 0 };
  return ok({
    seal: (value) =>
      ResultAsync.fromPromise(Iron.seal(value, secret, options), () => ({
        type: "identity_unavailable" as const,
        message: "Cookie sealing unavailable",
      })),
    unseal: (value) =>
      value.length > 8192
        ? errAsync({ type: "unauthenticated" as const, message: "Invalid cookie" })
        : ResultAsync.fromPromise(Iron.unseal(value, secret, options) as Promise<unknown>, () => ({
            type: "unauthenticated" as const,
            message: "Invalid cookie",
          })),
  });
}
