import { type Static, Type } from "typebox";
import { OrbCleanupErrorSchema, OrbCleanupRequestSchema } from "./orb-cleanup.ts";

export const ORB_SELF_DELETE_PATH = "/runtime/v1/orb/delete";
export const OrbDeleteRequestSchema = OrbCleanupRequestSchema;
export type OrbDeleteRequest = Static<typeof OrbDeleteRequestSchema>;
export const OrbDeleteResponseSchema = Type.Object(
  { orbId: Type.String(), state: Type.Literal("deleting") },
  { additionalProperties: false },
);
export type OrbDeleteResponse = Static<typeof OrbDeleteResponseSchema>;
export const OrbDeleteErrorSchema = OrbCleanupErrorSchema;
