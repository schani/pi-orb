import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeHarness, makeOrbRow, makeProjectRow, TEST_SYSTEM_VIEW } from "../testkit/fixtures.ts";
import { registerRoutes } from "./routes.ts";

const task = new NoSimulationTask("orb create routes", false);

/**
 * Orb IDs become provider resource names, so the API rejects anything
 * outside the DNS-safe alphabet.
 */
describe("orb creation ID validation", () => {
  let harness: ReturnType<typeof makeHarness>;
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    harness = makeHarness();
    app = Fastify();
    harness.store.seedProject(makeProjectRow("project-ids"));
    registerRoutes(app, task, harness.deps, TEST_SYSTEM_VIEW);
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

  it("stores an optional IANA time zone once and rejects invalid zones", async () => {
    const url = "/api/v1/projects/project-ids/orbs";
    expect(
      (await app.inject({ method: "POST", url, payload: { id: "unknown-zone" } })).statusCode,
    ).toBe(202);
    expect(harness.store.orbSnapshot("unknown-zone")?.userTimeZone).toBeNull();
    for (const userTimeZone of ["Not/A_Zone", "GMT+25", "+01:00", ""]) {
      expect(
        (await app.inject({ method: "POST", url, payload: { id: "invalid-zone", userTimeZone } }))
          .statusCode,
      ).toBe(400);
      expect(harness.store.orbSnapshot("invalid-zone")).toBeNull();
    }
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          payload: { id: "zoned", userTimeZone: "America/New_York" },
        })
      ).statusCode,
    ).toBe(202);
    expect(harness.store.orbSnapshot("zoned")?.userTimeZone).toBe("America/New_York");
    expect((await app.inject({ method: "POST", url, payload: { id: "zoned" } })).statusCode).toBe(
      202,
    );
    expect(harness.store.orbSnapshot("zoned")?.userTimeZone).toBe("America/New_York");
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          payload: { id: "zoned", userTimeZone: "Asia/Tokyo" },
        })
      ).statusCode,
    ).toBe(409);
    expect(harness.store.orbSnapshot("zoned")?.userTimeZone).toBe("America/New_York");
  });

  it("persists immutable harness selection and defaults to Pi", async () => {
    const url = "/api/v1/projects/project-ids/orbs";
    const pi = await app.inject({ method: "POST", url, payload: { id: "pi" } });
    expect(pi.json().harness).toBe("pi");
    const claude = await app.inject({
      method: "POST",
      url,
      payload: { id: "claude", harness: "claude" },
    });
    expect(claude.statusCode).toBe(202);
    expect(claude.json().harness).toBe("claude");
    expect(harness.store.orbSnapshot("claude")?.harness).toBe("claude");
    expect(
      (await app.inject({ method: "POST", url, payload: { id: "invalid", harness: "other" } }))
        .statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "POST", url, payload: { id: "claude", harness: "pi" } }))
        .statusCode,
    ).toBe(409);
    expect((await app.inject({ method: "POST", url, payload: { id: "claude" } })).statusCode).toBe(
      202,
    );
    expect((await app.inject({ method: "GET", url: "/api/v1/orbs/claude" })).json().harness).toBe(
      "claude",
    );
  });

  it("shapes an existing orb without a second project lookup", async () => {
    harness.store.seedOrb(makeOrbRow("orb-existing", "project-ids", "starting"));
    const getProject = vi.spyOn(harness.store, "getProject");
    const response = await app.inject({ method: "GET", url: "/api/v1/orbs/orb-existing" });
    expect(response.statusCode).toBe(200);
    expect(getProject).not.toHaveBeenCalled();
  });
});
