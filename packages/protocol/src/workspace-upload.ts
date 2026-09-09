import { type Static, Type } from "typebox";

export const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
export const UPLOAD_LEASE_MS = 5 * 60 * 1000;
export const UPLOAD_ID_PATTERN =
  "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
export const UploadSpecSchema = Type.Object(
  {
    id: Type.String({ pattern: UPLOAD_ID_PATTERN }),
    name: Type.String({
      minLength: 1,
      maxLength: 180,
      pattern: "^[^/\\\\\\u0000-\\u001f\\u007f]+$",
    }),
    size: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false },
);
export type UploadSpec = Static<typeof UploadSpecSchema>;
export const UploadBatchSchema = Type.Object(
  {
    id: Type.String({ pattern: UPLOAD_ID_PATTERN }),
    files: Type.Array(UploadSpecSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);
export type UploadBatch = Static<typeof UploadBatchSchema>;
export const UploadProgressSchema = Type.Object(
  {
    offset: Type.Integer({ minimum: 0 }),
    path: Type.Union([Type.String(), Type.Null()]),
    sha256: Type.Union([Type.String({ pattern: "^[a-f0-9]{64}$" }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type UploadProgress = Static<typeof UploadProgressSchema>;
export const WorkspaceUploadSchema = Type.Object(
  {
    ...UploadSpecSchema.properties,
    batchId: Type.String({ pattern: UPLOAD_ID_PATTERN }),
    ...UploadProgressSchema.properties,
    status: Type.Union([
      Type.Literal("transferring"),
      Type.Literal("finalizing"),
      Type.Literal("stored"),
      Type.Literal("notified"),
      Type.Literal("cancelled"),
    ]),
    error: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
export type WorkspaceUpload = Static<typeof WorkspaceUploadSchema>;
export const WorkspaceUploadsSchema = Type.Array(WorkspaceUploadSchema);
