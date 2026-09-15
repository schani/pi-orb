import { join } from "node:path";
import { expect as check, chromium, webkit } from "@playwright/test";
import { createServer } from "vite";
import { it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";

it.each(["chromium", "webkit"] as const)(
  "%s: stopped cache paints before refresh, retries errors, and obeys 404",
  async (engine) => {
    const root = join(import.meta.dirname, "../apps/web");
    const vite = await createServer({
      root,
      configFile: join(root, "vite.config.ts"),
      mode: "frontend",
      server: { host: "127.0.0.1", port: 0 },
    });
    await listenFrontend(vite);
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("No fixture port");
    const browser = await (engine === "chromium" ? chromium : webkit).launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const origin = `http://127.0.0.1:${address.port}`;
    const a = "frontend-long-history",
      b = "frontend-fixture-orb";
    let refresh = false,
      missing = false,
      fail = true;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await page.route(`**/api/v1/orbs/${a}`, async (route) => {
        if (missing)
          return route.fulfill({
            status: 404,
            json: { error: { code: "not_found", message: "Orb doesn't exist", retryable: false } },
          });
        const response = await route.fetch();
        const orb = await response.json();
        orb.state = "stopped";
        return route.fulfill({ response, json: orb });
      });
      await page.route(`**/orbs/${a}/history`, async (route) => {
        const response = await route.fetch();
        if (!refresh) return route.fulfill({ response });
        await gate;
        if (fail)
          return route.fulfill({
            status: 503,
            json: {
              error: { code: "unavailable", message: "held refresh failure", retryable: true },
            },
          });
        const view = await response.json();
        view.records.push({
          id: "cache-new-tail",
          parentId: view.cursor,
          timestamp: "now",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "REFRESH_NEW_TAIL" }],
          overflow: {},
        });
        view.cursor = "cache-new-tail";
        view.headId = view.cursor;
        return route.fulfill({ response, json: view });
      });
      await page.goto(`${origin}/#/orbs/${a}`);
      await check(page.locator(".history")).toContainText("Review 100");
      await page.locator(`.orb-index a[href="#/orbs/${b}"]`).click();
      await check(page.locator(".orb-name")).toHaveText("Frontend Playground");
      refresh = true;
      await page.locator(`.orb-index a[href="#/orbs/${a}"]`).click();
      await check(page.locator(".history")).toContainText("Review 100");
      await check(page.locator(".orb-main")).toHaveAttribute("aria-busy", "false");
      release();
      await check(page.getByText(/held refresh failure/)).toBeVisible();
      await check(page.locator(".history")).toContainText("Review 100");
      fail = false;
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await check(page.locator(".history")).toContainText("REFRESH_NEW_TAIL");
      await check(page.getByText(/held refresh failure/)).toHaveCount(0);
      missing = true;
      await check(page.getByText("Orb doesn't exist", { exact: true })).toBeVisible();
      check(page.url()).toBe(`${origin}/#/orbs/${a}`);
      await check(page.locator(".history")).toHaveCount(0);
      await check(page.getByRole("link", { name: "Back to dashboard", exact: true })).toBeVisible();
    } finally {
      release();
      await page.close();
      await browser.close();
      await vite.close();
    }
  },
);
