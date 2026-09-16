import { generateKeyPairSync, sign } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import { describe, expect, it } from "vitest";
import { IapIdentityVerifier, IapPublicKeyCache, readIapAudience } from "./iap-identity.ts";

const audience = "/projects/123/locations/us-central1/services/pi-orb";
const now = Math.floor(Date.now() / 1_000);
const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
const pubkey = pair.publicKey.export({ format: "pem", type: "spki" }).toString();

function token(
  overrides: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
): string {
  const encodedHeader = Buffer.from(
    JSON.stringify({ alg: "ES256", kid: "key-1", typ: "JWT", ...header }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: "https://cloud.google.com/iap",
      aud: audience,
      sub: "subject-1",
      email: "dev@example.test",
      iat: now - 10,
      exp: now + 300,
      ...overrides,
    }),
  ).toString("base64url");
  const body = `${encodedHeader}.${payload}`;
  const signature = sign("sha256", Buffer.from(body), {
    key: pair.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${body}.${signature.toString("base64url")}`;
}

function verifier(keys: Record<string, string | object> = { "key-1": pubkey }) {
  const google = new OAuth2Client();
  return new IapIdentityVerifier(audience, () => now * 1_000, {
    getIapPublicKeysAsync: async () => ({ pubkeys: keys }),
    verifySignedJwtWithCertsAsync: (jwt, certs, aud, issuers) =>
      google.verifySignedJwtWithCertsAsync(
        jwt,
        certs as Parameters<OAuth2Client["verifySignedJwtWithCertsAsync"]>[1],
        aud,
        issuers,
      ),
  });
}

describe("IAP identity verifier", () => {
  it("accepts a real signed ES256 assertion and only the signed email", async () => {
    const result = await verifier().verify({
      headers: {
        "x-goog-iap-jwt-assertion": token(),
        "x-goog-authenticated-user-email": "attacker@example.test",
      },
    });
    expect(result._unsafeUnwrap()).toEqual({
      issuer: "https://cloud.google.com/iap",
      subject: "subject-1",
      email: "dev@example.test",
    });
  });

  it.each([
    ["issuer", { iss: "wrong" }, {}],
    ["audience", { aud: "wrong" }, {}],
    ["subject", { sub: "" }, {}],
    ["future", { iat: now + 31 }, {}],
    ["expired", { exp: now - 31 }, {}],
    ["lifetime", { iat: now - 1, exp: now + 660 }, {}],
    ["numeric date", { exp: Number.POSITIVE_INFINITY }, {}],
    ["algorithm", {}, { alg: "RS256" }],
    ["kid", {}, { kid: "" }],
  ])("rejects wrong %s", async (_name, claims, header) => {
    const result = await verifier().verify({
      headers: { "x-goog-iap-jwt-assertion": token(claims, header) },
    });
    expect(result.isErr() && result.error).toEqual({
      type: "unauthenticated",
      message: "invalid IAP assertion",
    });
  });

  it.each([
    ["missing", {}],
    ["malformed", { "x-goog-iap-jwt-assertion": "not-a-jwt" }],
    [
      "non-object header",
      {
        "x-goog-iap-jwt-assertion": `${Buffer.from("null").toString("base64url")}.${Buffer.from("{}").toString("base64url")}.x`,
      },
    ],
    [
      "non-object payload",
      {
        "x-goog-iap-jwt-assertion": `${Buffer.from("{}").toString("base64url")}.${Buffer.from("[]").toString("base64url")}.x`,
      },
    ],
  ])("rejects %s assertions without throwing", async (_name, headers) => {
    const result = await verifier().verify({ headers });
    expect(result.isErr() && result.error.type).toBe("unauthenticated");
  });

  it("rejects a bad signature without leaking verifier detail", async () => {
    const parts = token().split(".");
    const assertion = `${parts[0]}.${parts[1]}.${"A".repeat(parts[2]?.length ?? 1)}`;
    const result = await verifier().verify({ headers: { "x-goog-iap-jwt-assertion": assertion } });
    expect(result.isErr() && result.error.message).toBe("invalid IAP assertion");
  });

  it("sanitizes synchronous third-party throws", async () => {
    const fetchThrown = await new IapIdentityVerifier(audience, () => now * 1_000, {
      getIapPublicKeysAsync: () => {
        throw new Error(`secret ${token()}`);
      },
      verifySignedJwtWithCertsAsync: async () => {
        throw new Error("unused");
      },
    }).verify({ headers: { "x-goog-iap-jwt-assertion": token() } });
    expect(fetchThrown.isErr() && fetchThrown.error).toEqual({
      type: "identity_unavailable",
      message: "IAP verification unavailable",
    });

    const verifyThrown = await new IapIdentityVerifier(audience, () => now * 1_000, {
      getIapPublicKeysAsync: async () => ({ pubkeys: { "key-1": pubkey } }),
      verifySignedJwtWithCertsAsync: () => {
        throw new Error(`secret ${token()}`);
      },
    }).verify({ headers: { "x-goog-iap-jwt-assertion": token() } });
    expect(verifyThrown.isErr() && verifyThrown.error).toEqual({
      type: "unauthenticated",
      message: "invalid IAP assertion",
    });
  });

  it.each([null, [], {}, { pubkeys: null }, { pubkeys: [] }, { pubkeys: { kid: 7 } }])(
    "maps malformed key response %j to availability",
    async (keyResponse) => {
      const result = await new IapIdentityVerifier(audience, () => now * 1_000, {
        getIapPublicKeysAsync: async () => keyResponse,
        verifySignedJwtWithCertsAsync: async () => {
          throw new Error("unused");
        },
      }).verify({ headers: { "x-goog-iap-jwt-assertion": token() } });
      expect(result.isErr() && result.error).toEqual({
        type: "identity_unavailable",
        message: "IAP verification unavailable",
      });
    },
  );

  it("maps key fetch failure to sanitized availability", async () => {
    const result = await new IapIdentityVerifier(audience, () => now * 1_000, {
      getIapPublicKeysAsync: async () => {
        throw new Error(`secret ${token()}`);
      },
      verifySignedJwtWithCertsAsync: async () => {
        throw new Error("unused");
      },
    }).verify({ headers: { "x-goog-iap-jwt-assertion": token() } });
    expect(result.isErr() && result.error).toEqual({
      type: "identity_unavailable",
      message: "IAP verification unavailable",
    });
  });

  it("caches by provider max-age, coalesces fetches, and expires", async () => {
    let clock = 0;
    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cache = new IapPublicKeyCache(
      {
        getIapPublicKeysAsync: async () => {
          calls += 1;
          await gate;
          return { pubkeys: { key: pubkey }, res: { headers: { get: () => "public, max-age=2" } } };
        },
        verifySignedJwtWithCertsAsync: async () => {
          throw new Error("unused");
        },
      },
      () => clock,
    );
    const pending = [cache.get(), cache.get(), cache.get()];
    release?.();
    await Promise.all(pending);
    expect(calls).toBe(1);
    await cache.get();
    expect(calls).toBe(1);
    clock = 2_001;
    await cache.get();
    expect(calls).toBe(2);
  });

  it("refreshes once for an unknown rotation kid and fails closed after expired-cache outage", async () => {
    let calls = 0;
    let clock = 0;
    let releaseRotation: (() => void) | undefined;
    let rotationEntered: (() => void) | undefined;
    const rotationGate = new Promise<void>((resolve) => {
      releaseRotation = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      rotationEntered = resolve;
    });
    const cache = new IapPublicKeyCache(
      {
        getIapPublicKeysAsync: async () => {
          calls += 1;
          if (calls === 1)
            return { pubkeys: { old: pubkey }, res: { headers: { get: () => "max-age=300" } } };
          if (calls === 2) {
            rotationEntered?.();
            await rotationGate;
            return { pubkeys: { new: pubkey }, res: { headers: { get: () => "max-age=300" } } };
          }
          throw new Error("network secret");
        },
        verifySignedJwtWithCertsAsync: async () => {
          throw new Error("unused");
        },
      },
      () => clock,
    );
    expect(Object.hasOwn((await cache.get())._unsafeUnwrap(), "old")).toBe(true);
    const rotations = [cache.getForKid("new"), cache.getForKid("new"), cache.getForKid("new")];
    await entered;
    expect(calls).toBe(2);
    releaseRotation?.();
    const rotated = await Promise.all(rotations);
    expect(rotated.every((result) => result.isOk() && Object.hasOwn(result.value, "new"))).toBe(
      true,
    );
    expect(calls).toBe(2);
    clock = 300_001;
    const failed = await cache.get();
    expect(failed.isErr() && failed.error).toEqual({
      type: "identity_unavailable",
      message: "IAP verification unavailable",
    });
  });

  it("bounds alternating unknown-kid refreshes with one cooldown", async () => {
    let calls = 0;
    const clock = 0;
    const cache = new IapPublicKeyCache(
      {
        getIapPublicKeysAsync: async () => {
          calls += 1;
          return { pubkeys: { old: pubkey } };
        },
        verifySignedJwtWithCertsAsync: async () => {
          throw new Error("unused");
        },
      },
      () => clock,
    );
    await cache.get();
    await cache.getForKid("missing-a");
    await cache.getForKid("missing-b");
    await cache.getForKid("missing-c");
    expect(calls).toBe(2);
  });

  it("validates direct Cloud Run audiences", () => {
    expect(readIapAudience(audience).isOk()).toBe(true);
    expect(readIapAudience("https://example.test").isErr()).toBe(true);
  });
});
