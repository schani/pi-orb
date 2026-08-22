import { NoSimulationTask } from "determined";
import { errAsync, type Result } from "neverthrow";
import { describe, expect, it } from "vitest";
import {
  type MintHarness,
  makeMintHarness,
  seedOrbWithBearer,
  TEST_ISSUER_URL,
} from "../testkit/fixtures.ts";
import type { InMemoryControlPlaneStore } from "../testkit/store.ts";
import { decodeFakeIdToken, decodeFakeIdTokenKid } from "../testkit/workload-identity.ts";
import type { MintError, StoreError } from "./errors.ts";
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

describe("denial-path status writes", () => {
  it("writes once for a run of identical denials, and again when the code changes", async () => {
    // `not_mintable` and `invalid_request` are both recorded *before* the
    // rate-limit slot is claimed, so without dedup a caller holding a stopped
    // orb's bearer drives one UPDATE per request against no floor at all.
    const task = new NoSimulationTask("denial dedup test", false);
    const harness = makeMintHarness();
    const bearer = seedOrbWithBearer(task, harness, ORB, "stopped");

    for (let attempt = 0; attempt < 20; attempt++) {
      const denied = await mintIdToken(task, harness.mintDeps, {
        tokenHash: bearer,
        audience: AUDIENCE,
      });
      expect(errorOf(denied).type).toBe("not_mintable");
    }
    expect(harness.store.mintFailureWrites).toBe(1);
    const stamped = harness.store.orbSnapshot(ORB)?.mintFailureAt;
    expect(harness.store.orbSnapshot(ORB)?.mintFailureCode).toBe("not_mintable");

    // A different code is real news — the user needs to see the state change,
    // not the previous run's verdict — so it always writes.
    const running = harness.store.orbSnapshot(ORB);
    if (running === null) throw new Error("seed missing");
    harness.store.seedOrb({ ...running, state: "running" });
    const invalid = await mintIdToken(task, harness.mintDeps, {
      tokenHash: bearer,
      audience: "",
    });
    expect(errorOf(invalid).type).toBe("invalid_request");
    expect(harness.store.mintFailureWrites).toBe(2);
    expect(harness.store.orbSnapshot(ORB)?.mintFailureCode).toBe("invalid_request");
    // The stamp the dedup deliberately lets go stale: it belongs to the *first*
    // request of a run of identical denials, not the latest one.
    expect(stamped).not.toBeNull();
  });

  it("records again once a later successful mint has superseded the same denial", async () => {
    // The dedup must not outlive the status it is deduplicating against.
    // `http/views.ts` hides a failure older than `lastMintAt`, so after a
    // successful mint the row still *says* `not_mintable` while showing the
    // user nothing — and a plain code comparison would then skip the write for
    // the next real denial forever, leaving the orb silently failing.
    const task = new NoSimulationTask("denial supersession test", false);
    const harness = makeMintHarness();
    const bearer = seedOrbWithBearer(task, harness, ORB, "stopped");

    const first = await mintIdToken(task, harness.mintDeps, {
      tokenHash: bearer,
      audience: AUDIENCE,
    });
    expect(errorOf(first).type).toBe("not_mintable");
    expect(harness.store.mintFailureWrites).toBe(1);

    // A later successful mint, as the rate-limit slot would have recorded it.
    const denied = harness.store.orbSnapshot(ORB);
    if (denied === null) throw new Error("seed missing");
    if (denied.mintFailureAt === null) throw new Error("denial was not recorded");
    const supersededBy = denied.mintFailureAt + 1;
    harness.store.seedOrb({ ...denied, lastMintAt: supersededBy });

    const again = await mintIdToken(task, harness.mintDeps, {
      tokenHash: bearer,
      audience: AUDIENCE,
    });
    expect(errorOf(again).type).toBe("not_mintable");
    expect(harness.store.mintFailureWrites).toBe(2);
    expect(harness.store.orbSnapshot(ORB)?.mintFailureCode).toBe("not_mintable");
  });
});

/**
 * The harness's store with its bearer lookup swapped for a fixed failure.
 * Delegating through the prototype keeps every other method — and the seeded
 * rows behind them — exactly as they were, which a hand-built stub of the whole
 * `ControlPlaneStore` could not.
 */
function storeFailingLookup(
  store: InMemoryControlPlaneStore,
  error: StoreError,
): InMemoryControlPlaneStore {
  const failing: InMemoryControlPlaneStore = Object.create(store);
  failing.getOrbByRuntimeTokenHash = () => errAsync(error);
  return failing;
}

describe("store failures the caller cannot retry away", () => {
  for (const code of ["invariant", "corruption"] as const) {
    it(`reports a ${code} store failure as internal, never as retryable`, async () => {
      // Both codes carry `retryable: false`: `invariant` is a deterministic bug
      // of ours, `corruption` a row shape the schema refuses outright. Neither
      // improves by being asked again, and advertising either as retryable is
      // how a CLI ends up spinning on a refusal that never changes.
      const seeded = seed();
      const store = storeFailingLookup(seeded.harness.store, {
        type: "store_error",
        code,
        message: "orbs.mint_failure_code holds an unknown value",
        retryable: false,
      });
      const denied = await mintIdToken(
        seeded.task,
        { ...seeded.harness.mintDeps, store },
        { tokenHash: seeded.bearer, audience: AUDIENCE },
      );
      expect(errorOf(denied).type).toBe("internal");
    });
  }

  it("still reports an outage as retryable", async () => {
    const seeded = seed();
    const store = storeFailingLookup(seeded.harness.store, {
      type: "store_error",
      code: "unavailable",
      message: "connection terminated",
      retryable: true,
    });
    const denied = await mintIdToken(
      seeded.task,
      { ...seeded.harness.mintDeps, store },
      { tokenHash: seeded.bearer, audience: AUDIENCE },
    );
    expect(errorOf(denied).type).toBe("retryable");
  });
});
