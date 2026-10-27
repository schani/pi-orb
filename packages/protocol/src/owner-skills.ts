import { type Static, Type } from "typebox";

/** Owner-level skills and secrets apply to every project of the owner (docs/owner-skills-secrets.md). */
const closed = { additionalProperties: false } as const;

export const OWNER_SKILLS_PATH = "/api/v1/owner-skills";
export const OWNER_SKILL_PREVIEW_PATH = `${OWNER_SKILLS_PATH}/preview`;
export const OWNER_SKILL_IMPORT_PATH = `${OWNER_SKILLS_PATH}/import`;
export const OWNER_SKILLS_RUNTIME_PATH = "/runtime/v1/owner-skills";
export const OWNER_SECRETS_PATH = "/api/v1/owner-secrets";
export const OWNER_SKILL_MAX_BYTES = 64 * 1024;
export const OWNER_SKILL_MAX_COUNT = 100;
export const OWNER_SKILL_BUNDLE_MAX_BYTES = 8 * 1024 * 1024;
export const OWNER_SKILL_BUNDLE_MAX_FILES = 5000;
export const OWNER_SKILLS_MAX_BYTES = 16 * 1024 * 1024;
export const OWNER_SKILLS_MAX_JSON_BYTES = 24 * 1024 * 1024;
export const OWNER_SKILL_PATH_MAX_BYTES = 1024;
export const OWNER_SKILL_MAX_DESCRIPTION = 1024;
/** Agent Skills name rule shared by Pi and Claude Code: lowercase, digits, single hyphens, ≤ 64. */
export const OWNER_SKILL_NAME_PATTERN = "^(?=.{1,64}$)[a-z0-9]+(-[a-z0-9]+)*$";

const OwnerSkillNameSchema = Type.String({ pattern: OWNER_SKILL_NAME_PATTERN });
const ContentSchema = Type.String({ maxLength: OWNER_SKILL_MAX_BYTES, pattern: "^[^\\u0000]*$" });

/** POST creates and PUT replaces; the frontmatter name is authoritative (PUT may rename). */
export const WriteOwnerSkillRequestSchema = Type.Object({ content: ContentSchema }, closed);

export const OwnerSkillFileSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: OWNER_SKILL_PATH_MAX_BYTES }),
    base64: Type.String({ maxLength: Math.ceil(OWNER_SKILL_BUNDLE_MAX_BYTES / 3) * 4 }),
    executable: Type.Boolean(),
  },
  closed,
);
export type OwnerSkillFile = Static<typeof OwnerSkillFileSchema>;
export const OwnerSkillSourceMetadataSchema = Type.Object(
  {
    url: Type.String({ minLength: 1, maxLength: 4096 }),
    commitSha: Type.String({ pattern: "^[a-f0-9]{40}$" }),
  },
  closed,
);
export type OwnerSkillSourceMetadata = Static<typeof OwnerSkillSourceMetadataSchema>;
const SourceSchema = Type.Union([OwnerSkillSourceMetadataSchema, Type.Null()]);
const FileCountSchema = Type.Integer({ minimum: 1, maximum: OWNER_SKILL_BUNDLE_MAX_FILES });
const TotalBytesSchema = Type.Integer({ minimum: 0, maximum: OWNER_SKILL_BUNDLE_MAX_BYTES });
export const PreviewOwnerSkillRequestSchema = Type.Object(
  {
    url: Type.String({ minLength: 1, maxLength: 4096 }),
  },
  closed,
);
export const ImportOwnerSkillRequestSchema = OwnerSkillSourceMetadataSchema;
export const OwnerSkillPreviewSchema = Type.Object(
  {
    name: OwnerSkillNameSchema,
    description: Type.String({ minLength: 1, maxLength: OWNER_SKILL_MAX_DESCRIPTION }),
    content: ContentSchema,
    source: OwnerSkillSourceMetadataSchema,
    manifest: Type.Array(
      Type.Object(
        {
          path: Type.String(),
          bytes: Type.Integer({ minimum: 0 }),
          executable: Type.Boolean(),
        },
        closed,
      ),
      { maxItems: OWNER_SKILL_BUNDLE_MAX_FILES },
    ),
    fileCount: FileCountSchema,
    totalBytes: TotalBytesSchema,
  },
  closed,
);
export type OwnerSkillPreview = Static<typeof OwnerSkillPreviewSchema>;

export const OwnerSkillSchema = Type.Object(
  {
    name: OwnerSkillNameSchema,
    description: Type.String({ minLength: 1, maxLength: OWNER_SKILL_MAX_DESCRIPTION }),
    content: ContentSchema,
    updatedAt: Type.String(),
    source: SourceSchema,
    fileCount: FileCountSchema,
    totalBytes: TotalBytesSchema,
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
          files: Type.Array(OwnerSkillFileSchema, { maxItems: OWNER_SKILL_BUNDLE_MAX_FILES - 1 }),
          source: SourceSchema,
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
