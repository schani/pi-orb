import { err, ok, Result } from "neverthrow";
import type { GoogleIdentityMapping } from "./adapters/pg/migrate.ts";

const invalid =
  "PI_ORB_GOOGLE_IDENTITY_MAPPINGS must be an array of exact verified identity mappings";
const parse = Result.fromThrowable(
  (text: string): unknown => JSON.parse(text),
  () => invalid,
);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function googleIdentityMigrationInput(
  env: NodeJS.ProcessEnv,
): Result<readonly GoogleIdentityMapping[] | undefined, string> {
  const raw = env["PI_ORB_GOOGLE_IDENTITY_MAPPINGS"];
  if (raw === undefined) return ok(undefined);
  const parsed = parse(raw);
  if (parsed.isErr()) return err(parsed.error);
  if (!Array.isArray(parsed.value)) return err(invalid);
  const mappings: GoogleIdentityMapping[] = [];
  for (const value of parsed.value) {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).length !== 4
    )
      return err(invalid);
    const { userId, oldIssuer, oldSubject, googleSubject } = value as Record<string, unknown>;
    if (
      typeof userId !== "string" ||
      !uuid.test(userId) ||
      oldIssuer !== "https://cloud.google.com/iap" ||
      typeof oldSubject !== "string" ||
      oldSubject.trim() === "" ||
      typeof googleSubject !== "string" ||
      googleSubject.trim() === ""
    )
      return err(invalid);
    mappings.push({ userId, oldIssuer, oldSubject, googleSubject });
  }
  return ok(mappings);
}
