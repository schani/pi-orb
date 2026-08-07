import { type Static, Type } from "typebox";

const closed = { additionalProperties: false } as const;

export const ORB_NAME_MAX_CHARS = 80;
export const ORB_NAME_TRIGGER_PATH = "/runtime/v1/orb-name-trigger";
export const ORB_NAME_MESSAGE_MAX_BYTES = 16 * 1024;
export const ORB_NAME_README_MAX_BYTES = 32 * 1024;

export const OrbNameTriggerSchema = Type.Object(
  {
    text: Type.String({ maxLength: ORB_NAME_MESSAGE_MAX_BYTES }),
    imageOnly: Type.Boolean(),
    readme: Type.Optional(Type.String({ maxLength: ORB_NAME_README_MAX_BYTES })),
  },
  closed,
);
export type OrbNameTrigger = Static<typeof OrbNameTriggerSchema>;

export const OrbNameTriggerResponseSchema = Type.Object(
  {
    outcome: Type.Union([
      Type.Literal("assigned"),
      Type.Literal("already_named"),
      Type.Literal("in_progress"),
      Type.Literal("backoff"),
    ]),
  },
  closed,
);
export type OrbNameTriggerResponse = Static<typeof OrbNameTriggerResponseSchema>;
