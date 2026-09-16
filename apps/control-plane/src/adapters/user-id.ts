import { randomUUID } from "node:crypto";
import { Result } from "neverthrow";
import type { IdentityVerificationError, UserIdSource } from "../domain/identity.ts";

export class CryptoUserIdSource implements UserIdSource {
  next(): Result<string, IdentityVerificationError> {
    return Result.fromThrowable(randomUUID, () => ({
      type: "identity_unavailable" as const,
      message: "user ID generation unavailable",
    }))();
  }
}
