import { NoSimulationTask } from "determined";
import Fastify, { type InjectOptions } from "fastify";
import { errAsync, okAsync } from "neverthrow";
import { afterEach, expect, it } from "vitest";
import { bundledPlatformSkillNames } from "../adapters/durable/platform-resources.ts";
import { UserScope } from "../domain/user-scope.ts";
import { makeHarness, TEST_SYSTEM_VIEW } from "../testkit/fixtures.ts";
import type { FakeOwnerSkillStore } from "../testkit/owner-skills.ts";
import { registerRoutes } from "./routes.ts";

const ALICE = "00000000-0000-4000-8000-000000000001";
const BOB = "00000000-0000-4000-8000-000000000002";
const task = new NoSimulationTask("owner skill routes", false);
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));
const doc = (name: string, description = `${name} help`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\nSteps.\n`;

function setup() {
  const h = makeHarness();
  (h.deps.ownerSkills.store as FakeOwnerSkillStore).seedUser(BOB);
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
  const ownerSkills = { ...h.deps.ownerSkills, platformSkillNames: bundledPlatformSkillNames };
  registerRoutes(app, task, { ...h.deps, ownerSkills, userScope }, {}, TEST_SYSTEM_VIEW);
  return { app, deps: { ...h.deps, ownerSkills } };
}
const call = (app: ReturnType<typeof Fastify>, options: InjectOptions, principal = "alice") =>
  app.inject({ ...options, headers: { ...options.headers, "x-test-principal": principal } });
const names = (body: { items: Array<{ name: string }> }) => body.items.map((item) => item.name);

it("creates, replaces, renames and deletes owner skills, always answering with the full list", async () => {
  const { app } = setup();
  const empty = await call(app, { method: "GET", url: "/api/v1/owner-skills" });
  expect(empty.statusCode).toBe(200);
  expect(empty.json()).toEqual({ items: [] });
  expect(empty.headers["cache-control"]).toBe("no-store");

  const created = await call(app, {
    method: "POST",
    url: "/api/v1/owner-skills",
    payload: { content: doc("zeta") },
  });
  expect(created.statusCode).toBe(200);
  expect(created.headers["cache-control"]).toBe("no-store");
  expect(created.json().items).toEqual([
    { name: "zeta", description: "zeta help", content: doc("zeta"), updatedAt: expect.any(String) },
  ]);
  await call(app, {
    method: "POST",
    url: "/api/v1/owner-skills",
    payload: { content: doc("alpha") },
  });

  const replaced = await call(app, {
    method: "PUT",
    url: "/api/v1/owner-skills/zeta",
    payload: { content: doc("zeta", "better") },
  });
  expect(replaced.statusCode).toBe(200);
  expect(replaced.json().items[1].description).toBe("better");
  const renamed = await call(app, {
    method: "PUT",
    url: "/api/v1/owner-skills/zeta",
    payload: { content: doc("beta") },
  });
  expect(names(renamed.json())).toEqual(["alpha", "beta"]);
  const deleted = await call(app, { method: "DELETE", url: "/api/v1/owner-skills/alpha" });
  expect(deleted.statusCode).toBe(200);
  expect(deleted.headers["cache-control"]).toBe("no-store");
  expect(names(deleted.json())).toEqual(["beta"]);
  expect(names((await call(app, { method: "GET", url: "/api/v1/owner-skills" })).json())).toEqual([
    "beta",
  ]);
});

it("maps invalid, reserved, missing, conflicting and unavailable to 400/404/409/503", async () => {
  const { app, deps } = setup();
  await call(app, { method: "POST", url: "/api/v1/owner-skills", payload: { content: doc("a") } });
  await call(app, { method: "POST", url: "/api/v1/owner-skills", payload: { content: doc("b") } });
  const expectError = async (options: InjectOptions, status: number, code: string) => {
    const response = await call(app, options);
    expect(response.statusCode).toBe(status);
    expect(response.json().error.code).toBe(code);
    expect(response.headers["cache-control"]).toBe("no-store");
  };
  await expectError(
    { method: "POST", url: "/api/v1/owner-skills", payload: { content: "no frontmatter" } },
    400,
    "invalid_request",
  );
  await expectError(
    { method: "POST", url: "/api/v1/owner-skills", payload: { content: doc("a"), name: "a" } },
    400,
    "invalid_request",
  );
  // Real bundled platform skill names, derived from apps/orb-runtime/skills.
  for (const reserved of ["codemode", "charts", "hosting"])
    await expectError(
      { method: "POST", url: "/api/v1/owner-skills", payload: { content: doc(reserved) } },
      400,
      "invalid_request",
    );
  await expectError(
    { method: "POST", url: "/api/v1/owner-skills", payload: { content: doc("a") } },
    409,
    "conflict",
  );
  await expectError(
    { method: "PUT", url: "/api/v1/owner-skills/a", payload: { content: doc("b") } },
    409,
    "conflict",
  );
  await expectError(
    { method: "PUT", url: "/api/v1/owner-skills/missing", payload: { content: doc("missing") } },
    404,
    "not_found",
  );
  await expectError({ method: "DELETE", url: "/api/v1/owner-skills/missing" }, 404, "not_found");
  deps.ownerSkills.store.list = () =>
    errAsync({
      type: "owner_skill_error",
      code: "unavailable",
      message: "Owner skills unavailable",
    });
  const unavailable = await call(app, { method: "GET", url: "/api/v1/owner-skills" });
  expect(unavailable.statusCode).toBe(503);
  expect(unavailable.json().error).toMatchObject({ code: "unavailable", retryable: true });
});

it("scopes owner skills to the signed-in user", async () => {
  const { app } = setup();
  await call(app, {
    method: "POST",
    url: "/api/v1/owner-skills",
    payload: { content: doc("mine") },
  });
  expect((await call(app, { method: "GET", url: "/api/v1/owner-skills" }, "bob")).json()).toEqual({
    items: [],
  });
  expect(
    (await call(app, { method: "DELETE", url: "/api/v1/owner-skills/mine" }, "bob")).statusCode,
  ).toBe(404);
  expect(names((await call(app, { method: "GET", url: "/api/v1/owner-skills" })).json())).toEqual([
    "mine",
  ]);
});
