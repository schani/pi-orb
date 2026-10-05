import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionProbe } from "@pi-orb/protocol";
import { chromium, expect as expectPage } from "@playwright/test";
import Fastify from "fastify";
import { build } from "vite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { registerWebAssets } from "../apps/control-plane/src/http/web-assets.ts";

const root = mkdtempSync(join(tmpdir(), "pi-orb-built-shell-"));
const app = Fastify({ logger: false });
let browser: Awaited<ReturnType<typeof chromium.launch>>;

beforeAll(async () => {
  await build({
    root: join(import.meta.dirname, "../apps/web"),
    configFile: join(import.meta.dirname, "../apps/web/vite.config.ts"),
    build: { outDir: root, emptyOutDir: true },
  });
  app.get(
    "/api/v1/session",
    (): SessionProbe => ({
      status: "ok",
      principal: { kind: "user", user: { id: "built-shell-user", email: null } },
    }),
  );
  await registerWebAssets(app, root);
  await app.listen({ host: "127.0.0.1", port: 0 });
  browser = await chromium.launch({
    ...(process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"]
      ? { executablePath: process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"] }
      : existsSync("/usr/bin/chromium")
        ? { executablePath: "/usr/bin/chromium" }
        : {}),
    args: ["--no-sandbox"],
  });
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

it.each(["/", "/orbs/missing-orb"])(
  "%s freezes orb ordering across polls, but not activity or reload",
  async (path) => {
    const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const page = await browser.newPage();
    const project = {
      id: "ordering",
      name: "Ordering",
      state: "active",
      repositoryUrl: "https://github.com/example/ordering",
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
    };
    const older = {
      id: "older",
      projectId: project.id,
      name: "Older",
      state: "running",
      stateVersion: 1,
      stateChangedAt: project.createdAt,
      createdAt: project.createdAt,
      updatedAt: "2026-10-02T00:00:00Z",
      activity: "idle",
    };
    const newer = { ...older, id: "newer", name: "Newer", updatedAt: "2026-10-03T00:00:00Z" };
    let items = [older, newer];
    const rows = path === "/" ? ".orb-entry-link" : ".ix-row .trunc";
    try {
      await page.route("**/api/v1/projects", (route) =>
        route.fulfill({ json: { items: [project] } }),
      );
      await page.route("**/api/v1/projects/ordering/orbs", (route) =>
        route.fulfill({ json: { items } }),
      );
      await page.goto(`${origin}${path}`);
      await expectPage(page.locator(rows)).toHaveText(["Newer", "Older"]);
      items = [
        { ...older, name: "Refreshed", activity: "busy", updatedAt: "2100-01-01T00:00:00Z" },
        newer,
      ];
      await expectPage(page.locator(rows).filter({ hasText: "Refreshed" })).toHaveCount(1);
      await expectPage(page.locator(rows)).toHaveText(["Newer", "Refreshed"]);
      const refreshedRow = page.locator(path === "/" ? ".orb-entry" : ".ix-row", {
        hasText: "Refreshed",
      });
      await expectPage(refreshedRow.locator('img[src="/favicons/busy.svg"]')).toHaveCount(1);
      await expectPage(
        refreshedRow.locator(path === "/" ? ".orb-entry-meta > span:first-child" : ".ix-age"),
      ).toHaveText("1s");
      await page.reload();
      await expectPage(page.locator(rows)).toHaveText(["Refreshed", "Newer"]);
    } finally {
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
    }
  },
);

it("boots the production shell and loads its built JS, CSS and favicon on direct deep links and reload", async () => {
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const page = await browser.newPage();
  const responses: { path: string; status: number }[] = [];
  page.on("response", (response) =>
    responses.push({ path: new URL(response.url()).pathname, status: response.status() }),
  );
  try {
    await page.goto(`${origin}/orbs/missing-orb`);
    await expectPage(page.getByText("Orb doesn't exist")).toBeVisible();
    await page.reload();
    await expectPage(page.getByText("Orb doesn't exist")).toBeVisible();
    expect(page.url()).toBe(`${origin}/orbs/missing-orb`);
    const fontsLoaded = await page.locator("body").evaluate(async (body) => {
      const fonts = body.ownerDocument.fonts;
      const faces = await Promise.all([
        fonts.load('13px "Iosevka Etoile"'),
        fonts.load('13px "JetBrains Mono"'),
      ]);
      return faces.every(
        (family: { status: string }[]) =>
          family.length > 0 && family.every((face) => face.status === "loaded"),
      );
    });
    expect(fontsLoaded).toBe(true);
    expect(
      responses.filter(({ path, status }) => path.endsWith(".woff2") && status === 200).length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      responses.some(({ path, status }) => path.startsWith("/assets/") && status === 200),
    ).toBe(true);
    const favicon = await page.locator('link[rel="icon"]').getAttribute("href");
    expect(favicon).toBeTruthy();
    expect((await page.request.get(`${origin}${favicon}`)).status()).toBe(200);
    expect(responses.some(({ path, status }) => path.endsWith(".js") && status === 200)).toBe(true);
    expect(responses.some(({ path, status }) => path.endsWith(".css") && status === 200)).toBe(
      true,
    );
    await page.route("**/api/v1/projects", (route) => route.fulfill({ json: { items: [] } }));
    await page.goto(`${origin}/projects/missing-project`);
    await expectPage(page.getByText("Project doesn't exist")).toBeVisible();
    expect(page.url()).toBe(`${origin}/projects/missing-project`);
    await expectPage(page.getByRole("link", { name: "Back to dashboard" })).toHaveAttribute(
      "href",
      "/",
    );
    await page.goto(`${origin}/unrecognized`);
    await expectPage(page.getByText("Page doesn't exist")).toBeVisible();
    expect(page.url()).toBe(`${origin}/unrecognized`);
    await expectPage(page.getByRole("link", { name: "Back to dashboard" })).toHaveAttribute(
      "href",
      "/",
    );
  } finally {
    await page.close();
  }
});
