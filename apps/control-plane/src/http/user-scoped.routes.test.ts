import { NoSimulationTask } from "determined";
import Fastify, { type InjectOptions } from "fastify";
import { okAsync } from "neverthrow";
import { afterEach, expect, it } from "vitest";
import { UserScope } from "../domain/user-scope.ts";
import { makeHarness, TEST_SYSTEM_VIEW } from "../testkit/fixtures.ts";
import type { FakePersonalInstructionsStore } from "../testkit/personal-instructions.ts";
import { registerRoutes } from "./routes.ts";

const ALICE = "00000000-0000-4000-8000-000000000001";
const BOB = "00000000-0000-4000-8000-000000000002";
const task = new NoSimulationTask("user scoped routes", false);
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function setup() {
  const h = makeHarness();
  (h.deps.personalInstructions as FakePersonalInstructionsStore).seedUser(BOB);
  const userScope = new UserScope({
    getUser: (_task, id) =>
      okAsync([ALICE, BOB].includes(id) ? { id, email: `${id === ALICE ? "a" : "b"}@test` } : null),
    resolveUser: (_task, _identity, input) => okAsync({ id: input.id, email: null }),
  });
  const app = Fastify();
  apps.push(app);
  app.decorateRequest("principal", undefined);
  app.addHook("onRequest", async (request) => {
    const selected = request.headers["x-test-principal"];
    request.principal =
      selected === "ops"
        ? { kind: "ops", id: "machine" }
        : { kind: "user", user: { id: selected === "bob" ? BOB : ALICE, email: null } };
  });
  registerRoutes(app, task, { ...h.deps, userScope }, {}, TEST_SYSTEM_VIEW);
  return app;
}

const project = (id: string) => ({
  id,
  name: "Same name",
  repositoryUrl: "https://github.com/o/r",
});
const inject = (app: ReturnType<typeof Fastify>, principal: string, options: InjectOptions) =>
  app.inject({ ...options, headers: { ...options.headers, "x-test-principal": principal } });

it("scopes default project creation/listing and idempotency to the signed-in user", async () => {
  const app = setup();
  const a = project("10000000-0000-4000-8000-000000000001");
  const b = project("10000000-0000-4000-8000-000000000002");
  expect(
    (await inject(app, "alice", { method: "POST", url: "/api/v1/projects", payload: a }))
      .statusCode,
  ).toBe(201);
  expect(
    (await inject(app, "alice", { method: "POST", url: "/api/v1/projects", payload: a }))
      .statusCode,
  ).toBe(201);
  const nameConflict = await inject(app, "alice", {
    method: "POST",
    url: "/api/v1/projects",
    payload: project("10000000-0000-4000-8000-000000000003"),
  });
  expect(nameConflict.statusCode).toBe(409);
  expect(nameConflict.json().error.message).toBe("project name already exists");
  const idConflict = await inject(app, "bob", {
    method: "POST",
    url: "/api/v1/projects",
    payload: a,
  });
  expect(idConflict.statusCode).toBe(409);
  expect(idConflict.json().error.message).toBe("project id or state conflicts with this request");
  expect(
    (await inject(app, "bob", { method: "POST", url: "/api/v1/projects", payload: b })).statusCode,
  ).toBe(201);
  const alice = await inject(app, "alice", { method: "GET", url: "/api/v1/projects" });
  const bob = await inject(app, "bob", { method: "GET", url: "/api/v1/projects" });
  expect(alice.json().items.map((item: { id: string }) => item.id)).toEqual([a.id]);
  expect(bob.json().items.map((item: { id: string }) => item.id)).toEqual([b.id]);
});

it("keeps personal instructions independent", async () => {
  const app = setup();
  for (const [principal, content] of [
    ["alice", "alice"],
    ["bob", "bob"],
  ] as const)
    expect(
      (
        await inject(app, principal, {
          method: "PUT",
          url: "/api/v1/personal-instructions",
          payload: { content },
        })
      ).statusCode,
    ).toBe(200);
  expect(
    (await inject(app, "alice", { method: "GET", url: "/api/v1/personal-instructions" })).json(),
  ).toEqual({ content: "alice", revision: 1 });
  expect(
    (await inject(app, "bob", { method: "GET", url: "/api/v1/personal-instructions" })).json(),
  ).toEqual({ content: "bob", revision: 1 });
});

it("requires a valid explicit ops user only on user-scoped operations", async () => {
  const app = setup();
  for (const headers of [
    {},
    { "x-pi-orb-user-id": "bad" },
    { "x-pi-orb-user-id": "00000000-0000-4000-8000-000000000099" },
  ])
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/projects",
          headers: { ...headers, "x-test-principal": "ops" },
        })
      ).statusCode,
    ).toBe(400);
  expect(
    (
      await app.inject({
        method: "GET",
        url: "/api/v1/projects",
        headers: { "x-test-principal": "ops", "x-pi-orb-user-id": ALICE },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await app.inject({
        method: "GET",
        url: "/api/v1/system",
        headers: { "x-test-principal": "ops" },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await app.inject({
        method: "GET",
        url: "/api/v1/projects",
        headers: { "x-test-principal": "alice", "x-pi-orb-user-id": ALICE },
      })
    ).statusCode,
  ).toBe(400);
});
