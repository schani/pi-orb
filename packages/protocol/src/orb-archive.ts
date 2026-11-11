import { type Static, Type } from "typebox";
import { OrbCleanupErrorSchema, OrbCleanupRequestSchema } from "./orb-cleanup.ts";

export const ORB_SELF_ARCHIVE_PATH = "/runtime/v1/orb/archive";
export const OrbArchiveRequestSchema = OrbCleanupRequestSchema;
export type OrbArchiveRequest = Static<typeof OrbArchiveRequestSchema>;
export const OrbArchiveResponseSchema = Type.Object(
  { orbId: Type.String(), state: Type.Literal("archiving") },
  { additionalProperties: false },
);
export type OrbArchiveResponse = Static<typeof OrbArchiveResponseSchema>;
export const OrbArchiveErrorSchema = OrbCleanupErrorSchema;
