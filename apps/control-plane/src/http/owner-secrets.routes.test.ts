import { NoSimulationTask } from "determined";
import Fastify, { type InjectOptions } from "fastify";
import { okAsync } from "neverthrow";
import { afterEach, expect, it } from "vitest";
import { getOwnerSecretSnapshot } from "../domain/project-secrets.ts";
import { UserScope } from "../domain/user-scope.ts";
import { makeHarness, TEST_SYSTEM_VIEW } from "../testkit/fixtures.ts";
import { makeOwnerSecretsHarness } from "../testkit/project-secrets.ts";
import { registerRoutes } from "./routes.ts";

const ALICE = "00000000-0000-4000-8000-000000000001";
const BOB = "00000000-0000-4000-8000-000000000002";
const task = new NoSimulationTask("owner secrets routes", false);
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function setup() {
  const h = makeHarness();
  const secrets = makeOwnerSecretsHarness(ALICE, BOB);
  const userScope = new UserScope({
    getUser: (_task, id) => okAsync([ALICE, BOB].includes(id) ? { id, email: null } : null),
    resolveUser: (_task, _identity, input) => okAsync({ id: input.id, email: null }),
  });
  const app = Fastify();
  apps.push(app);
  app.decorateRequest("principal", undefined);
  app.addHook("onRequest", async (request) => {
    request.principal = {
      kind: "user",
      user: { id: request.headers["x-test-principal"] === "bob" ? BOB : ALICE, email: null },
    };
  });
  registerRoutes(
    app,
    task,
    { ...h.deps, userScope, ownerSecrets: secrets.deps },
    {},
    TEST_SYSTEM_VIEW,
  );
  return { app, secrets };
}

const inject = (app: ReturnType<typeof Fastify>, principal: string, options: InjectOptions) =>
  app.inject({ ...options, headers: { ...options.headers, "x-test-principal": principal } });

it("creates, lists, replaces, and removes the signed-in user's secrets without values", async () => {
  const { app, secrets } = setup();
  const created = await inject(app, "alice", {
    method: "PUT",
    url: "/api/v1/owner-secrets/NPM_TOKEN",
    payload: { value: "first-secret-value" },
  });
  expect(created.statusCode).toBe(200);
  expect(created.headers["cache-control"]).toBe("no-store");
  expect(created.body).not.toContain("first-secret-value");
  expect(created.json().items[0].name).toBe("NPM_TOKEN");

  const replaced = await inject(app, "alice", {
    method: "PUT",
    url: "/api/v1/owner-secrets/NPM_TOKEN",
    payload: { value: "second-secret-value" },
  });
  expect(replaced.statusCode).toBe(200);
  expect(replaced.json().revision).toBe(2);
  expect((await getOwnerSecretSnapshot(task, secrets.deps, ALICE))._unsafeUnwrap().values).toEqual({
    NPM_TOKEN: "second-secret-value",
  });

  const listed = await inject(app, "alice", { method: "GET", url: "/api/v1/owner-secrets" });
  expect(listed.statusCode).toBe(200);
  expect(listed.headers["cache-control"]).toBe("no-store");
  expect(listed.body).not.toContain("secret-value");
  expect(listed.json().items.map((item: { name: string }) => item.name)).toEqual(["NPM_TOKEN"]);

  const bob = await inject(app, "bob", { method: "GET", url: "/api/v1/owner-secrets" });
  expect(bob.json()).toEqual({ revision: 0, items: [] });
  const bobDelete = await inject(app, "bob", {
    method: "DELETE",
    url: "/api/v1/owner-secrets/NPM_TOKEN",
  });
  expect(bobDelete.json()).toEqual({ revision: 0, items: [] });

  const removed = await inject(app, "alice", {
    method: "DELETE",
    url: "/api/v1/owner-secrets/NPM_TOKEN",
  });
  expect(removed.statusCode).toBe(200);
  expect(removed.headers["cache-control"]).toBe("no-store");
  expect(removed.json()).toMatchObject({ revision: 3, items: [] });
});

it("rejects reserved names, bad bodies and oversized bundles with typed 400s", async () => {
  const { app } = setup();
  for (const [url, payload] of [
    ["/api/v1/owner-secrets/PI_ORB_RUNTIME_TOKEN", { value: "nope" }],
    ["/api/v1/owner-secrets/bad-name", { value: "nope" }],
    ["/api/v1/owner-secrets/TOKEN", { value: 1 }],
    ["/api/v1/owner-secrets/TOKEN", { value: "a".repeat(64 * 1024) }],
  ] as const) {
    const rejected = await inject(app, "alice", { method: "PUT", url, payload });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error).toMatchObject({ code: "invalid_request", retryable: false });
  }
  expect(
    (await inject(app, "alice", { method: "DELETE", url: "/api/v1/owner-secrets/bad-name" }))
      .statusCode,
  ).toBe(400);
  const listed = await inject(app, "alice", { method: "GET", url: "/api/v1/owner-secrets" });
  expect(listed.json()).toEqual({ revision: 0, items: [] });
});
