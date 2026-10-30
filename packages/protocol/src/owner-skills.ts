import { err, ok, type Result } from "neverthrow";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";

/** Owner-level skills and secrets apply to every project of the owner (docs/owner-skills-secrets.md). */
const closed = { additionalProperties: false } as const;

export const OWNER_SKILLS_PATH = "/api/v1/owner-skills";
export const OWNER_SKILLS_RUNTIME_PATH = "/runtime/v1/owner-skills";
export const OWNER_SECRETS_PATH = "/api/v1/owner-secrets";
export const OWNER_SKILL_MAX_BYTES = 64 * 1024;
export const OWNER_SKILL_MAX_COUNT = 100;
export const OWNER_SKILLS_MAX_BYTES = 8 * 1024 * 1024;
export const OWNER_SKILLS_MAX_FILES = 1000;
export const OWNER_SKILL_MAX_DESCRIPTION = 1024;
/** Agent Skills name rule shared by Pi and Claude Code: lowercase, digits, single hyphens, ≤ 64. */
export const OWNER_SKILL_NAME_PATTERN = "^(?=.{1,64}$)[a-z0-9]+(-[a-z0-9]+)*$";

const OwnerSkillNameSchema = Type.String({ pattern: OWNER_SKILL_NAME_PATTERN });
const ContentSchema = Type.String({ maxLength: OWNER_SKILL_MAX_BYTES, pattern: "^[^\\u0000]*$" });

/** POST creates and PUT replaces; the frontmatter name is authoritative (PUT may rename). */
export const WriteOwnerSkillRequestSchema = Type.Object({ content: ContentSchema }, closed);
export const AddOwnerSkillRequestSchema = Type.Union([
  WriteOwnerSkillRequestSchema,
  Type.Object({ githubUrl: Type.String({ minLength: 1, maxLength: 2048 }) }, closed),
]);
export const OwnerSkillSourceSchema = Type.Union([
  Type.Null(),
  Type.Object(
    { url: Type.String(), commitSha: Type.String({ pattern: "^[a-f0-9]{40}$" }) },
    closed,
  ),
]);
export const OwnerSkillFileSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 1024 }),
    base64: Type.String({ maxLength: OWNER_SKILLS_MAX_BYTES, pattern: "^[A-Za-z0-9+/]*={0,2}$" }),
    executable: Type.Boolean(),
  },
  closed,
);

export const OwnerSkillSchema = Type.Object(
  {
    name: OwnerSkillNameSchema,
    description: Type.String({ minLength: 1, maxLength: OWNER_SKILL_MAX_DESCRIPTION }),
    content: ContentSchema,
    updatedAt: Type.String(),
    source: OwnerSkillSourceSchema,
  },
  closed,
);
export type OwnerSkill = Static<typeof OwnerSkillSchema>;

export const OwnerSkillListSchema = Type.Object(
  { items: Type.Array(OwnerSkillSchema, { maxItems: OWNER_SKILL_MAX_COUNT }) },
  closed,
);
export type OwnerSkillList = Static<typeof OwnerSkillListSchema>;

export const OwnerSkillsSnapshotSchema = Type.Object(
  {
    skills: Type.Array(
      Type.Object(
        {
          name: OwnerSkillNameSchema,
          content: ContentSchema,
          files: Type.Array(OwnerSkillFileSchema, { maxItems: OWNER_SKILLS_MAX_FILES - 1 }),
          source: OwnerSkillSourceSchema,
        },
        closed,
      ),
      { maxItems: OWNER_SKILL_MAX_COUNT },
    ),
  },
  closed,
);
export type OwnerSkillsSnapshot = Static<typeof OwnerSkillsSnapshotSchema>;

export const ownerSkillPath = (name: string): string =>
  `${OWNER_SKILLS_PATH}/${encodeURIComponent(name)}`;
/** Owner secrets reuse the project-secret list/put schemas and limits. */
export const ownerSecretPath = (name: string): string =>
  `${OWNER_SECRETS_PATH}/${encodeURIComponent(name)}`;

/** Shared import/store/runtime contract; size is the complete JSON wire representation. */
export function validateOwnerSkillsSnapshot(
  value: unknown,
): Result<OwnerSkillsSnapshot, { code: "invalid"; message: string }> {
  const invalid = () =>
    err<OwnerSkillsSnapshot, { code: "invalid"; message: string }>({
      code: "invalid",
      message: "Invalid owner skills snapshot (8 MiB / 1000 files maximum)",
    });
  if (!Check(OwnerSkillsSnapshotSchema, value)) return invalid();
  if (new TextEncoder().encode(JSON.stringify(value)).length > OWNER_SKILLS_MAX_BYTES)
    return invalid();
  const names = new Set<string>();
  let count = 0;
  for (const skill of value.skills) {
    if (
      names.has(skill.name) ||
      new TextEncoder().encode(skill.content).length > OWNER_SKILL_MAX_BYTES ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(skill.content)
    )
      return invalid();
    names.add(skill.name);
    count += 1 + skill.files.length;
    const paths = new Set(["SKILL.md"]);
    for (const file of skill.files) {
      if (
        !validOwnerSkillPath(file.path) ||
        !canonicalOwnerSkillBase64(file.base64) ||
        paths.has(file.path)
      )
        return invalid();
      paths.add(file.path);
    }
    for (const path of paths) {
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++)
        if (paths.has(parts.slice(0, i).join("/"))) return invalid();
    }
  }
  return count > OWNER_SKILLS_MAX_FILES ? invalid() : ok(value);
}
export function validOwnerSkillPath(path: string): boolean {
  return (
    path.length <= 1024 &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: reject filesystem control characters.
    !/[\u0000-\u001f\u007f\\\uD800-\uDFFF]/u.test(path) &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

export function canonicalOwnerSkillBase64(value: string): boolean {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  // Padding bits must be zero; no decoding allocation is needed.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  return value.endsWith("==")
    ? (alphabet.indexOf(value.at(-3) ?? "") & 15) === 0
    : value.endsWith("=")
      ? (alphabet.indexOf(value.at(-2) ?? "") & 3) === 0
      : true;
}
