import { randomBytes } from "node:crypto";
import { Result } from "neverthrow";
import type { IdentityVerificationError } from "../domain/identity.ts";
import { createPreviewAuth, type PreviewAuth } from "../domain/preview-auth.ts";
import { createSealedAuthCookies } from "./sealed-auth-cookies.ts";

export function createSealedPreviewAuth(
  secret: string,
  now: () => number,
): Result<PreviewAuth, IdentityVerificationError> {
  return createSealedAuthCookies(secret).map((cookies) =>
    createPreviewAuth({
      cookies,
      now,
      challenge: Result.fromThrowable(
        () => randomBytes(32).toString("base64url"),
        (): IdentityVerificationError => ({
          type: "identity_unavailable",
          message: "Preview challenge unavailable",
        }),
      ),
    }),
  );
}
