import { type Static, Type } from "typebox";

/**
 * Runtime-facing workload-identity contract (docs/workload-identity.md). It
 * sits beside the credential broker's `RUNTIME_TOKENS_PREFIX` and carries the
 * same per-incarnation bearer, but OIDC identity is not another brokered
 * upstream credential: the control plane is the issuer, there is no refresh
 * token, and the caller supplies no identity — only the audience it wants and
 * how long it wants the token to live. Discovery and JWKS shapes stay inside
 * the control plane: they have one producer and no first-party consumer.
 */

export const ID_TOKEN_PATH = "/runtime/v1/id-token";

/** Token-lifetime bounds shared by the in-orb CLI and the control plane. */
export const MIN_TTL_SECONDS = 60;
export const MAX_TTL_SECONDS = 3600;
export const DEFAULT_TTL_SECONDS = 600;

/** UTF-8 byte cap the control plane enforces on `audience` before minting. */
export const MAX_AUDIENCE_BYTES = 512;

const closed = { additionalProperties: false } as const;

export const IdTokenRequestSchema = Type.Object(
  {
    /**
     * The relying party this token is for. `maxLength` is only a transport
     * bound in characters; `MAX_AUDIENCE_BYTES` is the real limit and is
     * checked in bytes by the control plane.
     */
    audience: Type.String({ minLength: 1, maxLength: 2048 }),
    ttlSeconds: Type.Optional(Type.Integer({ minimum: MIN_TTL_SECONDS, maximum: MAX_TTL_SECONDS })),
  },
  closed,
);
export type IdTokenRequestBody = Static<typeof IdTokenRequestSchema>;

export const IdTokenResponseSchema = Type.Object({ token: Type.String() }, closed);
export type IdTokenResponseBody = Static<typeof IdTokenResponseSchema>;

/**
 * `unauthorized` covers unknown, stale, and discard-fenced bearers
 * identically, so a response never reveals whether another orb exists.
 * `not_mintable` means the bearer is valid but the orb's lifecycle state
 * forbids minting. Only the two throttled/transient codes carry
 * `retryAfterMs`; on the others a delay means nothing.
 *
 * `internal` is a deterministic control-plane bug — the store's `invariant`
 * code — and exists on the wire so the caller can tell it apart from
 * `retryable`. Folding it into `retryable` would tell every CLI to keep
 * re-sending a request that can never succeed, which is the defect
 * `docs/postmortems/2026-08-11-orb-message-jsonb-param-encoding.md` names
 * (added 2026-08-21, docs/workload-identity.md).
 */
export const IdTokenErrorSchema = Type.Union([
  Type.Object(
    { error: Type.Literal("invalid_request"), message: Type.Optional(Type.String()) },
    closed,
  ),
  Type.Object(
    { error: Type.Literal("unauthorized"), message: Type.Optional(Type.String()) },
    closed,
  ),
  Type.Object(
    { error: Type.Literal("not_mintable"), message: Type.Optional(Type.String()) },
    closed,
  ),
  Type.Object(
    {
      error: Type.Literal("rate_limited"),
      message: Type.Optional(Type.String()),
      retryAfterMs: Type.Optional(Type.Number()),
    },
    closed,
  ),
  Type.Object(
    {
      error: Type.Literal("retryable"),
      message: Type.Optional(Type.String()),
      retryAfterMs: Type.Optional(Type.Number()),
    },
    closed,
  ),
  Type.Object({ error: Type.Literal("internal"), message: Type.Optional(Type.String()) }, closed),
]);
export type IdTokenErrorBody = Static<typeof IdTokenErrorSchema>;
export type IdTokenErrorCode = IdTokenErrorBody["error"];

/**
 * The durable per-orb mint failure status (docs/workload-identity.md,
 * "Observability and failure visibility"): a typed code and a timestamp, never
 * the audience, the bearer, or the token. Shared with the browser because the
 * orb view exposes it — a silent refusal is not acceptable. `unauthorized` has
 * no code here: a bearer that resolves to no orb has no row to record it on.
 */
export const MintFailureCodeSchema = Type.Union([
  Type.Literal("invalid_request"),
  Type.Literal("not_mintable"),
  Type.Literal("rate_limited"),
  Type.Literal("signer_failure"),
  Type.Literal("store_unavailable"),
]);
export type MintFailureCode = Static<typeof MintFailureCodeSchema>;
