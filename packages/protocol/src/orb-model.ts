import { type Static, Type } from "typebox";
import { ModelRefSchema } from "./agent-settings.ts";

const closed = { additionalProperties: false } as const;

export const ORB_MODEL_OPTIONS_PATH = "/api/v1/orbs/:orbId/model-options";
export const ORB_PENDING_MODEL_PATH = "/api/v1/orbs/:orbId/pending-model";

export const PendingModelSchema = Type.Object(
  { changeId: Type.String({ minLength: 1 }), model: ModelRefSchema },
  closed,
);
export type PendingModel = Static<typeof PendingModelSchema>;

export const PutPendingModelRequestSchema = Type.Object({ model: ModelRefSchema }, closed);
export type PutPendingModelRequest = Static<typeof PutPendingModelRequestSchema>;

export const OrbModelOptionSchema = Type.Object(
  {
    ...ModelRefSchema.properties,
    name: Type.String({ minLength: 1 }),
  },
  closed,
);
export type OrbModelOption = Static<typeof OrbModelOptionSchema>;

export const OrbModelOptionsResponseSchema = Type.Object(
  { models: Type.Array(OrbModelOptionSchema) },
  closed,
);
export type OrbModelOptionsResponse = Static<typeof OrbModelOptionsResponseSchema>;
