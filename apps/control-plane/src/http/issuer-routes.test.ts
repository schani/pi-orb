import { createHash, createPublicKey, verify } from "node:crypto";
import { ID_TOKEN_PATH } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { errAsync, okAsync } from "neverthrow";
import { Check } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CryptoMintIdSource,
  NodeCryptoSigningKeyGenerator,
  OidcTokenSigner,
} from "../adapters/oidc/signer.ts";
import { DEFAULT_BROKER_CONSTANTS, DEFAULT_ISSUER_CONSTANTS } from "../domain/constants.ts";
import type { StoreError } from "../domain/errors.ts";
import type { OrbNameGenerator, SigningKeyRow, SigningKeyStore } from "../domain/ports.ts";
import { ensureActiveSigningKey } from "../domain/signing-keys.ts";
import { FakePointerStore, FakeSecretStore, FakeUpstream } from "../testkit/broker.ts";
import {
  makeOrbRow,
  makeProjectRow,
  TEST_ISSUER_CONSTANTS,
  TEST_ISSUER_URL,
} from "../testkit/fixtures.ts";
import { InMemoryControlPlaneStore } from "../testkit/store.ts";
import { FakeSigningKeyStore } from "../testkit/workload-identity.ts";
import {
  JWKS_PATH,
  JwksDocumentSchema,
  OidcDiscoveryDocumentSchema,
  OPENID_CONFIGURATION_PATH,
  registerIssuerRoutes,
} from "./issuer-routes.ts";
import { registerRuntimeRoutes } from "./runtime-routes.ts";

/**
 * The public issuer surface (docs/workload-identity.md). Everything it serves
 * has to be derivable by an external verifier that knows only the issuer URL,
 * so these tests assert the exact documents rather than that "something is
 * served".
 */

const task = new NoSimulationTask("issuer routes test", false);
const NOW = 1_700_000_000_000;

function jwkRow(kid: string, overrides?: Partial<SigningKeyRow>): SigningKeyRow {
  return {
    kid,
    secretVersion: `secret-${kid}`,
    publicJwk: { kty: "RSA", alg: "RS256", use: "sig", kid, n: `modulus-of-${kid}`, e: "AQAB" },
    state: "active",
    createdAt: NOW - 1_000,
    activatedAt: NOW - 1_000,
    retiredAt: null,
    rowVersion: 0,
    ...overrides,
  };
}

const kidsOf = (body: { keys: unknown[] }): string[] =>
  body.keys.map((key) => (key as { kid: string }).kid);

describe("issuer discovery and JWKS", () => {
  let app: ReturnType<typeof Fastify>;
  let keys: FakeSigningKeyStore;

  beforeEach(async () => {
    app = Fastify();
    keys = new FakeSigningKeyStore();
    registerIssuerRoutes(app, task, {
      keys,
      constants: DEFAULT_ISSUER_CONSTANTS,
      issuerUrl: TEST_ISSUER_URL,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("serves a discovery document derived only from the configured issuer", async () => {
    const response = await app.inject({
      method: "GET",
      url: OPENID_CONFIGURATION_PATH,
      // A request header must never be able to change this deployment's
      // identity: the issuer URL is what relying parties pin.
      headers: { host: "attacker.example" },
    });

    expect(response.statusCode).toBe(200);
    expect(Check(OidcDiscoveryDocumentSchema, response.json())).toBe(true);
    expect(response.json()).toEqual({
      issuer: TEST_ISSUER_URL,
      jwks_uri: `${TEST_ISSUER_URL}/.well-known/jwks.json`,
      response_types_supported: ["id_token"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      claims_supported: [
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
      ],
    });
    // The advertised key set is exactly where the endpoint really is.
    expect(response.json().jwks_uri.endsWith(JWKS_PATH)).toBe(true);
  });

  it("publishes both documents as public and cacheable", async () => {
    for (const url of [OPENID_CONFIGURATION_PATH, JWKS_PATH]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(200);
      expect(response.headers["cache-control"], url).toBe("public, max-age=300");
    }
  });

  it("serves the active key first, published keys beside it, and no secret", async () => {
    keys.seedKey(jwkRow("pending-key", { state: "pending", activatedAt: null }));
    keys.seedKey(jwkRow("active-key"));

    const response = await app.inject({ method: "GET", url: JWKS_PATH });
    expect(response.statusCode).toBe(200);
    expect(Check(JwksDocumentSchema, response.json())).toBe(true);
    // Active first: a verifier that stops at the first usable key gets the one
    // this deployment is signing with right now.
    expect(kidsOf(response.json())).toEqual(["active-key", "pending-key"]);
    expect(response.body).not.toContain("PRIVATE KEY");
    expect(response.body).not.toContain("secret-");
  });

  it("keeps a retired key published for the overlap window and drops it after", async () => {
    keys.seedKey(jwkRow("active-key"));
    keys.seedKey(
      jwkRow("retired-key", {
        state: "retired",
        // Retired exactly at the edge of the window: tokens it signed may still
        // be inside their own lifetime, so dropping it now would make them look
        // forged (docs/workload-identity.md).
        retiredAt: Date.now() - DEFAULT_ISSUER_CONSTANTS.jwksOverlapMs + 60_000,
      }),
    );
    expect(kidsOf((await app.inject({ method: "GET", url: JWKS_PATH })).json())).toEqual([
      "active-key",
      "retired-key",
    ]);

    keys.seedKey(
      jwkRow("retired-key", {
        state: "retired",
        retiredAt: Date.now() - DEFAULT_ISSUER_CONSTANTS.jwksOverlapMs - 60_000,
      }),
    );
    expect(kidsOf((await app.inject({ method: "GET", url: JWKS_PATH })).json())).toEqual([
      "active-key",
    ]);
  });

  it("fails closed with an uncached 503 when the key rows cannot be read", async () => {
    // An empty or partial key set would make every live token look forged, so
    // the endpoint refuses to answer at all — and the refusal is never cached.
    const unavailable: StoreError = {
      type: "store_error",
      code: "unavailable",
      message: "connection terminated",
      retryable: true,
    };
    const brokenKeys: SigningKeyStore = {
      listSigningKeys: () => errAsync(unavailable),
      insertSigningKey: () => errAsync(unavailable),
      casSigningKeyState: () => errAsync(unavailable),
    };
    const broken = Fastify();
    registerIssuerRoutes(broken, task, {
      keys: brokenKeys,
      constants: DEFAULT_ISSUER_CONSTANTS,
      issuerUrl: TEST_ISSUER_URL,
    });
    await broken.ready();

    const response = await broken.inject({ method: "GET", url: JWKS_PATH });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe("unavailable");
    expect(response.headers["cache-control"]).toBe("no-store");
    // Discovery is static configuration and stays available regardless.
    expect(
      (await broken.inject({ method: "GET", url: OPENID_CONFIGURATION_PATH })).statusCode,
    ).toBe(200);
    await broken.close();
  });
});

/**
 * The two HTTP surfaces composed the way `PI_ORB_ROLE=all` composes them: a
 * token minted over the runtime route must verify against the key set the
 * public issuer route serves, using nothing but the JWT header's `kid` and the
 * published JWK. That is the whole feature's contract with a relying party.
 */
describe("minted tokens verify against the served JWKS", () => {
  const ORB = "orb-a";
  const PROJECT = "project-a";
  const TOKEN = "runtime-token-plaintext";

  let app: ReturnType<typeof Fastify>;
  let store: InMemoryControlPlaneStore;
  let keys: FakeSigningKeyStore;

  beforeEach(async () => {
    app = Fastify();
    store = new InMemoryControlPlaneStore(0);
    keys = new FakeSigningKeyStore();
    const secrets = new FakeSecretStore();
    const nameGenerator: OrbNameGenerator = { generate: () => okAsync("Verify Identity") };

    const ensured = await ensureActiveSigningKey(
      task,
      {
        keys,
        secrets,
        generator: new NodeCryptoSigningKeyGenerator(),
        constants: DEFAULT_ISSUER_CONSTANTS,
      },
      { now: Date.now() },
    );
    expect(ensured.isOk()).toBe(true);

    store.seedProject(makeProjectRow(PROJECT));
    store.seedOrb(
      makeOrbRow(ORB, PROJECT, "running", {
        runtimeTokenHash: createHash("sha256").update(TOKEN).digest("hex"),
      }),
    );
    registerIssuerRoutes(app, task, {
      keys,
      constants: DEFAULT_ISSUER_CONSTANTS,
      issuerUrl: TEST_ISSUER_URL,
    });
    registerRuntimeRoutes(app, task, {
      store,
      broker: {
        pointers: new FakePointerStore(),
        secrets,
        upstreams: { "openai-codex": new FakeUpstream("unseeded") },
        constants: DEFAULT_BROKER_CONSTANTS,
      },
      nameGenerator,
      nameLeaseMs: 30_000,
      mint: {
        store,
        signer: new OidcTokenSigner({ keys, secrets }),
        mintIds: new CryptoMintIdSource(),
        constants: TEST_ISSUER_CONSTANTS,
        issuerUrl: TEST_ISSUER_URL,
      },
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("verifies a real RS256 signature against the published key", async () => {
    const minted = await app.inject({
      method: "POST",
      url: ID_TOKEN_PATH,
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { audience: "urn:example:service" },
    });
    expect(minted.statusCode).toBe(200);
    const [header, payload, signature] = minted.json().token.split(".") as [string, string, string];

    const jwks = await app.inject({ method: "GET", url: JWKS_PATH });
    const decode = (segment: string): Record<string, unknown> =>
      JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    const jwk = jwks.json().keys.find((key: { kid: string }) => key.kid === decode(header)["kid"]);
    expect(jwk, "the header named a key the issuer does not publish").toBeDefined();

    expect(
      verify(
        "sha256",
        Buffer.from(`${header}.${payload}`, "ascii"),
        createPublicKey({ key: jwk as object, format: "jwk" }),
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
    expect(decode(payload)).toMatchObject({ iss: TEST_ISSUER_URL, sub: ORB });
  });
});
