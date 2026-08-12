import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHarness, makeProjectRow } from "../testkit/fixtures.ts";
import { registerRoutes } from "./routes.ts";

const task = new NoSimulationTask("orb create routes", false);

/**
 * Orb IDs become provider resource names, MagicDNS labels, and Tailscale key
 * descriptions (`pi-orb <id> i<n>`). An unconstrained ID containing a space
 * could make one orb's exact-match key cleanup match another orb's resources,
 * so the API rejects anything outside the DNS-safe alphabet.
 */
describe("orb creation ID validation", () => {
  let harness: ReturnType<typeof makeHarness>;
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    harness = makeHarness();
    app = Fastify();
    harness.store.seedProject(makeProjectRow("project-ids"));
    registerRoutes(app, task, harness.deps, {});
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  const create = (id: string) =>
    app.inject({ method: "POST", url: "/api/v1/projects/project-ids/orbs", payload: { id } });

  it("accepts UUID-shaped and simple alphanumeric-hyphen IDs", async () => {
    expect((await create("6ceb79c1-cfc9-4a85-93ef-7e46b8dbe285")).statusCode).toBe(202);
    expect((await create("orb-1")).statusCode).toBe(202);
  });

  it("rejects IDs that would escape exact-match resource ownership", async () => {
    for (const id of ["foo i3", " leading", "trailing ", "a/b", "a.b", "", "-leading-hyphen"]) {
      const response = await create(id);
      expect(response.statusCode, `id ${JSON.stringify(id)}`).toBe(400);
      expect(response.json().error.code).toBe("invalid_request");
    }
  });
});
