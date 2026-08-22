import { randomUUID } from "node:crypto";
import type { SimulationTask } from "determined";
import { ResultAsync } from "neverthrow";
import type { SignerError } from "../../domain/errors.ts";
import type {
  GeneratedSigningKey,
  IdTokenClaims,
  MintIdSource,
  SigningKeyGenerator,
  SigningKeyMaterialDeps,
  TokenSigner,
} from "../../domain/ports.ts";
import { SigningKeyMaterialCache } from "../../domain/signing-keys.ts";
import { generateRsaSigningKey, signJwtRS256 } from "./jose.ts";

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
   * while the active row still names the same `kid` and secret version, and a
   * rotation is a cache miss by construction.
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

/**
 * RSA key generation for the boot hook and for rotation. Generation is
 * synchronous and takes tens of milliseconds, which is acceptable where it
 * runs: once at boot when no key exists, and on an operator's rotation. It is
 * never on the mint path.
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
