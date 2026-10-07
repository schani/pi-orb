import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { type PreviewAdmission, PreviewAdmissionSchema, type PreviewError } from "@pi-orb/protocol";
import { err, ok, Result } from "neverthrow";
import { Check } from "typebox/value";
import type { PreviewVerifier } from "../domain/preview.ts";

export class HmacPreviewVerifier implements PreviewVerifier {
  private readonly key: string;
  constructor(token: string) {
    this.key = createHash("sha256").update(token).digest("hex");
  }
  verify(encoded: string, now: number): Result<PreviewAdmission, PreviewError> {
    const failure: PreviewError = {
      type: "preview_error",
      code: "unauthenticated",
      message: "Invalid preview admission",
    };
    if (encoded.length > 8192) return err(failure);
    const parsed = Result.fromThrowable(
      () => {
        const [payload, signature, extra] = encoded.split(".");
        if (!payload || !signature || extra !== undefined) return null;
        const expected = createHmac("sha256", this.key)
          .update(`pi-orb-preview-admission-v1\n${payload}`)
          .digest();
        const received = Buffer.from(signature, "base64url");
        if (received.length !== expected.length || !timingSafeEqual(received, expected))
          return null;
        return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
      },
      () => failure,
    )();
    if (parsed.isErr() || !Check(PreviewAdmissionSchema, parsed.value)) return err(failure);
    if (
      !Number.isFinite(parsed.value.expiresAt) ||
      parsed.value.expiresAt <= now ||
      parsed.value.expiresAt > now + 10_000
    )
      return err(failure);
    return ok(parsed.value);
  }
}
