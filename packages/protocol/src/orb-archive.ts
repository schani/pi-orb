import { type Static, Type } from "typebox";

export const ORB_SELF_ARCHIVE_PATH = "/runtime/v1/orb/archive";
export const OrbArchiveRequestSchema = Type.Object({}, { additionalProperties: false });
export const OrbArchiveResponseSchema = Type.Object(
  { orbId: Type.String(), state: Type.Literal("archiving") },
  { additionalProperties: false },
);
export type OrbArchiveResponse = Static<typeof OrbArchiveResponseSchema>;
export const OrbArchiveErrorSchema = Type.Object(
  {
    error: Type.Object(
      {
        code: Type.Union([
          Type.Literal("invalid_request"),
          Type.Literal("unauthorized"),
          Type.Literal("not_found"),
          Type.Literal("conflict"),
          Type.Literal("unavailable"),
          Type.Literal("internal"),
        ]),
        message: Type.String(),
        retryable: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
