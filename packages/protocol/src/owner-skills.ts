import { type Static, Type } from "typebox";

/** Owner-level skills and secrets apply to every project of the owner (docs/owner-skills-secrets.md). */
const closed = { additionalProperties: false } as const;

export const OWNER_SKILLS_PATH = "/api/v1/owner-skills";
export const OWNER_SKILLS_RUNTIME_PATH = "/runtime/v1/owner-skills";
export const OWNER_SECRETS_PATH = "/api/v1/owner-secrets";
export const OWNER_SKILL_MAX_BYTES = 64 * 1024;
export const OWNER_SKILL_MAX_COUNT = 100;
export const OWNER_SKILL_MAX_DESCRIPTION = 1024;
/** Agent Skills name rule shared by Pi and Claude Code: lowercase, digits, single hyphens, ≤ 64. */
export const OWNER_SKILL_NAME_PATTERN = "^(?=.{1,64}$)[a-z0-9]+(-[a-z0-9]+)*$";

export const OwnerSkillNameSchema = Type.String({ pattern: OWNER_SKILL_NAME_PATTERN });
const ContentSchema = Type.String({ maxLength: OWNER_SKILL_MAX_BYTES, pattern: "^[^\\u0000]*$" });

/** POST creates and PUT replaces; the frontmatter name is authoritative (PUT may rename). */
export const WriteOwnerSkillRequestSchema = Type.Object({ content: ContentSchema }, closed);
export type WriteOwnerSkillRequest = Static<typeof WriteOwnerSkillRequestSchema>;

export const OwnerSkillSchema = Type.Object(
  {
    name: OwnerSkillNameSchema,
    description: Type.String({ minLength: 1, maxLength: OWNER_SKILL_MAX_DESCRIPTION }),
    content: ContentSchema,
    updatedAt: Type.String(),
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
      Type.Object({ name: OwnerSkillNameSchema, content: ContentSchema }, closed),
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
