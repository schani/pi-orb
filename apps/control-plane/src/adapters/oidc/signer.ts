import { randomUUID } from "node:crypto";
import type { SimulationTask } from "determined";
import { ResultAsync } from "neverthrow";
import type { IdTokenVerifier } from "../../domain/access-token.ts";
import type { SignerError } from "../../domain/errors.ts";
import type {
  GeneratedSigningKey,
  IdTokenClaims,
  JwksDeps,
  MintIdSource,
  SigningKeyGenerator,
  SigningKeyMaterialDeps,
  TokenSigner,
} from "../../domain/ports.ts";
import { assembleJwks, SigningKeyMaterialCache } from "../../domain/signing-keys.ts";
import { generateRsaSigningKey, signJwtRS256, verifyJwtRS256 } from "./jose.ts";

/**
 * The production identity signer (docs/workload-identity.md). It composes the
 * domain's key selection — which key is active, and which exact secret version
 * holds its material — with the RS256 primitives in `jose.ts`. Every
 * `node:crypto` call is caught there, so this file returns typed results only.
 */
export class OidcTokenSigner implements TokenSigner {
  private readonly deps: SigningKeyMaterialDeps;
  /**
   * Steady-state signing is one key-row read: the private material is reused
   * while the active row still names the same `kid` and secret version and the
   * material is younger than `signingKeyMaterialTtlMs`; a rotation is a cache
   * miss by construction.
   */
  private readonly material = new SigningKeyMaterialCache();

  constructor(deps: SigningKeyMaterialDeps) {
    this.deps = deps;
  }

  signIdToken(
    task: SimulationTask,
    claims: IdTokenClaims,
  ): ResultAsync<{ jwt: string; kid: string }, SignerError> {
    return this.material.load(task, this.deps).andThen((key) =>
      signJwtRS256({ kid: key.kid, claims, privateKeyPem: key.privateKeyPem }).map((jwt) => ({
        jwt,
        kid: key.kid,
      })),
    );
  }
}

/** Checks this issuer's own tokens against the keys its JWKS publishes, read per call. */
export class OidcTokenVerifier implements IdTokenVerifier {
  private readonly deps: JwksDeps;

  constructor(deps: JwksDeps) {
    this.deps = deps;
  }

  verify(task: SimulationTask, jwt: string) {
    return assembleJwks(task, this.deps, { now: task.wallNow() })
      .mapErr(() => ({
        type: "identity_unavailable" as const,
        message: "Signing keys unavailable",
      }))
      .andThen((jwks) =>
        verifyJwtRS256(jwt, jwks.keys).mapErr(() => ({
          type: "unauthenticated" as const,
          message: "Invalid id token",
        })),
      );
  }
}

/**
 * RSA key generation for the boot hook and for rotation. It blocks the event
 * loop for the whole keygen, which is acceptable only there: at boot when no
 * key exists, and on an operator's rotation. It is never on the mint path.
 */
export class NodeCryptoSigningKeyGenerator implements SigningKeyGenerator {
  generate(_task: SimulationTask): ResultAsync<GeneratedSigningKey, SignerError> {
    return new ResultAsync(Promise.resolve(generateRsaSigningKey()));
  }
}

/**
 * `jti` entropy. A v4 UUID is unpredictable and unique, which is what a
 * relying party's replay defense keys on; it carries no orb information.
 */
export class CryptoMintIdSource implements MintIdSource {
  newJti(_task: SimulationTask): string {
    return randomUUID();
  }
}
