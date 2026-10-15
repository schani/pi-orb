import { type Static, Type } from "typebox";
import { ModelRefSchema } from "./agent-settings.ts";
import { MessageInputBlockSchema } from "./frames.ts";
import { OrbMessageSenderIdSchema } from "./orb-message-context.ts";

const closed = { additionalProperties: false } as const;

export const ORB_SELF_SLEEP_PATH = "/runtime/v1/orb/sleep";
export const ORB_BOOT_CONTEXT_PATH = "/runtime/v1/orb/boot-context";

export const OrbMessageSystemSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Union([Type.Literal("sleep_wake"), Type.Literal("sleep_expired")]),
      sleepUntil: Type.String(),
    },
    closed,
  ),
  Type.Object(
    {
      kind: Type.Literal("orb_message"),
      senderOrbId: OrbMessageSenderIdSchema,
    },
    closed,
  ),
]);
export type OrbMessageSystem = Static<typeof OrbMessageSystemSchema>;

export const OrbSleepRequestSchema = Type.Object(
  {
    v: Type.Literal(1),
    durationSeconds: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  },
  closed,
);
export type OrbSleepRequest = Static<typeof OrbSleepRequestSchema>;

export const OrbSleepResponseSchema = Type.Object(
  { v: Type.Literal(1), sleepId: Type.String(), sleepUntil: Type.String() },
  closed,
);
export type OrbSleepResponse = Static<typeof OrbSleepResponseSchema>;

export const OrbBootContextRequestSchema = Type.Object({ v: Type.Literal(1) }, closed);
export type OrbBootContextRequest = Static<typeof OrbBootContextRequestSchema>;

export const OrbBootContextSchema = Type.Object(
  {
    messageId: Type.String(),
    messageIds: Type.Array(Type.String(), { minItems: 1 }),
    content: Type.Array(MessageInputBlockSchema, { minItems: 1 }),
    system: Type.Object({ kind: Type.Literal("sleep_wake"), sleepUntil: Type.String() }, closed),
  },
  closed,
);
export type OrbBootContext = Static<typeof OrbBootContextSchema>;

export const OrbBootContextResponseSchema = Type.Object(
  {
    v: Type.Literal(1),
    context: Type.Union([OrbBootContextSchema, Type.Null()]),
    userTimeZone: Type.Union([Type.String(), Type.Null()]),
    initialModel: Type.Union([ModelRefSchema, Type.Null()]),
  },
  closed,
);
export type OrbBootContextResponse = Static<typeof OrbBootContextResponseSchema>;
