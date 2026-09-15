import { err, ok, type Result } from "neverthrow";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";

export const PERSONAL_INSTRUCTIONS_PATH = "/api/v1/personal-instructions";
export const PERSONAL_INSTRUCTIONS_RUNTIME_PATH = "/runtime/v1/personal-instructions";
export const PERSONAL_INSTRUCTIONS_MAX_BYTES = 64 * 1024;

export const PersonalInstructionsWriteSchema = Type.Object(
  { content: Type.String() },
  { additionalProperties: false },
);
export const PersonalInstructionsSchema = Type.Object(
  {
    content: Type.String({ maxLength: PERSONAL_INSTRUCTIONS_MAX_BYTES }),
    revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false },
);
export type PersonalInstructions = Static<typeof PersonalInstructionsSchema>;

export interface PersonalInstructionsValidationError {
  readonly type: "personal_instructions_invalid";
  readonly message: string;
}
/** Preserve exact text; reject strings that cannot round-trip through PostgreSQL UTF-8. */
export function validatePersonalInstructions(
  body: unknown,
): Result<string, PersonalInstructionsValidationError> {
  const invalid = (message: string) =>
    err<string, PersonalInstructionsValidationError>({
      type: "personal_instructions_invalid",
      message,
    });
  if (!Check(PersonalInstructionsWriteSchema, body)) return invalid("Expected {content: string}");
  if (
    body.content.includes("\0") ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(body.content)
  )
    return invalid("Instructions must be valid Unicode without NUL characters");
  if (new TextEncoder().encode(body.content).length > PERSONAL_INSTRUCTIONS_MAX_BYTES)
    return invalid("Instructions must be at most 64 KiB");
  return ok(body.content);
}
