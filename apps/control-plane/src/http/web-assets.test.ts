import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerWebAssets } from "./web-assets.ts";

describe("web assets", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-orb-web-assets-"));
    mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "index.html"), "<main>app shell</main>");
    writeFileSync(join(root, "assets", "app.js"), "export {};");
  });

  afterEach(() => rmSync(root, { force: true, recursive: true }));

  const app = async () => {
    const server = Fastify({ logger: false });
    await registerWebAssets(server, root);
    return server;
  };

  it.each(["/", "/index.html", "/?source=test"])(
    "serves the hash-router shell at %s",
    async (url) => {
      const server = await app();
      const response = await server.inject({ method: "GET", url });
      await server.close();
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("app shell");
    },
  );

  it("serves known built assets", async () => {
    const server = await app();
    const response = await server.inject({ method: "GET", url: "/assets/app.js" });
    await server.close();
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("export {};");
  });

  it("returns an honest page 404 when the build has no index", async () => {
    unlinkSync(join(root, "index.html"));
    const server = await app();
    const response = await server.inject({ method: "GET", url: "/" });
    await server.close();
    expect(response.statusCode).toBe(404);
    expect(response.body).toContain("Page doesn’t exist");
  });

  it.each(["/docs/host-provider-explainer.html", "/unknown", "/docs%2Fhidden.html"])(
    "keeps missing page URL %s and returns a dashboard link",
    async (url) => {
      const server = await app();
      const response = await server.inject({ method: "GET", url });
      await server.close();
      expect(response.statusCode).toBe(404);
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.body).toContain("Page doesn’t exist");
      expect(response.body).toContain('href="/"');
    },
  );

  it.each(["/api", "/api/v1/missing"])("keeps API 404 responses JSON at %s", async (url) => {
    const server = await app();
    const response = await server.inject({ method: "GET", url });
    await server.close();
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: "not_found" } });
  });

  it("returns the page-specific headers without a body for unknown HEAD", async () => {
    const server = await app();
    const response = await server.inject({ method: "HEAD", url: "/missing.html" });
    await server.close();
    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toBe("");
  });
});
