import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
