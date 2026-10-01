import { type Static, Type } from "typebox";

export const RUNTIME_ALERT_PATH = "/v1/alert";
export const ALERT_MAX_LENGTH = 4096;
export const RuntimeAlertRequestSchema = Type.Object(
  {
    v: Type.Literal(1),
    message: Type.String({ minLength: 1, maxLength: ALERT_MAX_LENGTH }),
    requestId: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false },
);
export type RuntimeAlertRequest = Static<typeof RuntimeAlertRequestSchema>;
export const RuntimeAlertResponseSchema = Type.Object(
  {
    v: Type.Literal(1),
    id: Type.String(),
    duplicate: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type RuntimeAlertResponse = Static<typeof RuntimeAlertResponseSchema>;
