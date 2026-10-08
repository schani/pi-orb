import { join } from "node:path";
import { expect as check, chromium, webkit } from "@playwright/test";
import { createServer } from "vite";
import { it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";

it.each(["chromium", "webkit"] as const)(
  "%s: rejected legacy Start displays its terminal reason without leaving the transcript",
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
    const page = await browser.newPage();
    const orbId = "frontend-long-history";
    const message = "This orb uses the old Pi backend. Create a new orb to continue.";
    let starts = 0;
    try {
      await page.route(`**/api/v1/orbs/${orbId}`, async (route) => {
        const response = await route.fetch();
        return route.fulfill({ response, json: { ...(await response.json()), state: "stopped" } });
      });
      await page.route(`**/api/v1/orbs/${orbId}/start`, (route) => {
        starts++;
        return route.fulfill({
          status: 409,
          contentType: "application/json",
          json: { error: { code: "conflict", message, retryable: false } },
        });
      });
      const url = `http://127.0.0.1:${address.port}/orbs/${orbId}`;
      await page.goto(url);
      await check(page.locator(".history")).toBeVisible();
      for (let attempt = 0; attempt < 2; attempt++) {
        await page.getByRole("button", { name: "Start orb", exact: true }).click();
        await check(page.getByText(message, { exact: false })).toBeVisible();
        await check(page).toHaveURL(url);
        await check(page.locator(".history")).toBeVisible();
        await check(page.locator(".orb-life")).toContainText("stopped");
      }
      check(starts).toBe(2);
    } finally {
      await page.close();
      await browser.close();
      await vite.close();
    }
  },
);
