import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { err, Result } from "neverthrow";
import type { SignerError } from "../../domain/errors.ts";

/**
 * The JOSE surface the issuer needs, written first-party over `node:crypto`
 * rather than pulling in `jose` (decided 2026-08-21, docs/stack.md). Every
 * function here is pure: it takes and returns values, touches no store, and
 * catches every platform throw at this boundary, so nothing above it ever sees
 * an exception (AGENTS.md, "Error handling").
 */

/** A published JWKS entry. Nothing here is secret. */
export interface PublicSigningJwk {
  readonly kty: "RSA";
  /** base64url big-endian modulus. */
  readonly n: string;
  /** base64url public exponent. */
  readonly e: string;
  readonly alg: "RS256";
  readonly use: "sig";
  /** The RFC 7638 thumbprint of this key, which is also the JWT header's `kid`. */
  readonly kid: string;
}

export interface GeneratedRsaKey {
  readonly kid: string;
  /** PKCS#8 PEM. Belongs in the secret store and nowhere else. */
  readonly privateKeyPem: string;
  readonly publicJwk: PublicSigningJwk;
}

/**
 * 2048 bits: the floor every OIDC federation endpoint we target accepts
 * (Google STS, AWS IAM OIDC providers) and the size RS256 verifiers assume.
 * Larger keys buy nothing here — the tokens live ten minutes — and cost
 * signing latency on every mint.
 */
const MODULUS_LENGTH = 2048;

const signerError = (code: SignerError["code"], message: string): SignerError => ({
  type: "signer_error",
  code,
  message,
  retryable: true,
});

/**
 * A platform failure as text. Only the reason is kept: an error raised while
 * handling key material must never carry that material into a log or a
 * response (docs/workload-identity.md).
 */
const describeFailure = (error: unknown): string =>
  error instanceof Error ? error.message : "unknown error";

/** base64url, unpadded: the only encoding JOSE uses. */
export function base64url(value: string | Buffer): string {
  return (typeof value === "string" ? Buffer.from(value, "utf8") : value).toString("base64url");
}

const jsonSegment = (value: unknown): string => base64url(JSON.stringify(value));

/**
 * The RFC 7638 JWK thumbprint: SHA-256 over the canonical JSON of exactly the
 * required members, in lexicographic order, with no whitespace. This is the
 * `kid`, which makes a key's identity derivable from its published JWK alone —
 * a relying party can recompute it and never has to trust the name we chose.
 */
export function rfc7638Thumbprint(jwk: {
  readonly kty: string;
  readonly n: string;
  readonly e: string;
}): Result<string, SignerError> {
  return Result.fromThrowable(
    (): string => {
      const canonical = JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n });
      return base64url(createHash("sha256").update(canonical, "utf8").digest());
    },
    (error) => signerError("unavailable", `jwk thumbprint: ${describeFailure(error)}`),
  )();
}

/**
 * A fresh RSA signing key with its published JWK and derived `kid`. The caller
 * is responsible for putting `privateKeyPem` in the secret store and never
 * anywhere else.
 */
export function generateRsaSigningKey(): Result<GeneratedRsaKey, SignerError> {
  const generate = Result.fromThrowable(
    () => {
      const { privateKey, publicKey } = generateKeyPairSync("rsa", {
        modulusLength: MODULUS_LENGTH,
      });
      const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      const jwk = publicKey.export({ format: "jwk" });
      return { privateKeyPem, jwk };
    },
    (error) => signerError("unavailable", `generate signing key: ${describeFailure(error)}`),
  );
  return generate().andThen(({ privateKeyPem, jwk }) => {
    const { kty, n, e } = jwk;
    if (kty !== "RSA" || typeof n !== "string" || typeof e !== "string") {
      return err(signerError("unavailable", "generated key did not export as an RSA JWK"));
    }
    return rfc7638Thumbprint({ kty, n, e }).map((kid) => ({
      kid,
      privateKeyPem,
      publicJwk: { kty: "RSA", n, e, alg: "RS256", use: "sig", kid } as const,
    }));
  });
}

/**
 * One compact RS256 JWT. `alg` and `typ` are fixed here rather than accepted
 * from the caller: the algorithm a token claims is exactly what an `alg`
 * confusion attack manipulates, and this issuer signs RS256 or nothing
 * (docs/workload-identity.md).
 */
export function signJwtRS256(input: {
  readonly kid: string;
  readonly claims: object;
  readonly privateKeyPem: string;
}): Result<string, SignerError> {
  return Result.fromThrowable(
    (): string => {
      const header = jsonSegment({ alg: "RS256", typ: "JWT", kid: input.kid });
      const payload = jsonSegment(input.claims);
      const signingInput = `${header}.${payload}`;
      // "sha256" over an RSA key is RSASSA-PKCS1-v1_5, which is RS256.
      const signature = sign("sha256", Buffer.from(signingInput, "ascii"), input.privateKeyPem);
      return `${signingInput}.${base64url(signature)}`;
    },
    (error) => signerError("signing_failed", `sign id token: ${describeFailure(error)}`),
  )();
}
