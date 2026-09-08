import { type Static, Type } from "typebox";
import { OrbArchiveErrorSchema } from "./orb-archive.ts";
import { ORB_NAME_MAX_CHARS } from "./orb-naming.ts";

export const ORB_SPAWN_PATH = "/runtime/v1/orbs/:orbId/spawn";
export const ORB_SPAWN_MAX_BYTES = 1024 * 1024;
export const ORB_SPAWN_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export const OrbSpawnRequestSchema = Type.Object(
  {
    prompt: Type.String({ minLength: 1, maxLength: ORB_SPAWN_MAX_BYTES }),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: ORB_NAME_MAX_CHARS })),
  },
  { additionalProperties: false },
);
export type OrbSpawnRequest = Static<typeof OrbSpawnRequestSchema>;
export const OrbSpawnResponseSchema = Type.Object(
  {
    orbId: Type.String(),
    projectId: Type.String(),
    messageId: Type.String(),
    url: Type.String(),
  },
  { additionalProperties: false },
);
export type OrbSpawnResponse = Static<typeof OrbSpawnResponseSchema>;
export const OrbSpawnErrorSchema = OrbArchiveErrorSchema;
