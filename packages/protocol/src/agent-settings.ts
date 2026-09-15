import { type Static, Type } from "typebox";

const closed = { additionalProperties: false } as const;
export const ThinkingLevelSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);
export type ThinkingLevel = Static<typeof ThinkingLevelSchema>;
export const ModelRefSchema = Type.Object(
  { provider: Type.String({ minLength: 1 }), id: Type.String({ minLength: 1 }) },
  closed,
);
export const AgentSettingsSchema = Type.Object(
  { model: ModelRefSchema, thinkingLevel: ThinkingLevelSchema },
  closed,
);
export type AgentSettings = Static<typeof AgentSettingsSchema>;
export const ModelOptionSchema = Type.Object(
  {
    provider: Type.String(),
    id: Type.String(),
    name: Type.String(),
    thinkingLevels: Type.Array(ThinkingLevelSchema),
  },
  closed,
);
export type ModelOption = Static<typeof ModelOptionSchema>;
export const SettingsActionSchema = Type.Union([
  Type.Object({ type: Type.Literal("set_model"), model: ModelRefSchema }, closed),
  Type.Object({ type: Type.Literal("set_thinking"), thinkingLevel: ThinkingLevelSchema }, closed),
]);
export type SettingsAction = Static<typeof SettingsActionSchema>;
export const AgentSettingsEventSchema = Type.Object(
  {
    type: Type.Literal("agent_settings"),
    settings: AgentSettingsSchema,
    models: Type.Array(ModelOptionSchema),
    writable: Type.Boolean(),
  },
  closed,
);
export type AgentSettingsEvent = Static<typeof AgentSettingsEventSchema>;
