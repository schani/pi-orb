import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium, expect, webkit } from "@playwright/test";
import { createServer } from "vite";
import { it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";
import { gotoFrontendHistory } from "./testkit/frontend-fixture.ts";

const ORB = "frontend-fixture-orb";

it.each(["chromium", "webkit"] as const)(
  "%s: initially open stopped-orb image loads with no metadata or inbox rerender",
  async (engine) => {
    const root = join(import.meta.dirname, "../apps/web");
    const cacheDir = await mkdtemp(join(tmpdir(), `pi-orb-owner-${engine}-`));
    const vite = await createServer({
      root,
      configFile: join(root, "vite.config.ts"),
      cacheDir,
      mode: "frontend",
      server: { host: "127.0.0.1", port: 0 },
    });
    let browser: Browser | undefined;
    try {
      await listenFrontend(vite);
      const address = vite.httpServer?.address();
      if (!address || typeof address === "string") throw new Error("No fixture port");
      const executable =
        process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"] ??
        (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
      browser =
        engine === "webkit"
          ? await webkit.launch()
          : await chromium.launch({
              ...(executable === undefined ? {} : { executablePath: executable }),
              args: ["--no-sandbox"],
            });
      const page = await browser.newPage();
      const origin = `http://127.0.0.1:${address.port}`;
      let orbReads = 0;
      let detailReads = 0;
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route(`**/api/v1/orbs/${ORB}`, async (route) => {
        orbReads++;
        const response = await route.fetch();
        // StrictMode runs the bootstrap load twice; hold only conversation polling.
        if (orbReads > 2) await held;
        const body = await response.json();
        await route.fulfill({ response, json: { ...body, state: "stopped", activity: "idle" } });
      });
      await page.route(`**/api/v1/orbs/${ORB}/messages`, async (route) => {
        const response = await route.fetch();
        await held;
        await route.fulfill({ response });
      });
      await page.route(`**/api/v1/orbs/${ORB}/hosted-files`, async (route) => {
        const response = await route.fetch();
        await held;
        await route.fulfill({ response });
      });
      await page.route(`**/api/v1/orbs/${ORB}/details/**`, async (route) => {
        const response = await route.fetch();
        const body = await response.text();
        if (body.includes("Dashboard preview (960")) detailReads++;
        await route.fulfill({ response, body });
      });
      try {
        await gotoFrontendHistory(page, `${origin}/#/orbs/${ORB}`, ORB);
        const image = page
          .locator("details.tool-image-activity")
          .filter({ hasText: "artifacts/dashboard-preview.svg" });
        await expect(image).toBeVisible();
        await expect.poll(() => detailReads).toBe(1);
        await expect(image.locator("img.tool-image-thumbnail, [role=alert]")).toHaveCount(1);
        await expect(image.getByRole("button", { name: "Retry" })).toHaveCount(0);
        await expect(image.locator("img.tool-image-thumbnail")).toHaveCount(1);
        await expect(image.locator("img.tool-image-thumbnail")).toHaveJSProperty("complete", true);
        await expect(image.locator("img.tool-image-thumbnail")).not.toHaveJSProperty(
          "naturalWidth",
          0,
        );
        expect(detailReads, "initial open drawer fetches detail once").toBe(1);
      } finally {
        release();
        await page.close();
      }
    } finally {
      await browser?.close();
      await vite.close();
      await rm(cacheDir, { recursive: true, force: true });
    }
  },
);
