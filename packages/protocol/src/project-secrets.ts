import { type Static, Type } from "typebox";

const closed = { additionalProperties: false } as const;

export const PROJECT_SECRET_NAME_PATTERN = "^[A-Za-z_][A-Za-z0-9_]*$";
export const PROJECT_SECRET_MAX_NAMES = 100;
export const PROJECT_SECRET_MAX_VALUE_BYTES = 64 * 1024;
export const PROJECT_SECRET_MAX_BUNDLE_BYTES = 256 * 1024;

export const ProjectSecretNameSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: PROJECT_SECRET_NAME_PATTERN,
});
export type ProjectSecretName = Static<typeof ProjectSecretNameSchema>;

export const PutProjectSecretRequestSchema = Type.Object(
  { value: Type.String({ minLength: 1, maxLength: PROJECT_SECRET_MAX_VALUE_BYTES }) },
  closed,
);
export type PutProjectSecretRequest = Static<typeof PutProjectSecretRequestSchema>;

export const ProjectSecretItemSchema = Type.Object(
  { name: ProjectSecretNameSchema, updatedAt: Type.String() },
  closed,
);
export type ProjectSecretItem = Static<typeof ProjectSecretItemSchema>;

export const ProjectSecretListSchema = Type.Object(
  {
    revision: Type.Integer({ minimum: 0 }),
    items: Type.Array(ProjectSecretItemSchema, { maxItems: PROJECT_SECRET_MAX_NAMES }),
  },
  closed,
);
export type ProjectSecretList = Static<typeof ProjectSecretListSchema>;

export const ProjectSecretSnapshotSchema = Type.Object(
  {
    revision: Type.Integer({ minimum: 0 }),
    values: Type.Unsafe<Record<string, string>>({
      type: "object",
      patternProperties: { [PROJECT_SECRET_NAME_PATTERN]: { type: "string" } },
      additionalProperties: false,
    }),
  },
  closed,
);
export type ProjectSecretSnapshot = Static<typeof ProjectSecretSnapshotSchema>;

export const PROJECT_SECRETS_RUNTIME_PATH = "/runtime/v1/project-secrets";

export const projectSecretsPath = (projectId: string): string =>
  `/api/v1/projects/${encodeURIComponent(projectId)}/secrets`;
export const projectSecretPath = (projectId: string, name: string): string =>
  `${projectSecretsPath(projectId)}/${encodeURIComponent(name)}`;
