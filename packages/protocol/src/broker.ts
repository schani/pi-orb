import { type Static, Type } from "typebox";

/**
 * Runtime-facing credential-broker contract (DESIGN.md §15.1, §15.3).
 * Versioned separately from the browser API: this surface is
 * deployment-internal between the control plane and orb runtimes. One
 * parameterized route serves every token; `{name}` is a logical token name,
 * not an upstream provider id — which provider backs a name is the control
 * plane's business. The response carries a short-lived access token by
 * design — the browser-facing no-credential-serialization guard does not
 * apply to this schema — and refresh tokens have no representation here at
 * all.
 */

export const CONTROL_PLANE_URL_ENV = "PI_ORB_CONTROL_PLANE_URL";
export const RUNTIME_TOKEN_ENV = "PI_ORB_RUNTIME_TOKEN";

export const TOKEN_NAMES = ["model", "github"] as const;
export type TokenName = (typeof TOKEN_NAMES)[number];

export const RUNTIME_TOKENS_PREFIX = "/runtime/v1/tokens";

export function runtimeTokenPath(name: TokenName): string {
  return `${RUNTIME_TOKENS_PREFIX}/${name}`;
}

const closed = { additionalProperties: false } as const;

export const TokenNameSchema = Type.Union(TOKEN_NAMES.map((name) => Type.Literal(name)));

export const TokenRequestSchema = Type.Object(
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
export type TokenRequestBody = Static<typeof TokenRequestSchema>;

export const TokenGrantSchema = Type.Object(
  {
    accessToken: Type.String(),
    /** Model grants carry the account id; GitHub grants carry the user login. */
    accountId: Type.Optional(Type.String()),
    /** Wall-clock ms. */
    expiresAt: Type.Number(),
    generation: Type.Number(),
  },
  closed,
);
export type TokenGrantBody = Static<typeof TokenGrantSchema>;

export const TokenErrorSchema = Type.Union([
  Type.Object({ error: Type.Literal("unauthorized") }, closed),
  Type.Object({ error: Type.Literal("auth_required") }, closed),
  Type.Object({ error: Type.Literal("unknown_token") }, closed),
  Type.Object(
    {
      error: Type.Literal("retryable"),
      message: Type.String(),
      retryAfterMs: Type.Optional(Type.Number()),
    },
    closed,
  ),
]);
export type TokenErrorBody = Static<typeof TokenErrorSchema>;
