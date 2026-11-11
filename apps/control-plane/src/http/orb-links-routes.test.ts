import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { errAsync, okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { addOrbLink, type GithubLinkReader } from "../domain/orb-links.ts";
import { makeHarness, makeOrbRow, makeProjectRow } from "../testkit/fixtures.ts";
import { registerOrbLinkRoutes } from "./orb-links-routes.ts";

const ORB = "00000000-0000-4000-8000-0000000000a1";
const PR = "https://github.com/owner/repo/pull/7";

async function setup(
  github: GithubLinkReader = () => okAsync([{ title: "T", status: "open", checks: [] }]),
) {
  const task = new NoSimulationTask("orb link routes", false);
  const h = makeHarness();
  h.store.seedProject(makeProjectRow("project"));
  h.store.seedOrb(makeOrbRow(ORB, "project", "stopped"));
  const app = Fastify({ logger: false });
  registerOrbLinkRoutes(app, task, { store: h.store, github });
  return { task, h, app };
}

it("lists links with status and removes them", async () => {
  const { task, h, app } = await setup();
  try {
    await addOrbLink(task, h.store, ORB, PR);
    const listed = await app.inject({ method: "GET", url: `/api/v1/orbs/${ORB}/links` });
    expect(listed.statusCode).toBe(200);
    expect(listed.headers["cache-control"]).toBe("no-store");
    expect(listed.json()).toEqual({
      repository: "owner/repo",
      githubError: null,
      items: [
        {
          url: PR,
          addedAt: expect.any(Number),
          github: { title: "T", status: "open", checks: [] },
        },
      ],
    });
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/orbs/${ORB}/links?url=${encodeURIComponent(PR)}`,
    });
    expect(removed.statusCode).toBe(204);
    expect(
      (await app.inject({ method: "GET", url: `/api/v1/orbs/${ORB}/links` })).json().items,
    ).toEqual([]);
  } finally {
    await app.close();
  }
});

it("reports missing orbs, missing URLs and GitHub failures", async () => {
  const { task, h, app } = await setup(() => errAsync("GitHub login required"));
  try {
    for (const orb of ["not-a-uuid", "00000000-0000-4000-8000-0000000000ff"])
      expect(
        (await app.inject({ method: "GET", url: `/api/v1/orbs/${orb}/links` })).statusCode,
      ).toBe(404);
    expect(
      (await app.inject({ method: "DELETE", url: `/api/v1/orbs/${ORB}/links` })).statusCode,
    ).toBe(400);
    await addOrbLink(task, h.store, ORB, PR);
    const listed = (await app.inject({ method: "GET", url: `/api/v1/orbs/${ORB}/links` })).json();
    expect(listed.githubError).toBe("GitHub login required");
    expect(listed.items[0].github).toBeNull();
  } finally {
    await app.close();
  }
});
