import { type Static, Type } from "typebox";
import { OrbArchiveErrorSchema } from "./orb-archive.ts";
import { ORB_SPAWN_UUID } from "./orb-spawn.ts";

export const ORB_SEND_PATH = "/runtime/v1/orb/send";
export const ORB_SEND_MAX_BYTES = 64 * 1024;
const orbId = Type.String({ pattern: ORB_SPAWN_UUID.source.replaceAll("a-f", "a-fA-F") });
export const OrbSendRequestSchema = Type.Object(
  {
    v: Type.Literal(1),
    orbId,
    message: Type.String({ minLength: 1, maxLength: ORB_SEND_MAX_BYTES }),
    requestId: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false },
);
export type OrbSendRequest = Static<typeof OrbSendRequestSchema>;
export const OrbSendResponseSchema = Type.Object(
  {
    v: Type.Literal(1),
    orbId,
    messageId: orbId,
    requestId: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false },
);
export type OrbSendResponse = Static<typeof OrbSendResponseSchema>;
export const OrbSendErrorSchema = OrbArchiveErrorSchema;

export type OrbSendError = Static<typeof OrbSendErrorSchema>;
