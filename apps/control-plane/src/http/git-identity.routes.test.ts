import { NoSimulationTask } from "determined";
import Fastify, { type InjectOptions } from "fastify";
import { errAsync } from "neverthrow";
import { afterEach, expect, it } from "vitest";
import { makeHarness, TEST_SYSTEM_VIEW, TEST_USER_ID } from "../testkit/fixtures.ts";
import type { FakeGitIdentityStore } from "../testkit/git-identity.ts";
import { registerRoutes } from "./routes.ts";

const OTHER = "00000000-0000-4000-8000-000000000002";
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function setup() {
  const h = makeHarness();
  const app = Fastify();
  apps.push(app);
  app.decorateRequest("principal", undefined);
  app.addHook("onRequest", async (request) => {
    request.principal =
      request.headers["x-test-principal"] === "ops"
        ? { kind: "ops", id: "machine" }
        : { kind: "user", user: { id: TEST_USER_ID, email: null } };
  });
  registerRoutes(app, new NoSimulationTask("git routes", false), h.deps, {}, TEST_SYSTEM_VIEW);
  return { app, store: h.deps.gitIdentity as FakeGitIdentityStore, h };
}
const put = (payload: object, headers: Record<string, string> = {}): InjectOptions => ({
  method: "PUT",
  url: "/api/v1/git-identity",
  payload,
  headers,
});

it("reads and saves the signed-in user's identity without caching", async () => {
  const { app, store } = setup();
  const initial = await app.inject({ method: "GET", url: "/api/v1/git-identity" });
  expect(initial.statusCode).toBe(200);
  expect(initial.json()).toEqual({ name: "", email: "" });
  expect(initial.headers["cache-control"]).toBe("no-store");
  for (const identity of [
    { name: "Ada", email: "ada@example.com" },
    { name: "", email: "" },
  ]) {
    const saved = await app.inject(put(identity));
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual(identity);
    expect(saved.headers["cache-control"]).toBe("no-store");
    expect(store.identities.get(TEST_USER_ID)).toEqual(identity);
  }
});

it("rejects invalid identities and exposes storage failures", async () => {
  const { app, store, h } = setup();
  for (const body of [
    { name: "Ada", email: "" },
    { name: "A\nB", email: "a@b" },
    { name: "A" },
    { name: "Ada", email: "ada" },
  ]) {
    const rejected = await app.inject(put(body));
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.code).toBe("invalid_request");
  }
  expect(store.identities.size).toBe(0);
  h.deps.gitIdentity.read = () =>
    errAsync({
      type: "git_identity_error",
      code: "unavailable",
      message: "Git identity unavailable",
    });
  expect((await app.inject({ method: "GET", url: "/api/v1/git-identity" })).statusCode).toBe(503);
});

it("requires ops to select a known user and refuses user self-selection", async () => {
  const { app, store } = setup();
  const ada = { name: "Ada", email: "ada@example.com" };
  expect((await app.inject(put(ada, { "x-test-principal": "ops" }))).statusCode).toBe(400);
  expect(
    (await app.inject(put(ada, { "x-test-principal": "ops", "x-pi-orb-user-id": OTHER })))
      .statusCode,
  ).toBe(400);
  expect(
    (await app.inject(put(ada, { "x-test-principal": "ops", "x-pi-orb-user-id": TEST_USER_ID })))
      .statusCode,
  ).toBe(200);
  expect(store.identities.get(TEST_USER_ID)).toEqual(ada);
  expect((await app.inject(put(ada, { "x-pi-orb-user-id": OTHER }))).statusCode).toBe(400);
});
