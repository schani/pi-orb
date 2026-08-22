import { createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  base64url,
  generateRsaSigningKey,
  type PublicSigningJwk,
  rfc7638Thumbprint,
  signJwtRS256,
} from "./jose.ts";

/**
 * The RSA example of RFC 7638 section 3.1 together with its published
 * thumbprint. This is the one `kid` derivation a relying party can reproduce
 * independently, so it is asserted against the RFC's own vector rather than
 * against whatever this implementation happens to produce.
 */
const RFC_7638_JWK = {
  kty: "RSA",
  n:
    "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJ" +
    "ECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW" +
    "2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQ" +
    "Fh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw",
  e: "AQAB",
} as const;
const RFC_7638_THUMBPRINT = "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs";

function decodeSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

const CLAIMS = {
  iss: "https://issuer.pi-orb.test",
  aud: "urn:example:service",
  sub: "orb-a",
  iat: 1_767_225_600,
  exp: 1_767_226_200,
  jti: "01234567-89ab-cdef-0123-456789abcdef",
  project_id: "project-a",
  orb_id: "orb-a",
  host_incarnation: 3,
  token_use: "exchanged",
};

describe("base64url", () => {
  it("encodes without padding and without the URL-unsafe alphabet", () => {
    expect(base64url("a")).toBe("YQ");
    expect(base64url("ab")).toBe("YWI");
    expect(base64url(Buffer.from([0xfb, 0xff, 0xbe]))).toBe("-_--");
    expect(base64url("{}")).not.toContain("=");
  });
});

describe("rfc7638Thumbprint", () => {
  it("reproduces the thumbprint published in RFC 7638 section 3.1", () => {
    expect(rfc7638Thumbprint(RFC_7638_JWK)._unsafeUnwrap()).toBe(RFC_7638_THUMBPRINT);
  });

  it("ignores every member outside the canonical {e, kty, n} form", () => {
    // A JWK carrying alg/use/kid must thumbprint identically, or a key would
    // change its own identity the moment it is published.
    const decorated = { ...RFC_7638_JWK, alg: "RS256", use: "sig", kid: "ignored" };
    expect(rfc7638Thumbprint(decorated)._unsafeUnwrap()).toBe(RFC_7638_THUMBPRINT);
  });

  it("is deterministic for one key and different across keys", () => {
    const first = generateRsaSigningKey()._unsafeUnwrap();
    const second = generateRsaSigningKey()._unsafeUnwrap();
    expect(rfc7638Thumbprint(first.publicJwk)._unsafeUnwrap()).toBe(first.kid);
    expect(rfc7638Thumbprint(first.publicJwk)._unsafeUnwrap()).toBe(
      rfc7638Thumbprint(first.publicJwk)._unsafeUnwrap(),
    );
    expect(second.kid).not.toBe(first.kid);
  });
});

describe("generateRsaSigningKey", () => {
  it("produces a 2048-bit PKCS#8 key whose JWK is publishable as it stands", () => {
    const key = generateRsaSigningKey()._unsafeUnwrap();
    expect(key.privateKeyPem.startsWith("-----BEGIN PRIVATE KEY-----")).toBe(true);
    expect(key.publicJwk).toMatchObject({
      kty: "RSA",
      alg: "RS256",
      use: "sig",
      kid: key.kid,
      e: "AQAB",
    });
    // 2048 bits of modulus, exactly what the JWKS consumer will verify with.
    expect(Buffer.from(key.publicJwk.n, "base64url").length).toBe(256);
    // The public half is derivable from the PEM alone: the JWK adds no secret.
    const exported = createPublicKey({ key: key.privateKeyPem, format: "pem" }).export({
      format: "jwk",
    });
    expect(exported.n).toBe(key.publicJwk.n);
  });

  it("never puts private material in the published JWK", () => {
    const key = generateRsaSigningKey()._unsafeUnwrap();
    const jwk = key.publicJwk as unknown as Record<string, unknown>;
    for (const secretMember of ["d", "p", "q", "dp", "dq", "qi"]) {
      expect(jwk[secretMember]).toBeUndefined();
    }
  });
});

describe("signJwtRS256", () => {
  it("round-trips: the compact JWT verifies against the exported JWK", () => {
    const key = generateRsaSigningKey()._unsafeUnwrap();
    const jwt = signJwtRS256({
      kid: key.kid,
      claims: CLAIMS,
      privateKeyPem: key.privateKeyPem,
    })._unsafeUnwrap();

    const segments = jwt.split(".");
    expect(segments.length).toBe(3);
    const [header, payload, signature] = segments as [string, string, string];
    expect(decodeSegment(header)).toEqual({ alg: "RS256", typ: "JWT", kid: key.kid });
    expect(decodeSegment(payload)).toEqual(CLAIMS);

    // The relying party's path: import the published JWK, verify the signature
    // over the exact signing input. No padding characters may appear anywhere.
    const publicKey = createPublicKey({ key: key.publicJwk as object, format: "jwk" });
    expect(jwt).not.toContain("=");
    expect(
      verify(
        "sha256",
        Buffer.from(`${header}.${payload}`, "ascii"),
        publicKey,
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
  });

  it("does not verify once any segment is tampered with", () => {
    const key = generateRsaSigningKey()._unsafeUnwrap();
    const jwt = signJwtRS256({
      kid: key.kid,
      claims: CLAIMS,
      privateKeyPem: key.privateKeyPem,
    })._unsafeUnwrap();
    const [header, , signature] = jwt.split(".") as [string, string, string];
    const forged = base64url(JSON.stringify({ ...CLAIMS, orb_id: "orb-someone-else" }));
    const publicKey = createPublicKey({ key: key.publicJwk as object, format: "jwk" });
    expect(
      verify(
        "sha256",
        Buffer.from(`${header}.${forged}`, "ascii"),
        publicKey,
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(false);
  });

  it("does not verify against a different key's JWK", () => {
    const key = generateRsaSigningKey()._unsafeUnwrap();
    const other = generateRsaSigningKey()._unsafeUnwrap();
    const jwt = signJwtRS256({
      kid: key.kid,
      claims: CLAIMS,
      privateKeyPem: key.privateKeyPem,
    })._unsafeUnwrap();
    const [header, payload, signature] = jwt.split(".") as [string, string, string];
    expect(
      verify(
        "sha256",
        Buffer.from(`${header}.${payload}`, "ascii"),
        createPublicKey({ key: other.publicJwk as object, format: "jwk" }),
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(false);
  });

  it("returns a typed signer error instead of throwing on unusable key material", () => {
    const result = signJwtRS256({
      kid: "kid-broken",
      claims: CLAIMS,
      privateKeyPem: "-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----\n",
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("signer_error");
      expect(result.error.code).toBe("signing_failed");
      expect(result.error.retryable).toBe(true);
      // The failure text must never carry the material it failed on.
      expect(result.error.message).not.toContain("BEGIN PRIVATE KEY");
    }
  });

  it("keeps a mint's claim set byte-identical through the payload segment", () => {
    // A relying party's attribute mapping reads exactly these bytes, so the
    // encoder may not reorder, re-number, or drop anything.
    const key = generateRsaSigningKey()._unsafeUnwrap();
    const jwt = signJwtRS256({
      kid: key.kid,
      claims: CLAIMS,
      privateKeyPem: key.privateKeyPem,
    })._unsafeUnwrap();
    const payload = jwt.split(".")[1] as string;
    expect(Buffer.from(payload, "base64url").toString("utf8")).toBe(JSON.stringify(CLAIMS));
  });
});

describe("published key material", () => {
  it("thumbprints a generated key the way an external verifier would", () => {
    // The verifier only ever sees the JWKS entry; recomputing the thumbprint
    // from it must reproduce the `kid` the JWT header carries.
    const key = generateRsaSigningKey()._unsafeUnwrap();
    const published: PublicSigningJwk = key.publicJwk;
    const jwt = signJwtRS256({
      kid: key.kid,
      claims: CLAIMS,
      privateKeyPem: key.privateKeyPem,
    })._unsafeUnwrap();
    const header = decodeSegment(jwt.split(".")[0] as string) as { kid: string };
    expect(rfc7638Thumbprint(published)._unsafeUnwrap()).toBe(header.kid);
  });
});
