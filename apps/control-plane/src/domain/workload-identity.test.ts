import { NoSimulationTask } from "determined";
import type { Result } from "neverthrow";
import { describe, expect, it } from "vitest";
import {
  type MintHarness,
  makeMintHarness,
  seedOrbWithBearer,
  TEST_ISSUER_URL,
} from "../testkit/fixtures.ts";
import { decodeFakeIdToken, decodeFakeIdTokenKid } from "../testkit/workload-identity.ts";
import type { MintError } from "./errors.ts";
import { mintIdToken } from "./workload-identity.ts";

const ORB = "orb-mint";
const AUDIENCE = "urn:example:service";

interface Seeded {
  readonly harness: MintHarness;
  readonly task: NoSimulationTask;
  readonly bearer: string;
}

function seed(options?: { incarnation?: number }): Seeded {
  const task = new NoSimulationTask("mint unit test", false);
  const harness = makeMintHarness();
  const bearer = seedOrbWithBearer(task, harness, ORB, "running", options ?? {});
  return { harness, task, bearer };
}

async function mint(
  seeded: Seeded,
  request: { audience?: string; ttlSeconds?: number; tokenHash?: string },
) {
  return mintIdToken(seeded.task, seeded.harness.mintDeps, {
    tokenHash: request.tokenHash ?? seeded.bearer,
    audience: request.audience ?? AUDIENCE,
    ...(request.ttlSeconds === undefined ? {} : { ttlSeconds: request.ttlSeconds }),
  });
}

function errorOf<T>(result: Result<T, MintError>): MintError {
  if (result.isOk()) throw new Error("expected a denial, got a token");
  return result.error;
}

describe("identity claim construction", () => {
  it("derives every claim from the orb row and the deployment configuration", async () => {
    const seeded = seed({ incarnation: 3 });
    const before = Math.floor(seeded.task.wallNow() / 1000);
    const minted = await mint(seeded, {});
    expect(minted.isOk(), JSON.stringify(minted.isErr() ? minted.error : null)).toBe(true);
    if (minted.isErr()) return;

    const claims = decodeFakeIdToken(minted.value.token);
    const orb = seeded.harness.store.orbSnapshot(ORB);
    expect(claims).toMatchObject({
      iss: TEST_ISSUER_URL,
      aud: AUDIENCE,
      sub: ORB,
      orb_id: ORB,
      project_id: orb?.projectId,
      host_incarnation: 3,
      token_use: "exchanged",
      jti: "jti-1",
    });
    // Seconds, not milliseconds: a token stamped in ms would be valid for
    // millennia and pass every relying party's expiry check.
    expect(claims.iat).toBeGreaterThanOrEqual(before);
    expect(claims.iat).toBeLessThan(before + 5);
    expect(claims.exp - claims.iat).toBe(seeded.harness.mintDeps.constants.defaultTtlSeconds);
    // The caller must be able to find the verifying key.
    expect(decodeFakeIdTokenKid(minted.value.token)).toBe("fake-key-1");
    // A success is silent: no durable record beyond the rate-limit floor.
    expect(orb?.mintFailureCode).toBeNull();
    expect(orb?.lastMintAt).not.toBeNull();
  });

  it("honors an explicit lifetime within bounds", async () => {
    for (const ttlSeconds of [60, 600, 3600]) {
      const seeded = seed();
      const minted = await mint(seeded, { ttlSeconds });
      expect(minted.isOk()).toBe(true);
      if (minted.isErr()) continue;
      const claims = decodeFakeIdToken(minted.value.token);
      expect(claims.exp - claims.iat).toBe(ttlSeconds);
    }
  });

  it("rejects a lifetime outside the accepted range and records the denial", async () => {
    for (const ttlSeconds of [59, 3601, 0, -60]) {
      const seeded = seed();
      const minted = await mint(seeded, { ttlSeconds });
      expect(errorOf(minted).type).toBe("invalid_request");
      expect(seeded.harness.store.orbSnapshot(ORB)?.mintFailureCode).toBe("invalid_request");
      // A denied request consumes no rate-limit slot: validation runs first.
      expect(seeded.harness.store.orbSnapshot(ORB)?.lastMintAt).toBeNull();
      expect(seeded.harness.signer.calls).toBe(0);
    }
  });
});

describe("audience validation", () => {
  it("accepts an audience exactly at the byte cap and rejects one byte more", async () => {
    const cap = makeMintHarness().mintDeps.constants.maxAudienceBytes;

    const atCap = seed();
    expect((await mint(atCap, { audience: "a".repeat(cap) })).isOk()).toBe(true);

    const overCap = seed();
    const denied = await mint(overCap, { audience: "a".repeat(cap + 1) });
    expect(errorOf(denied).type).toBe("invalid_request");
    expect(overCap.harness.store.orbSnapshot(ORB)?.mintFailureCode).toBe("invalid_request");
  });

  it("counts the cap in UTF-8 bytes, not characters", async () => {
    const cap = makeMintHarness().mintDeps.constants.maxAudienceBytes;
    // "é" is two UTF-8 bytes: cap/2 of them exactly fill the cap, and a string
    // of `cap` characters is twice the cap in bytes even though a
    // character-counting check would wave it through.
    const atCap = seed();
    const exact = "é".repeat(cap / 2);
    expect(exact.length).toBe(cap / 2);
    expect((await mint(atCap, { audience: exact })).isOk()).toBe(true);

    const overCap = seed();
    const denied = await mint(overCap, { audience: "é".repeat(cap / 2 + 1) });
    expect(errorOf(denied).type).toBe("invalid_request");

    const charCounted = seed();
    const wide = await mint(charCounted, { audience: "€".repeat(cap) });
    expect(errorOf(wide).type).toBe("invalid_request");
  });

  it("rejects an empty audience", async () => {
    const seeded = seed();
    const denied = await mint(seeded, { audience: "" });
    expect(errorOf(denied).type).toBe("invalid_request");
    expect(seeded.harness.store.orbSnapshot(ORB)?.mintFailureCode).toBe("invalid_request");
    expect(seeded.harness.signer.calls).toBe(0);
  });
});

describe("bearer authentication", () => {
  it("denies an unknown bearer without recording anything on any orb", async () => {
    const seeded = seed();
    const denied = await mint(seeded, { tokenHash: "sha256(some-other-token)" });
    expect(errorOf(denied).type).toBe("unauthorized");
    expect(seeded.harness.store.orbSnapshot(ORB)?.mintFailureCode).toBeNull();
    expect(seeded.harness.store.orbSnapshot(ORB)?.lastMintAt).toBeNull();
  });
});
