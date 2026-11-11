import { type Static, Type } from "typebox";
import { ORB_SPAWN_UUID } from "./orb-spawn.ts";

export const ORB_SELF_DELETE_PATH = "/runtime/v1/orb/delete";
export const OrbDeleteRequestSchema = Type.Union([
  Type.Object({ self: Type.Literal(true) }, { additionalProperties: false }),
  Type.Object(
    {
      orbId: Type.String({
        pattern: ORB_SPAWN_UUID.source.replaceAll("a-f", "a-fA-F").replace("[89ab]", "[89aAbB]"),
      }),
    },
    { additionalProperties: false },
  ),
]);
export type OrbDeleteRequest = Static<typeof OrbDeleteRequestSchema>;
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
