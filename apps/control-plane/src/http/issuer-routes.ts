import type { SimulationTask } from "determined";
import type { FastifyInstance } from "fastify";
import { type Static, Type } from "typebox";
import type { JwksDeps } from "../domain/ports.ts";
import { assembleJwks } from "../domain/signing-keys.ts";

/**
 * The public OIDC issuer surface (docs/workload-identity.md, "Issuer and
 * signing requirements"): a discovery document and the key set a relying party
 * verifies minted tokens against. Both are public, cacheable, and contain no
 * secret — which is what lets `PI_ORB_ROLE=issuer` run as the deployment's only
 * unauthenticated service, with no secret-store access and no orb data.
 *
 * Every value served here comes from configuration and from the signing-key
 * rows. Nothing is derived from the request: the issuer URL is part of the
 * security identity of every token, so a `Host` header must never be able to
 * change what this deployment claims to be.
 *
 * These two document shapes deliberately stay out of `@pi-orb/protocol`: they
 * have one producer and no first-party consumer — the consumers are external
 * verifiers reading OIDC Discovery and RFC 7517.
 */

export const JWKS_PATH = "/.well-known/jwks.json";
export const OPENID_CONFIGURATION_PATH = "/.well-known/openid-configuration";

/**
 * How long a verifier may serve a cached copy. Five minutes is the same
 * staleness allowance `IssuerConstants.jwksOverlapMs` budgets for on the
 * publishing side (max token lifetime plus five minutes), so a key retired the
 * instant after a fetch is still published for longer than any cache holding
 * the set that named it.
 */
const CACHE_CONTROL = "public, max-age=300";

const closed = { additionalProperties: false } as const;

/**
 * The minimum OpenID Provider Metadata a relying party needs to verify an
 * identity token, and nothing more. pi-orb has no authorization endpoint, no
 * user login, and no token endpoint: this issuer only signs workload tokens
 * that its own runtime route hands out, so the interactive halves of the
 * discovery document would advertise capabilities that do not exist.
 */
export const OidcDiscoveryDocumentSchema = Type.Object(
  {
    issuer: Type.String(),
    jwks_uri: Type.String(),
    /**
     * `id_token` is the standard-conformant minimal answer for an issuer that
     * mints ID tokens directly rather than through an authorization flow; the
     * field is REQUIRED by OpenID Discovery, so it cannot simply be omitted.
     */
    response_types_supported: Type.Array(Type.String()),
    subject_types_supported: Type.Array(Type.String()),
    id_token_signing_alg_values_supported: Type.Array(Type.String()),
    claims_supported: Type.Array(Type.String()),
  },
  closed,
);
export type OidcDiscoveryDocument = Static<typeof OidcDiscoveryDocumentSchema>;

/** RFC 7517 key set: public JWKs, and never anything else. */
export const JwksDocumentSchema = Type.Object({ keys: Type.Array(Type.Unknown()) }, closed);
export type JwksDocument = Static<typeof JwksDocumentSchema>;

export interface IssuerRouteDeps extends JwksDeps {
  /**
   * The deployment's public issuer URL in its canonical form: an origin with
   * no trailing slash, validated at boot (`main.ts`). It is echoed verbatim as
   * `issuer` and is the `iss` claim of every token this deployment mints.
   */
  readonly issuerUrl: string;
}

/** The claims every minted token carries (docs/workload-identity.md). */
const CLAIMS_SUPPORTED: readonly string[] = [
  "iss",
  "aud",
  "sub",
  "iat",
  "exp",
  "jti",
  "project_id",
  "orb_id",
  "host_incarnation",
  "token_use",
];

export function registerIssuerRoutes(
  app: FastifyInstance,
  task: SimulationTask,
  deps: IssuerRouteDeps,
): void {
  const discovery: OidcDiscoveryDocument = {
    issuer: deps.issuerUrl,
    jwks_uri: `${deps.issuerUrl}${JWKS_PATH}`,
    response_types_supported: ["id_token"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    claims_supported: [...CLAIMS_SUPPORTED],
  };

  app.get(OPENID_CONFIGURATION_PATH, async (_request, reply) => {
    reply.header("cache-control", CACHE_CONTROL);
    return reply.send(discovery);
  });

  app.get(JWKS_PATH, async (_request, reply) => {
    const jwks = await assembleJwks(task, deps, { now: task.wallNow() });
    if (jwks.isErr()) {
      // Fail closed and say so: serving an empty or partial key set would make
      // every live token look forged. The error is never cached, and a
      // deterministic bug of ours answers 500 rather than inviting a verifier
      // to retry forever (docs/lifecycle.md).
      // The body is a fixed string on purpose: this is the deployment's one
      // public unauthenticated route, and a raw store message here would hand
      // SQL fragments to the internet (TODO.md tracks the same sanitization
      // for the authenticated routes).
      const invariant = jwks.error.code === "invariant";
      reply.header("cache-control", "no-store");
      return reply.status(invariant ? 500 : 503).send({
        error: invariant ? "internal" : "unavailable",
        message: "signing keys unavailable",
      });
    }
    const document: JwksDocument = { keys: [...jwks.value.keys] };
    reply.header("cache-control", CACHE_CONTROL);
    return reply.send(document);
  });
}
