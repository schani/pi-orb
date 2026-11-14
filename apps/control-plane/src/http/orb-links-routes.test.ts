import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { errAsync, okAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import {
  addOrbLink,
  type GithubLinkReader,
  type GithubLinkStepsReader,
} from "../domain/orb-links.ts";
import { makeHarness, makeOrbRow, makeProjectRow, TEST_USER_ID } from "../testkit/fixtures.ts";
import { registerOrbLinkRoutes } from "./orb-links-routes.ts";

const ORB = "00000000-0000-4000-8000-0000000000a1";
const PR = "https://github.com/owner/repo/pull/7";

async function setup(
  github: GithubLinkReader = () =>
    okAsync({
      statuses: [{ title: "T", status: "open", diff: null, comments: null, checks: [] }],
      githubError: null,
    }),
  githubSteps: GithubLinkStepsReader = () => okAsync({ steps: [], githubError: null }),
) {
  const task = new NoSimulationTask("orb link routes", false);
  const h = makeHarness();
  h.store.seedProject(makeProjectRow("project"));
  h.store.seedOrb(makeOrbRow(ORB, "project", "stopped"));
  const app = Fastify({ logger: false });
  registerOrbLinkRoutes(app, task, { store: h.store, github, githubSteps });
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
          github: { title: "T", status: "open", diff: null, comments: null, checks: [] },
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

it("loads the selected check with the project owner token and validates IDs", async () => {
  const calls: unknown[][] = [];
  const { app } = await setup(undefined, (...args) => {
    calls.push(args);
    return okAsync({
      steps: [{ name: "test", result: "running", startedAt: 1, completedAt: null }],
      githubError: "partial",
    });
  });
  try {
    const path = `/api/v1/orbs/${ORB}/links/steps?checkId=CR_1`;
    const response = await app.inject({ method: "GET", url: path });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      steps: [{ name: "test", result: "running", startedAt: 1, completedAt: null }],
      githubError: "partial",
    });
    expect(calls[0]?.slice(1)).toEqual([TEST_USER_ID, "CR_1"]);
    for (const suffix of ["", "?checkId=bad%20id", `?checkId=${"x".repeat(513)}`])
      expect(
        (await app.inject({ method: "GET", url: `/api/v1/orbs/${ORB}/links/steps${suffix}` }))
          .statusCode,
      ).toBe(400);
  } finally {
    await app.close();
  }
});

it("logs one failure onset and recovery per operation", async () => {
  let message: string | null =
    "GitHub status partial: inaccessible 1 checks\nGitHub: request-id=first; rate-remaining=10";
  const { task, h, app } = await setup(() => okAsync({ statuses: [null], githubError: message }));
  const logs = vi.spyOn(task, "log");
  const edges = () => logs.mock.calls.filter(([line]) => String(line).includes("github-links-"));
  try {
    await addOrbLink(task, h.store, ORB, PR);
    logs.mockClear();
    const read = () => app.inject({ method: "GET", url: `/api/v1/orbs/${ORB}/links` });
    await read();
    message = "GitHub status HTTP 403: access denied\nGitHub: request-id=second; rate-remaining=9";
    await read();
    expect(edges()).toHaveLength(1);
    expect(edges()[0]?.[0]).toContain("github-links-failed");
    expect(edges()[0]?.[0]).toContain("request-id=first");
    message = null;
    await read();
    await read();
    expect(edges()).toHaveLength(2);
    expect(edges()[1]?.[0]).toContain("github-links-recovered");
  } finally {
    await app.close();
  }
});
