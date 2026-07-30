import { createHash } from "node:crypto";
import { MODEL_TOKEN_PATH } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_BROKER_CONSTANTS } from "../domain/constants.ts";
import type { BrokerDeps } from "../domain/ports.ts";
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
      upstream: new FakeUpstream("unseeded"),
      constants: { ...DEFAULT_BROKER_CONSTANTS, requestDeadlineMs: 100, waiterPollMs: 5 },
    };
    store.seedProject(makeProjectRow(PROJECT));
    registerRuntimeRoutes(app, task, { store, broker });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  function seedOrb(state: "running" | "stopped", tokenHash: string | null = sha256(TOKEN)): void {
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

  function request(body: unknown, token: string | null = TOKEN) {
    return app.inject({
      method: "POST",
      url: MODEL_TOKEN_PATH,
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

  it("never serializes a refresh token", async () => {
    seedOrb("running");
    seedCredential();
    const response = await request({ reason: "startup" });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("refresh");
  });
});
