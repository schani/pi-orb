import { createHash } from "node:crypto";
import { ORB_NAME_TRIGGER_PATH, runtimeTokenPath, type TokenName } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { okAsync } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_BROKER_CONSTANTS } from "../domain/constants.ts";
import type { BrokerDeps, OrbNameGenerator } from "../domain/ports.ts";
import {
  FakePointerStore,
  FakeSecretStore,
  FakeUpstream,
  makeCredential,
} from "../testkit/broker.ts";
import { makeOrbRow, makeProjectRow } from "../testkit/fixtures.ts";
import { InMemoryControlPlaneStore } from "../testkit/store.ts";
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

  beforeEach(async () => {
    app = Fastify();
    store = new InMemoryControlPlaneStore(0);
    pointers = new FakePointerStore();
    secrets = new FakeSecretStore();
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
    const nameGenerator: OrbNameGenerator = {
      generate: () => okAsync("Repair Runtime Auth"),
    };
    registerRuntimeRoutes(app, task, { store, broker, nameGenerator, nameLeaseMs: 30_000 });
    await app.ready();
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
});
