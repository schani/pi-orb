import { type Static, Type } from "typebox";

export const ORB_SELF_DELETE_PATH = "/runtime/v1/orb/delete";
export const OrbDeleteRequestSchema = Type.Object({}, { additionalProperties: false });
export const OrbDeleteResponseSchema = Type.Object(
  { orbId: Type.String(), state: Type.Literal("deleting") },
  { additionalProperties: false },
);
export type OrbDeleteResponse = Static<typeof OrbDeleteResponseSchema>;
export const OrbDeleteErrorSchema = Type.Object(
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
