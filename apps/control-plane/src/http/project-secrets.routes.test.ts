import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHarness, makeProjectRow, TEST_SYSTEM_VIEW } from "../testkit/fixtures.ts";
import { makeProjectSecretsHarness } from "../testkit/project-secrets.ts";
import { registerRoutes } from "./routes.ts";

const PROJECT = "00000000-0000-4000-8000-000000000061";
const task = new NoSimulationTask("project secrets routes", false);

describe("project secret browser routes", () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    const harness = makeHarness();
    const secrets = makeProjectSecretsHarness(PROJECT);
    harness.store.seedProject(makeProjectRow(PROJECT));
    app = Fastify();
    registerRoutes(
      app,
      task,
      { ...harness.deps, projectSecrets: secrets.deps },
      {},
      TEST_SYSTEM_VIEW,
    );
    await app.ready();
  });

  afterEach(async () => app.close());

  it("creates, lists, replaces, and removes without ever returning a value", async () => {
    const created = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${PROJECT}/secrets/NPM_TOKEN`,
      payload: { value: "first-secret-value" },
    });
    expect(created.statusCode).toBe(200);
    expect(created.body).not.toContain("first-secret-value");
    expect(created.json().items[0].name).toBe("NPM_TOKEN");

    const replaced = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${PROJECT}/secrets/NPM_TOKEN`,
      payload: { value: "second-secret-value" },
    });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.body).not.toContain("second-secret-value");
    expect(replaced.json().revision).toBe(2);

    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${PROJECT}/secrets`,
    });
    expect(listed.headers["cache-control"]).toBe("no-store");
    expect(listed.body).not.toContain("secret-value");

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${PROJECT}/secrets/NPM_TOKEN`,
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().items).toEqual([]);
  });

  it("rejects reserved names and missing projects", async () => {
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/v1/projects/${PROJECT}/secrets/PI_ORB_RUNTIME_TOKEN`,
          payload: { value: "nope" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/projects/00000000-0000-4000-8000-000000000099/secrets/TOKEN",
          payload: { value: "nope" },
        })
      ).statusCode,
    ).toBe(404);
  });
});
