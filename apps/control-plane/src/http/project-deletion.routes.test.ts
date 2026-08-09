import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHarness, makeOrbRow, makeProjectRow } from "../testkit/fixtures.ts";
import { registerRoutes } from "./routes.ts";

const task = new NoSimulationTask("project deletion routes", false);

describe("project deletion HTTP API", () => {
  let harness: ReturnType<typeof makeHarness>;
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    harness = makeHarness();
    app = Fastify();
    harness.store.seedProject(makeProjectRow("project-http"));
    harness.store.seedOrb(makeOrbRow("orb-http", "project-http", "stopped"));
    registerRoutes(app, task, harness.deps, {});
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns deleting progress and rejects new children", async () => {
    const deleted = await app.inject({ method: "DELETE", url: "/api/v1/projects/project-http" });
    expect(deleted.statusCode).toBe(202);
    expect(deleted.json()).toMatchObject({
      id: "project-http",
      state: "deleting",
      deletionProgress: { total: 1, remaining: 1, blocked: 0 },
    });

    const repeated = await app.inject({ method: "DELETE", url: "/api/v1/projects/project-http" });
    expect(repeated.statusCode).toBe(202);
    expect(repeated.json().deletionProgress.total).toBe(1);

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project-http/orbs",
      payload: { id: "too-late" },
    });
    expect(create.statusCode).toBe(409);
    expect(create.json().error.message).toContain("project");
  });

  it("renames an active project and rejects invalid or deleting-project renames", async () => {
    const renamed = await app.inject({
      method: "PATCH",
      url: "/api/v1/projects/project-http",
      payload: { name: "  cloud   smoke  " },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().name).toBe("cloud smoke");

    const invalid = await app.inject({
      method: "PATCH",
      url: "/api/v1/projects/project-http",
      payload: { name: "   " },
    });
    expect(invalid.statusCode).toBe(400);

    await app.inject({ method: "DELETE", url: "/api/v1/projects/project-http" });
    const tooLate = await app.inject({
      method: "PATCH",
      url: "/api/v1/projects/project-http",
      payload: { name: "too late" },
    });
    expect(tooLate.statusCode).toBe(409);
  });

  it("keeps a missing project URL missing", async () => {
    const response = await app.inject({ method: "DELETE", url: "/api/v1/projects/missing" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("not_found");
  });
});
