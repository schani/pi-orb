import { type Static, Type } from "typebox";

const closed = { additionalProperties: false } as const;
export const HOSTING_FILES_PATH = "/runtime/v1/hosting/files";
export const HOSTING_REQUEST_ID_HEADER = "x-pi-orb-request-id";
export const HOSTING_SHA256_HEADER = "x-pi-orb-sha256";
export const HOSTING_TRANSFER_TIMEOUT_MS = 5 * 60_000;
export const HOSTING_MAX_FILE_BYTES = 32 * 1024 * 1024;
export const HostingRequestIdSchema = Type.String({ format: "uuid" });
export const HostingSha256Schema = Type.String({ pattern: "^[a-f0-9]{64}$" });
export const HostedPathSchema = Type.String({
  maxLength: 1024,
  minLength: 1,
  pattern:
    "^(?!/)(?!.*//)(?!.*(?:^|/)\\.\\.?(?:/|$))(?!.*[\\/\\\\]$)[^\\u0000-\\u001f\\u007f\\\\]+$",
});
export const HostingUploadMetadataSchema = Type.Object(
  {
    mediaType: Type.String({ minLength: 1 }),
    path: HostedPathSchema,
    requestId: HostingRequestIdSchema,
    sha256: HostingSha256Schema,
    size: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
  },
  closed,
);

export const HostedFileViewSchema = Type.Object(
  {
    mediaType: Type.String({ minLength: 1 }),
    path: HostedPathSchema,
    size: Type.Integer({ minimum: 0 }),
    updatedAt: Type.Number(),
    url: Type.String({ pattern: "^https?://" }),
  },
  closed,
);
export type HostedFileView = Static<typeof HostedFileViewSchema>;
export const HostedFileResponseSchema = Type.Object({ file: HostedFileViewSchema }, closed);
export type HostedFileResponse = Static<typeof HostedFileResponseSchema>;
export const HostedFilesResponseSchema = Type.Object(
  {
    cleanupIssues: Type.Array(
      Type.Object(
        {
          lastError: Type.String(),
          lastErrorAt: Type.Number(),
          path: Type.Union([HostedPathSchema, Type.Null()]),
        },
        closed,
      ),
    ),
    files: Type.Array(HostedFileViewSchema),
  },
  closed,
);
export type HostedFilesResponse = Static<typeof HostedFilesResponseSchema>;
export const HostedFileDeleteResponseSchema = Type.Object({ path: HostedPathSchema }, closed);
export type HostedFileDeleteResponse = Static<typeof HostedFileDeleteResponseSchema>;
export const HostingErrorSchema = Type.Object(
  {
    error: Type.Object(
      {
        code: Type.Union(
          [
            "invalid_request",
            "unauthorized",
            "not_found",
            "conflict",
            "too_large",
            "unavailable",
            "internal",
          ].map((code) => Type.Literal(code)),
        ),
        message: Type.String(),
        retryable: Type.Boolean(),
      },
      closed,
    ),
  },
  closed,
);
export type HostingErrorBody = Static<typeof HostingErrorSchema>;
