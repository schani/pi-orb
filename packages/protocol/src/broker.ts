import { type Static, Type } from "typebox";

/**
 * Runtime-facing credential-broker contract (DESIGN.md §15.1). Versioned
 * separately from the browser API: this surface is deployment-internal
 * between the control plane and orb runtimes. The response carries a
 * short-lived access token by design — the browser-facing
 * no-credential-serialization guard does not apply to this schema — and the
 * refresh token has no representation here at all.
 */

export const CONTROL_PLANE_URL_ENV = "PI_ORB_CONTROL_PLANE_URL";
export const RUNTIME_TOKEN_ENV = "PI_ORB_RUNTIME_TOKEN";
export const MODEL_TOKEN_PATH = "/runtime/v1/model-token";

const closed = { additionalProperties: false } as const;

export const ModelTokenRequestSchema = Type.Object(
  {
    reason: Type.Union([
      Type.Literal("startup"),
      Type.Literal("expiring"),
      Type.Literal("rejected"),
    ]),
    staleGeneration: Type.Optional(Type.Number()),
  },
  closed,
);
export type ModelTokenRequestBody = Static<typeof ModelTokenRequestSchema>;

export const ModelTokenResponseSchema = Type.Object(
  {
    accessToken: Type.String(),
    accountId: Type.String(),
    /** Wall-clock ms. */
    expiresAt: Type.Number(),
    generation: Type.Number(),
  },
  closed,
);
export type ModelTokenResponseBody = Static<typeof ModelTokenResponseSchema>;

export const ModelTokenErrorSchema = Type.Union([
  Type.Object({ error: Type.Literal("unauthorized") }, closed),
  Type.Object({ error: Type.Literal("auth_required") }, closed),
  Type.Object(
    {
      error: Type.Literal("retryable"),
      message: Type.String(),
      retryAfterMs: Type.Optional(Type.Number()),
    },
    closed,
  ),
]);
export type ModelTokenErrorBody = Static<typeof ModelTokenErrorSchema>;
