import { createHash } from "node:crypto";
import { HOSTING_FILES_PATH } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHarness, makeOrbRow } from "../testkit/fixtures.ts";
import { createHostingAccessPolicy, registerHostingAccessGuard } from "./hosting-access.ts";
import { registerBrowserHostingRoutes, registerRuntimeHostingRoutes } from "./hosting-routes.ts";

const ORB = "00000000-0000-4000-8000-000000000071";
const TOKEN = "runtime-token";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

describe("hosting HTTP routes", () => {
  const task = new NoSimulationTask("hosting routes", false);
  let app: ReturnType<typeof Fastify>;
  let harness: ReturnType<typeof makeHarness>;

  beforeEach(async () => {
    harness = makeHarness({ hostingOrbId: ORB });
    harness.store.seedOrb(
      makeOrbRow(ORB, "project", "running", {
        runtimeTokenHash: hash(TOKEN),
        hostIncarnation: 1,
      }),
    );
    app = Fastify();
    registerHostingAccessGuard(
      app,
      createHostingAccessPolicy({ filesOrigin: "https://files.example.test" })._unsafeUnwrap(),
      "https://app.example.test",
    );
    const deps = {
      store: harness.store,
      hosting: harness.hosting.deps,
      filesOrigin: "https://files.example.test",
      appOrigin: "https://app.example.test",
    };
    await registerRuntimeHostingRoutes(app, task, deps);
    registerBrowserHostingRoutes(app, task, deps);
    await app.ready();
  });

  afterEach(async () => app.close());

  it("authenticates before streaming and publishes raw text without body parsing", async () => {
    const unauthorized = await app.inject({
      method: "POST",
      url: `${HOSTING_FILES_PATH}?path=index.html`,
      headers: {
        host: "app.example.test",
        "content-type": "text/plain",
        "content-length": "5",
        "x-pi-orb-request-id": "00000000-0000-4000-8000-000000000091",
        "x-pi-orb-sha256": hash("alpha"),
      },
      payload: "alpha",
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(harness.hosting.ownedObjects()).toEqual([]);

    const uploaded = await app.inject({
      method: "POST",
      url: `${HOSTING_FILES_PATH}?path=index.html`,
      headers: {
        host: "app.example.test",
        authorization: `Bearer ${TOKEN}`,
        "content-type": "text/plain",
        "content-length": "5",
        "x-pi-orb-request-id": "00000000-0000-4000-8000-000000000091",
        "x-pi-orb-sha256": hash("alpha"),
      },
      payload: "alpha",
    });
    expect(uploaded.statusCode).toBe(201);
    expect(uploaded.json().file.url).toBe(`https://files.example.test/s/${ORB}/index.html`);
  });

  it("lists and removes only the authenticated orb namespace", async () => {
    const headers = { authorization: `Bearer ${TOKEN}`, host: "app.example.test" };
    const listed = await app.inject({ method: "GET", url: HOSTING_FILES_PATH, headers });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ files: [], cleanupIssues: [] });
    const removed = await app.inject({
      method: "DELETE",
      url: `${HOSTING_FILES_PATH}?path=x.txt`,
      headers,
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ path: "x.txt" });
  });

  it("serves a published immutable snapshot with private revalidation headers", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/s/${ORB}/missing.html`,
      headers: { host: "files.example.test" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.body).toContain("Hosted file doesn't exist");
    expect(response.body).toContain("https://app.example.test");
  });

  it("serves GET, HEAD, conditional GET, and directory index from one exact snapshot", async () => {
    const uploaded = await app.inject({
      method: "POST",
      url: `${HOSTING_FILES_PATH}?path=design/index.html`,
      headers: {
        host: "app.example.test",
        authorization: `Bearer ${TOKEN}`,
        "content-type": "text/html",
        "content-length": "5",
        "x-pi-orb-request-id": "00000000-0000-4000-8000-000000000092",
        "x-pi-orb-sha256": hash("alpha"),
      },
      payload: "alpha",
    });
    expect(uploaded.statusCode).toBe(201);
    const redirect = await app.inject({
      method: "GET",
      url: `/s/${ORB}/design`,
      headers: { host: "files.example.test" },
    });
    expect(redirect.statusCode).toBe(308);
    expect(redirect.headers.location).toBe(`/s/${ORB}/design/`);
    const url = `/s/${ORB}/design/`;
    const get = await app.inject({ method: "GET", url, headers: { host: "files.example.test" } });
    expect(get.statusCode).toBe(200);
    expect(get.body).toBe("alpha");
    expect(get.headers["cache-control"]).toBe("private, no-cache");
    expect(get.headers["x-content-type-options"]).toBe("nosniff");
    const head = await app.inject({ method: "HEAD", url, headers: { host: "files.example.test" } });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe("");
    const conditional = await app.inject({
      method: "GET",
      url,
      headers: { host: "files.example.test", "if-none-match": get.headers.etag as string },
    });
    expect(conditional.statusCode).toBe(304);
  });

  it("returns the hosted-resource 404 for malformed orb namespaces", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/s/not-a-uuid/file.html",
      headers: { host: "files.example.test" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.body).toContain("Hosted file doesn't exist");
    expect(response.body).toContain("Dashboard");
  });

  it.each([
    {
      query: "path=../x",
      requestId: "00000000-0000-4000-8000-000000000093",
      digest: hash("alpha"),
    },
    {
      query: "path=x&other=y",
      requestId: "00000000-0000-4000-8000-000000000093",
      digest: hash("alpha"),
    },
    { query: "path=x", requestId: "not-a-uuid", digest: hash("alpha") },
    { query: "path=x", requestId: "00000000-0000-4000-8000-000000000093", digest: "bad" },
  ])("rejects invalid upload metadata before reservation", async ({ query, requestId, digest }) => {
    const response = await app.inject({
      method: "POST",
      url: `${HOSTING_FILES_PATH}?${query}`,
      headers: {
        host: "app.example.test",
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        "content-length": "5",
        "x-pi-orb-request-id": requestId,
        "x-pi-orb-sha256": digest,
      },
      payload: "alpha",
    });
    expect(response.statusCode).toBe(400);
    expect(harness.hosting.ownedObjects()).toEqual([]);
  });

  it.each(["/api/v1/orbs", "/runtime/v1/hosting/files", "/s%2Forb%2Ffile.html"])(
    "does not expose %s through the files host",
    async (url) => {
      const response = await app.inject({
        method: "GET",
        url,
        headers: { host: "files.example.test" },
      });
      expect(response.statusCode).toBe(404);
      expect(response.body).toContain("Dashboard");
    },
  );

  it("rejects the files origin from app mutations and websocket handshakes", async () => {
    for (const headers of [
      { host: "app.example.test", origin: "https://files.example.test" },
      { host: "app.example.test", origin: "https://files.example.test", upgrade: "websocket" },
    ]) {
      const response = await app.inject({
        method: "DELETE",
        url: `${HOSTING_FILES_PATH}?path=x`,
        headers,
      });
      expect(response.statusCode).toBe(403);
    }
  });
});
