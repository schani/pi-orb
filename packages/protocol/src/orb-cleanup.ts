import { type Static, Type } from "typebox";
export const ORB_UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";

export const OrbCleanupRequestSchema = Type.Union([
  Type.Object({ self: Type.Literal(true) }, { additionalProperties: false }),
  Type.Object(
    {
      orbId: Type.String({
        pattern: ORB_UUID_PATTERN,
      }),
    },
    { additionalProperties: false },
  ),
]);
export type OrbCleanupRequest = Static<typeof OrbCleanupRequestSchema>;
export const OrbCleanupErrorSchema = Type.Object(
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
