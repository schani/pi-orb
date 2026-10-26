import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { okAsync } from "neverthrow";
import { afterEach, expect, it } from "vitest";
import { bundledPlatformSkillNames } from "../adapters/durable/platform-resources.ts";
import { UserScope } from "../domain/user-scope.ts";
import { makeHarness, TEST_SYSTEM_VIEW } from "../testkit/fixtures.ts";
import { makeProjectSecretsHarness } from "../testkit/project-secrets.ts";
import { registerRoutes } from "./routes.ts";

const ALICE = "00000000-0000-4000-8000-000000000001";
const BOB = "00000000-0000-4000-8000-000000000002";
const task = new NoSimulationTask("owner routes", false);
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));
const doc = (name: string, description = `${name} help`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\nSteps.\n`;

async function setup() {
  const h = makeHarness();
  const ownerSecrets = makeProjectSecretsHarness(ALICE, BOB).deps;
  const platformSkillNames = (await bundledPlatformSkillNames())._unsafeUnwrap();
  const userScope = new UserScope({
    getUser: (_task, id) => okAsync([ALICE, BOB].includes(id) ? { id, email: null } : null),
    resolveUser: (_task, _identity, input) => okAsync({ id: input.id, email: null }),
  });
  const app = Fastify();
  apps.push(app);
  app.decorateRequest("principal", undefined);
  app.addHook("onRequest", async (request) => {
    const id = request.headers["x-test-principal"] === "bob" ? BOB : ALICE;
    request.principal = { kind: "user", user: { id, email: null } };
  });
  const deps = { ...h.deps, ownerSecrets, userScope };
  registerRoutes(
    app,
    task,
    { ...deps, ownerSkills: { ...h.deps.ownerSkills, platformSkillNames } },
    {},
    TEST_SYSTEM_VIEW,
  );
  const call = async (method: Method, url: string, payload?: object, as = "alice") => {
    const headers = { "x-test-principal": as };
    const response = await app.inject({ method, url, headers, ...(payload && { payload }) });
    expect(response.headers["cache-control"]).toBe("no-store");
    return { status: response.statusCode, body: response.json() };
  };
  return { call };
}
type Method = "GET" | "POST" | "PUT" | "DELETE";
const names = (body: { items: Array<{ name: string }> }) => body.items.map((item) => item.name);

it("creates, replaces, renames and deletes the signed-in owner's skills", async () => {
  const { call } = await setup();
  const created = await call("POST", "/api/v1/owner-skills", { content: doc("zeta") });
  expect(created.body.items).toMatchObject([{ name: "zeta", description: "zeta help" }]);
  await call("POST", "/api/v1/owner-skills", { content: doc("alpha") });
  const renamed = await call("PUT", "/api/v1/owner-skills/zeta", { content: doc("beta", "new") });
  expect(renamed.body.items).toMatchObject([
    { name: "alpha" },
    { name: "beta", description: "new" },
  ]);
  expect(names((await call("DELETE", "/api/v1/owner-skills/alpha")).body)).toEqual(["beta"]);
  expect((await call("GET", "/api/v1/owner-skills", undefined, "bob")).body).toEqual({ items: [] });
  expect((await call("DELETE", "/api/v1/owner-skills/beta", undefined, "bob")).status).toBe(404);

  for (const [method, url, content, status] of [
    ["POST", "/api/v1/owner-skills", "no frontmatter", 400],
    ["POST", "/api/v1/owner-skills", doc("Bad_Name"), 400],
    ["POST", "/api/v1/owner-skills", doc("codemode"), 400],
    ["POST", "/api/v1/owner-skills", doc("beta"), 409],
    ["PUT", "/api/v1/owner-skills/missing", doc("missing"), 404],
  ] as const)
    expect((await call(method, url, { content })).status).toBe(status);
  expect(names((await call("GET", "/api/v1/owner-skills")).body)).toEqual(["beta"]);
});

it("writes the signed-in owner's secrets without ever returning values", async () => {
  const { call } = await setup();
  const put = await call("PUT", "/api/v1/owner-secrets/NPM_TOKEN", { value: "secret-value" });
  expect(put.status).toBe(200);
  expect(JSON.stringify(put.body)).not.toContain("secret-value");
  expect(names((await call("GET", "/api/v1/owner-secrets")).body)).toEqual(["NPM_TOKEN"]);
  expect((await call("GET", "/api/v1/owner-secrets", undefined, "bob")).body).toEqual({
    revision: 0,
    items: [],
  });
  for (const [name, value] of [
    ["PI_ORB_RUNTIME_TOKEN", "x"],
    ["TOKEN", 1],
  ])
    expect((await call("PUT", `/api/v1/owner-secrets/${name}`, { value })).status).toBe(400);
  expect((await call("DELETE", "/api/v1/owner-secrets/NPM_TOKEN")).body).toEqual({
    revision: 2,
    items: [],
  });
});
