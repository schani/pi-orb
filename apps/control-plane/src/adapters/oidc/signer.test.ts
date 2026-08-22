import { createPublicKey, verify } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoSimulationTask } from "determined";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_ISSUER_CONSTANTS } from "../../domain/constants.ts";
import type { MintDeps, SigningKeyDeps } from "../../domain/ports.ts";
import {
  assembleJwks,
  ensureActiveSigningKey,
  rotateSigningKey,
  SIGNING_KEY_SECRET_PROVIDER,
} from "../../domain/signing-keys.ts";
import { mintIdToken } from "../../domain/workload-identity.ts";
import {
  type MintHarness,
  makeMintHarness,
  seedOrbWithBearer,
  TEST_ISSUER_URL,
} from "../../testkit/fixtures.ts";
import { FakeSigningKeyStore } from "../../testkit/workload-identity.ts";
import { FileSecretStore } from "../secrets/file-store.ts";
import { CryptoMintIdSource, NodeCryptoSigningKeyGenerator, OidcTokenSigner } from "./signer.ts";

/**
 * The whole issuer side composed for real: `node:crypto` key generation, the
 * on-disk secret store the local deployment uses, the domain's key management
 * and mint path, and finally an external verifier that only ever sees the
 * served JWKS. Nothing here is a fake except the two in-memory stores standing
 * in for PostgreSQL.
 */

const ORB = "orb-a";
const AUDIENCE = "urn:example:service";
const task = new NoSimulationTask("oidc signer test", false);

let secretDir: string;
let secrets: FileSecretStore;
let keys: FakeSigningKeyStore;
let keyDeps: SigningKeyDeps;
let mintHarness: MintHarness;
let mintDeps: MintDeps;
let bearer: string;

beforeEach(async () => {
  secretDir = await mkdtemp(join(tmpdir(), "pi-orb-signing-keys-"));
  secrets = new FileSecretStore(secretDir);
  keys = new FakeSigningKeyStore();
  keyDeps = {
    keys,
    secrets,
    generator: new NodeCryptoSigningKeyGenerator(),
    constants: DEFAULT_ISSUER_CONSTANTS,
  };
  // The per-orb mint floor is a store property covered by the mint DST; here
  // it would only stand between two legs of one composition test.
  mintHarness = makeMintHarness({ issuerConstants: { minMintIntervalMs: 0 } });
  mintDeps = {
    ...mintHarness.mintDeps,
    signer: new OidcTokenSigner({ keys, secrets }),
    mintIds: new CryptoMintIdSource(),
  };
  bearer = seedOrbWithBearer(task, mintHarness, ORB, "running", { incarnation: 2 });
});

afterEach(async () => {
  await rm(secretDir, { recursive: true, force: true });
});

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

/**
 * A relying party's verification: find the JWKS entry the header names, import
 * it, and check the signature over the signing input. Returns the claims only
 * if all of that holds.
 */
async function verifyAgainstJwks(jwt: string, now: number): Promise<Record<string, unknown>> {
  const [header, payload, signature] = jwt.split(".") as [string, string, string];
  const jwks = await assembleJwks(task, keyDeps, { now });
  expect(jwks.isOk()).toBe(true);
  const kid = decodeSegment(header)["kid"];
  const jwk = jwks._unsafeUnwrap().keys.find((key) => (key as { kid: string }).kid === kid);
  expect(jwk, `no published key for kid ${String(kid)}`).toBeDefined();
  const verified = verify(
    "sha256",
    Buffer.from(`${header}.${payload}`, "ascii"),
    createPublicKey({ key: jwk as object, format: "jwk" }),
    Buffer.from(signature, "base64url"),
  );
  expect(verified, "signature did not verify against the served JWKS").toBe(true);
  return decodeSegment(payload);
}

describe("OidcTokenSigner composed with real key material", () => {
  it("mints a token that verifies against the served JWKS and matches the orb row", async () => {
    const active = await ensureActiveSigningKey(task, keyDeps, { now: Date.now() });
    expect(active.isOk()).toBe(true);

    const minted = await mintIdToken(task, mintDeps, { tokenHash: bearer, audience: AUDIENCE });
    expect(minted.isOk(), JSON.stringify(minted.isErr() ? minted.error : null)).toBe(true);
    if (minted.isErr()) return;

    const [header] = minted.value.token.split(".") as [string];
    expect(decodeSegment(header)).toEqual({
      alg: "RS256",
      typ: "JWT",
      kid: active._unsafeUnwrap().kid,
    });

    const claims = await verifyAgainstJwks(minted.value.token, Date.now());
    const orb = mintHarness.store.orbSnapshot(ORB);
    expect(claims).toMatchObject({
      iss: TEST_ISSUER_URL,
      aud: AUDIENCE,
      sub: ORB,
      orb_id: ORB,
      project_id: orb?.projectId,
      host_incarnation: 2,
      token_use: "exchanged",
    });
    expect(claims["exp"]).toBe((claims["iat"] as number) + mintDeps.constants.defaultTtlSeconds);
    // A v4 `jti`, unique per mint and carrying nothing about the orb.
    expect(String(claims["jti"])).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("keeps the private key out of PostgreSQL, the JWKS, and the token", async () => {
    await ensureActiveSigningKey(task, keyDeps, { now: Date.now() });
    const row = keys.activeRows()[0];
    expect(row).toBeDefined();
    if (row === undefined) return;

    // The public row carries a JWK and a secret *reference*, never material.
    expect(JSON.stringify(row)).not.toContain("PRIVATE KEY");
    const jwks = await assembleJwks(task, keyDeps, { now: Date.now() });
    expect(JSON.stringify(jwks._unsafeUnwrap())).not.toContain("PRIVATE KEY");
    for (const member of ["d", "p", "q", "dp", "dq", "qi"]) {
      expect((jwks._unsafeUnwrap().keys[0] as Record<string, unknown>)[member]).toBeUndefined();
    }

    // The material is exactly where it belongs: one exact version of the
    // issuer's secret, readable by version and by nothing else.
    const stored = await secrets.readSecret<{ privateKeyPem: string }>(
      task,
      SIGNING_KEY_SECRET_PROVIDER,
      row.secretVersion,
    );
    expect(stored._unsafeUnwrap()?.privateKeyPem.startsWith("-----BEGIN PRIVATE KEY-----")).toBe(
      true,
    );

    const minted = await mintIdToken(task, mintDeps, { tokenHash: bearer, audience: AUDIENCE });
    expect(minted.isOk()).toBe(true);
    if (minted.isOk()) expect(minted.value.token).not.toContain("PRIVATE KEY");
  });

  it("follows a rotation while the previous token still verifies", async () => {
    const first = (
      await ensureActiveSigningKey(task, keyDeps, { now: Date.now() })
    )._unsafeUnwrap();
    const before = await mintIdToken(task, mintDeps, { tokenHash: bearer, audience: AUDIENCE });
    expect(before.isOk()).toBe(true);
    if (before.isErr()) return;

    const rotatedAt = Date.now();
    const second = (await rotateSigningKey(task, keyDeps, { now: rotatedAt }))._unsafeUnwrap();
    expect(second.kid).not.toBe(first.kid);

    const after = await mintIdToken(task, mintDeps, { tokenHash: bearer, audience: AUDIENCE });
    expect(after.isOk(), JSON.stringify(after.isErr() ? after.error : null)).toBe(true);
    if (after.isErr()) return;

    // The signer switched keys without being restarted, and both tokens
    // verify against the key set as it stands during the overlap.
    expect(decodeSegment(after.value.token.split(".")[0] as string)["kid"]).toBe(second.kid);
    await verifyAgainstJwks(before.value.token, rotatedAt);
    await verifyAgainstJwks(after.value.token, rotatedAt);

    // Once the overlap has passed the retired key is no longer served.
    const later = rotatedAt + DEFAULT_ISSUER_CONSTANTS.jwksOverlapMs + 1;
    const served = await assembleJwks(task, keyDeps, { now: later });
    expect(served._unsafeUnwrap().keys.map((key) => (key as { kid: string }).kid)).toEqual([
      second.kid,
    ]);
  });

  it("refuses to sign when no key is active", async () => {
    const minted = await mintIdToken(task, mintDeps, { tokenHash: bearer, audience: AUDIENCE });
    expect(minted.isErr() && minted.error.type).toBe("retryable");
    // The user-visible reason survives the request.
    expect(mintHarness.store.orbSnapshot(ORB)?.mintFailureCode).toBe("signer_failure");
  });

  it("refuses to sign when the active key's material was destroyed", async () => {
    const active = (
      await ensureActiveSigningKey(task, keyDeps, { now: Date.now() })
    )._unsafeUnwrap();
    await secrets.destroySecret(task, SIGNING_KEY_SECRET_PROVIDER, active.secretVersion);

    const minted = await mintIdToken(task, mintDeps, { tokenHash: bearer, audience: AUDIENCE });
    expect(minted.isErr() && minted.error.type).toBe("retryable");
    if (minted.isErr() && minted.error.type === "retryable") {
      // Fail closed, and say why without naming the material.
      expect(minted.error.message).toContain("unusable");
      expect(minted.error.message).not.toContain("PRIVATE KEY");
    }
  });
});
