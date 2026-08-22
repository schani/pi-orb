import { createHash } from "node:crypto";
import {
  ID_TOKEN_PATH,
  IdTokenErrorSchema,
  IdTokenResponseSchema,
  ORB_NAME_TRIGGER_PATH,
  runtimeTokenPath,
  type TokenName,
} from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { okAsync } from "neverthrow";
import { Check } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_BROKER_CONSTANTS } from "../domain/constants.ts";
import type { BrokerDeps, OrbNameGenerator } from "../domain/ports.ts";
import {
  FakePointerStore,
  FakeSecretStore,
  FakeUpstream,
  makeCredential,
} from "../testkit/broker.ts";
import {
  makeOrbRow,
  makeProjectRow,
  TEST_ISSUER_CONSTANTS,
  TEST_ISSUER_URL,
} from "../testkit/fixtures.ts";
import { InMemoryControlPlaneStore } from "../testkit/store.ts";
import {
  decodeFakeIdToken,
  decodeFakeIdTokenKid,
  FakeMintIdSource,
  FakeTokenSigner,
} from "../testkit/workload-identity.ts";
import { registerRuntimeRoutes } from "./runtime-routes.ts";

const ORB = "orb-a";
const PROJECT = "project-a";
const TOKEN = "runtime-token-plaintext";

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

describe("runtime broker routes", () => {
  const task = new NoSimulationTask("runtime-routes test", false);
  let app: ReturnType<typeof Fastify>;
  let store: InMemoryControlPlaneStore;
  let broker: BrokerDeps;
  let pointers: FakePointerStore;
  let secrets: FakeSecretStore;
  let signer: FakeTokenSigner;

  const nameGenerator: OrbNameGenerator = {
    generate: () => okAsync("Repair Runtime Auth"),
  };

  /**
   * Builds the app over the already-constructed dependencies. Split out of the
   * hook so a describe block can rebuild the routes with its own issuer
   * constants without duplicating the wiring.
   */
  async function startApp(issuerConstants = TEST_ISSUER_CONSTANTS): Promise<void> {
    app = Fastify();
    registerRuntimeRoutes(app, task, {
      store,
      broker,
      nameGenerator,
      nameLeaseMs: 30_000,
      mint: {
        store,
        signer,
        mintIds: new FakeMintIdSource(),
        constants: issuerConstants,
        issuerUrl: TEST_ISSUER_URL,
      },
    });
    await app.ready();
  }

  beforeEach(async () => {
    store = new InMemoryControlPlaneStore(0);
    pointers = new FakePointerStore();
    secrets = new FakeSecretStore();
    signer = new FakeTokenSigner("route-key-1");
    broker = {
      pointers,
      secrets,
      upstreams: {
        "openai-codex": new FakeUpstream("unseeded"),
        github: new FakeUpstream("gh-unseeded"),
      },
      constants: { ...DEFAULT_BROKER_CONSTANTS, requestDeadlineMs: 100, waiterPollMs: 5 },
    };
    store.seedProject(makeProjectRow(PROJECT));
    await startApp();
  });

  afterEach(async () => {
    await app.close();
  });

  function seedOrb(
    state: "creating" | "running" | "stopped",
    tokenHash: string | null = sha256(TOKEN),
  ): void {
    store.seedOrb(makeOrbRow(ORB, PROJECT, state, { runtimeTokenHash: tokenHash }));
  }

  function seedCredential(expiresInMs = 3_600_000): void {
    const credential = makeCredential(task, { expiresInMs });
    const version = secrets.seedSecret("openai-codex", credential);
    pointers.seedRow({
      provider: "openai-codex",
      rowVersion: 1,
      generation: 1,
      secretVersion: version,
      refreshLeaseUntil: 0,
      lastRefreshAt: 0,
    });
  }

  function request(
    body: unknown,
    token: string | null = TOKEN,
    name: TokenName | string = "model",
  ) {
    return app.inject({
      method: "POST",
      url:
        name === "model" || name === "github"
          ? runtimeTokenPath(name)
          : `/runtime/v1/tokens/${name}`,
      ...(token === null ? {} : { headers: { authorization: `Bearer ${token}` } }),
      payload: body as Record<string, unknown>,
    });
  }

  it("grants a token to a running orb with a valid bearer", async () => {
    seedOrb("running");
    seedCredential();
    const response = await request({ reason: "startup" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json();
    expect(typeof body.accessToken).toBe("string");
    expect(body.generation).toBe(1);
  });

  it("rejects old runtime authorization whenever a discard fence exists", async () => {
    store.seedOrb(
      makeOrbRow(ORB, PROJECT, "running", {
        runtimeTokenHash: sha256(TOKEN),
        hostIncarnation: 0,
        hostDiscardThroughIncarnation: 0,
        hostDiscardReason: "failed",
        hostDiscardRequestedAt: task.wallNow(),
      }),
    );
    seedCredential();
    const response = await request({ reason: "startup" });
    expect(response.statusCode).toBe(401);
  });

  it("rejects old runtime authorization while a host_spec_changed fence is pending", async () => {
    // The same fence as the `failed` case above, created by an immutable-spec
    // replacement instead: an orb carrying any discard intent is unauthorized
    // whatever its lifecycle state says (docs/compute-replacement.md).
    store.seedOrb(
      makeOrbRow(ORB, PROJECT, "starting", {
        runtimeTokenHash: sha256(TOKEN),
        hostRef: "host-a",
        hostIncarnation: 0,
        hostSpecFingerprint: "spec-new",
        hostSpecGeneration: 2,
        hostDiscardThroughIncarnation: 0,
        hostDiscardReason: "host_spec_changed",
        hostDiscardRequestedAt: task.wallNow(),
      }),
    );
    seedCredential();
    const response = await request({ reason: "startup" });
    expect(response.statusCode).toBe(401);
  });

  it("revokes the old token across a replacement and honors the new one only after commit", async () => {
    const NEW_TOKEN = "runtime-token-replacement";
    store.seedOrb(
      makeOrbRow(ORB, PROJECT, "starting", {
        runtimeTokenHash: sha256(TOKEN),
        hostRef: "host-a",
        hostIncarnation: 0,
        hostSpecFingerprint: "spec-old",
        hostSpecGeneration: 1,
      }),
    );
    seedCredential();
    // Stale compute still authorized before the update is noticed.
    expect((await request({ reason: "startup" })).statusCode).toBe(200);

    // 1. The start path requests replacement: fence plus token revocation in
    // one transaction.
    const requested = await store.requestHostSpecReplacement(task, {
      orbId: ORB,
      expectedStateVersion: store.orbSnapshot(ORB)?.stateVersion ?? 0,
      desiredFingerprint: "spec-new",
      configuredGeneration: 2,
      now: task.wallNow(),
    });
    expect(requested.isOk()).toBe(true);
    expect(store.orbSnapshot(ORB)).toMatchObject({
      hostDiscardReason: "host_spec_changed",
      runtimeTokenHash: null,
    });
    expect((await request({ reason: "startup" })).statusCode).toBe(401);

    // 2. Disposal is verified and finalized: still nothing is authorized.
    const finalized = await store.finalizeHostDiscard(task, {
      orbId: ORB,
      expectedStateVersion: store.orbSnapshot(ORB)?.stateVersion ?? 0,
      throughIncarnation: 0,
      now: task.wallNow(),
    });
    expect(finalized.isOk()).toBe(true);
    expect(store.orbSnapshot(ORB)).toMatchObject({
      hostIncarnation: 1,
      hostDiscardThroughIncarnation: null,
    });
    expect((await request({ reason: "startup" })).statusCode).toBe(401);
    expect((await request({ reason: "startup" }, NEW_TOKEN)).statusCode).toBe(401);

    // 3. Only the replacement commit authorizes the new incarnation — and the
    // old token stays dead forever.
    const committed = await store.casUpdateFields(task, {
      orbId: ORB,
      expectedStateVersion: store.orbSnapshot(ORB)?.stateVersion ?? 0,
      now: task.wallNow(),
      hostRef: "host-b",
      runtimeTokenHash: sha256(NEW_TOKEN),
      hostSpecFingerprint: "spec-new",
      hostSpecGeneration: 2,
      hostDiscardEvidence: null,
    });
    expect(committed.isOk()).toBe(true);
    expect((await request({ reason: "startup" }, NEW_TOKEN)).statusCode).toBe(200);
    expect((await request({ reason: "startup" })).statusCode).toBe(401);
  });

  it("rejects a missing bearer", async () => {
    seedOrb("running");
    seedCredential();
    const response = await request({ reason: "startup" }, null);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "unauthorized" });
  });

  it("rejects an unknown token", async () => {
    seedOrb("running");
    seedCredential();
    const response = await request({ reason: "startup" }, "wrong-token");
    expect(response.statusCode).toBe(401);
  });

  it("rejects the token of a stopped orb", async () => {
    seedOrb("stopped");
    seedCredential();
    const response = await request({ reason: "startup" });
    expect(response.statusCode).toBe(401);
  });

  it("grants a token during the first boot, while the orb is still creating", async () => {
    seedOrb("creating");
    seedCredential();
    const response = await request({ reason: "startup" });
    expect(response.statusCode).toBe(200);
  });

  it("rejects an invalid body", async () => {
    seedOrb("running");
    seedCredential();
    const response = await request({ reason: "sideways" });
    expect(response.statusCode).toBe(400);
  });

  it("maps a missing credential to 409 auth_required", async () => {
    seedOrb("running");
    const response = await request({ reason: "startup" });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "auth_required" });
  });

  it("maps a retryable broker failure to 503", async () => {
    seedOrb("running");
    // Pointer names a secret version that does not exist: the broker loops
    // until its (shortened) deadline and reports retryable.
    pointers.seedRow({
      provider: "openai-codex",
      rowVersion: 1,
      generation: 1,
      secretVersion: "missing",
      refreshLeaseUntil: 0,
      lastRefreshAt: 0,
    });
    const response = await request({ reason: "startup" });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe("retryable");
  });

  it("404s an unknown token name with a typed error", async () => {
    seedOrb("running");
    seedCredential();
    const response = await request({ reason: "startup" }, TOKEN, "sideways");
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "unknown_token" });
  });

  it("serves tokens/github as auth_required while no GitHub credential exists", async () => {
    seedOrb("running");
    seedCredential(); // model credential only
    const response = await request({ reason: "startup" }, TOKEN, "github");
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "auth_required" });
  });

  it("grants a github token once a github credential exists", async () => {
    seedOrb("running");
    const credential = makeCredential(task, { accountId: "octocat" });
    const version = secrets.seedSecret("github", credential);
    pointers.seedRow({
      provider: "github",
      rowVersion: 1,
      generation: 1,
      secretVersion: version,
      refreshLeaseUntil: 0,
      lastRefreshAt: 0,
    });
    const response = await request({ reason: "startup" }, TOKEN, "github");
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.accessToken).toBe(credential.access);
    expect(body.accountId).toBe("octocat");
  });

  it("requires a valid bearer on the github token too", async () => {
    seedOrb("running");
    const response = await request({ reason: "startup" }, "wrong-token", "github");
    expect(response.statusCode).toBe(401);
  });

  it("assigns a Luna name only while the orb remains unnamed", async () => {
    seedOrb("running");
    const first = await app.inject({
      method: "POST",
      url: ORB_NAME_TRIGGER_PATH,
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { text: "repair runtime auth", imageOnly: false, readme: "# pi-orb" },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ outcome: "assigned" });
    expect(store.orbSnapshot(ORB)?.name).toBe("Repair Runtime Auth");

    await store.setOrbName(task, {
      orbId: ORB,
      name: "Manual Name",
      now: task.wallNow(),
      onlyIfNull: false,
    });
    const second = await app.inject({
      method: "POST",
      url: ORB_NAME_TRIGGER_PATH,
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { text: "something else", imageOnly: false },
    });
    expect(second.json()).toEqual({ outcome: "already_named" });
    expect(store.orbSnapshot(ORB)?.name).toBe("Manual Name");
  });

  it("no longer serves the retired model-token path", async () => {
    seedOrb("running");
    seedCredential();
    const response = await app.inject({
      method: "POST",
      url: "/runtime/v1/model-token",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { reason: "startup" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("never serializes a refresh token", async () => {
    seedOrb("running");
    seedCredential();
    const response = await request({ reason: "startup" });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("refresh");
  });

  /**
   * The identity-mint boundary (docs/workload-identity.md). The domain's own
   * decisions are covered by `workload-identity.dst.test.ts`; what matters here
   * is that each typed denial reaches the caller as a distinguishable HTTP
   * answer whose body is on the wire contract, and that a successful token is
   * never cached.
   */
  describe("id-token minting", () => {
    /**
     * An hour-long mint floor. The domain stamps the slot claim from real wall
     * time here, so with the fixture's 1 s floor the throttle assertion would
     * really be an assertion about how fast the machine runs two injections —
     * green on a laptop, intermittently red on a loaded CI box, which is
     * exactly the un-reproducible failure AGENTS.md forbids. An hour is a floor
     * elapsed real time cannot plausibly cross, so what is under test is the
     * throttle logic alone. Every other case in this block mints at most once
     * against a store the hook rebuilds, so the larger floor is invisible to
     * them.
     */
    const HOUR_LONG_MINT_FLOOR = { ...TEST_ISSUER_CONSTANTS, minMintIntervalMs: 3_600_000 };

    beforeEach(async () => {
      await app.close();
      await startApp(HOUR_LONG_MINT_FLOOR);
    });

    function mint(body: unknown, token: string | null = TOKEN) {
      return app.inject({
        method: "POST",
        url: ID_TOKEN_PATH,
        ...(token === null ? {} : { headers: { authorization: `Bearer ${token}` } }),
        payload: body as Record<string, unknown>,
      });
    }

    it("mints a token whose claims come from the orb row, and forbids caching it", async () => {
      seedOrb("running");
      const response = await mint({ audience: "urn:example:service", ttlSeconds: 900 });

      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      const body = response.json();
      expect(Check(IdTokenResponseSchema, body)).toBe(true);

      const claims = decodeFakeIdToken(body.token);
      expect(claims).toMatchObject({
        iss: TEST_ISSUER_URL,
        aud: "urn:example:service",
        sub: ORB,
        orb_id: ORB,
        project_id: PROJECT,
        host_incarnation: 0,
        token_use: "exchanged",
      });
      // The requested lifetime is honored exactly, and the token names the key
      // that signed it so a verifier can find it in the published set.
      expect(claims.exp - claims.iat).toBe(900);
      expect(decodeFakeIdTokenKid(body.token)).toBe("route-key-1");
      // Nothing durable records the token itself; only the rate-limit stamp.
      expect(store.orbSnapshot(ORB)?.lastMintAt).not.toBeNull();
      expect(store.orbSnapshot(ORB)?.mintFailureCode).toBeNull();
    });

    it("defaults the lifetime when the caller asks for none", async () => {
      seedOrb("running");
      const response = await mint({ audience: "urn:example:service" });
      const claims = decodeFakeIdToken(response.json().token);
      expect(claims.exp - claims.iat).toBe(HOUR_LONG_MINT_FLOOR.defaultTtlSeconds);
    });

    it("rejects a malformed body before minting anything", async () => {
      seedOrb("running");
      for (const body of [
        {},
        { audience: "" },
        { audience: "a", ttlSeconds: 5 },
        // Identity is never accepted from the caller, not even as an extra key.
        { audience: "a", orbId: "another-orb" },
      ]) {
        const response = await mint(body);
        expect(response.statusCode, JSON.stringify(body)).toBe(400);
        expect(response.json().error).toBe("invalid_request");
        expect(Check(IdTokenErrorSchema, response.json())).toBe(true);
      }
      expect(signer.calls).toBe(0);
      expect(store.orbSnapshot(ORB)?.lastMintAt).toBeNull();
    });

    it("answers an unknown or absent bearer with a detail-free 401", async () => {
      seedOrb("running");
      for (const token of ["wrong-token", null]) {
        const response = await mint({ audience: "urn:example:service" }, token);
        expect(response.statusCode).toBe(401);
        // No message, no state, nothing that reveals another orb exists.
        expect(response.json()).toEqual({ error: "unauthorized" });
        expect(Check(IdTokenErrorSchema, response.json())).toBe(true);
      }
      // A bearer that resolves to no orb has no row to record a failure on.
      expect(store.orbSnapshot(ORB)?.mintFailureCode).toBeNull();
    });

    it("refuses a stopped orb with 403 and leaves the user a durable reason", async () => {
      seedOrb("stopped");
      const response = await mint({ audience: "urn:example:service" });

      expect(response.statusCode).toBe(403);
      expect(response.json().error).toBe("not_mintable");
      expect(Check(IdTokenErrorSchema, response.json())).toBe(true);
      expect(signer.calls).toBe(0);
      expect(store.orbSnapshot(ORB)?.mintFailureCode).toBe("not_mintable");
    });

    it("throttles a second mint inside the per-orb floor with 429 and a delay", async () => {
      seedOrb("running");
      expect((await mint({ audience: "urn:example:service" })).statusCode).toBe(200);

      const response = await mint({ audience: "urn:example:service" });
      expect(response.statusCode).toBe(429);
      const body = response.json();
      expect(body.error).toBe("rate_limited");
      // The delay is the remainder of the floor, so it lands just under it: a
      // whole minute of real time between the two injections still leaves the
      // window open, while a broken remainder computation does not.
      const floor = HOUR_LONG_MINT_FLOOR.minMintIntervalMs;
      expect(body.retryAfterMs).toBeGreaterThan(floor - 60_000);
      expect(body.retryAfterMs).toBeLessThanOrEqual(floor);
      expect(Check(IdTokenErrorSchema, body)).toBe(true);
      // Whole seconds, rounded up: a client honoring the header never returns
      // before the floor has actually passed.
      expect(Number(response.headers["retry-after"])).toBe(Math.ceil(body.retryAfterMs / 1000));
      expect(signer.calls).toBe(1);
      expect(store.orbSnapshot(ORB)?.mintFailureCode).toBe("rate_limited");
    });

    it("answers a signer outage with a retryable 503 and never an unsigned token", async () => {
      seedOrb("running");
      signer.failNextSignatures(1);
      const response = await mint({ audience: "urn:example:service" });

      expect(response.statusCode).toBe(503);
      expect(response.json().error).toBe("retryable");
      expect(Check(IdTokenErrorSchema, response.json())).toBe(true);
      // Failing closed means no token at all, not a token signed some other way.
      expect(response.json().token).toBeUndefined();
      expect(store.orbSnapshot(ORB)?.mintFailureCode).toBe("signer_failure");
    });

    it("answers a non-retryable 500 when the bearer lookup hits a store invariant", async () => {
      // A deterministic bug of ours must never be advertised as retryable
      // (docs/postmortems/2026-08-11-orb-message-jsonb-param-encoding.md).
      seedOrb("running");
      store.failWithInvariant("getOrbByRuntimeTokenHash");
      const response = await mint({ audience: "urn:example:service" });

      expect(response.statusCode).toBe(500);
      expect(response.json().error).toBe("internal");
      expect(Check(IdTokenErrorSchema, response.json())).toBe(true);
    });

    it("keeps the broker's token names out of the identity path", async () => {
      seedOrb("running");
      seedCredential();
      // The mint route is its own path, not another brokered token name.
      const asTokenName = await request({ reason: "startup" }, TOKEN, "id-token");
      expect(asTokenName.statusCode).toBe(404);
      expect(asTokenName.json()).toEqual({ error: "unknown_token" });
    });
  });
});
