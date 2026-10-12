import { err, ok, type Result } from "neverthrow";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";

export const GIT_IDENTITY_PATH = "/api/v1/git-identity";
export const GIT_IDENTITY_RUNTIME_PATH = "/runtime/v1/git-identity";
export const GIT_IDENTITY_MAX_CHARS = 256;

export const GitIdentitySchema = Type.Object(
  { name: Type.String(), email: Type.String() },
  { additionalProperties: false },
);
/** Both empty means cleared (docs/git-identity.md). */
export type GitIdentity = Static<typeof GitIdentitySchema>;

export interface GitIdentityValidationError {
  readonly type: "git_identity_invalid";
  readonly message: string;
}
export function validateGitIdentity(
  body: unknown,
): Result<GitIdentity, GitIdentityValidationError> {
  const invalid = (message: string) =>
    err<GitIdentity, GitIdentityValidationError>({ type: "git_identity_invalid", message });
  if (!Check(GitIdentitySchema, body)) return invalid("Expected {name: string, email: string}");
  if ((body.name === "") !== (body.email === ""))
    return invalid("Set both user.name and user.email, or neither");
  for (const value of [body.name, body.email]) {
    if (value.length > GIT_IDENTITY_MAX_CHARS)
      return invalid(`At most ${GIT_IDENTITY_MAX_CHARS} characters each`);
    if (/[\p{Cc}\p{Cs}<>]/u.test(value)) return invalid("No control characters, < or >");
  }
  if (body.email !== "" && !/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/u.test(body.email))
    return invalid("user.email must be an email address");
  return ok({ name: body.name, email: body.email });
}
