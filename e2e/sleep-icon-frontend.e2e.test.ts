import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, expect, webkit } from "@playwright/test";
import { createServer } from "vite";
import { it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";
import { gotoFrontendFixture } from "./testkit/frontend-fixture.ts";

it.each(["chromium", "webkit"] as const)(
  "%s: shows and cancels sleeping across dashboard, index, header, favicon, and Find",
  async (engine) => {
    const root = join(import.meta.dirname, "../apps/web");
    const vite = await createServer({
      root,
      configFile: join(root, "vite.config.ts"),
      mode: "frontend",
      server: { host: "127.0.0.1", port: 0 },
    });
    try {
      await listenFrontend(vite);
      const address = vite.httpServer?.address();
      if (!address || typeof address === "string") throw new Error("No owned fixture port");
      const executable = existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined;
      const browser =
        engine === "chromium"
          ? await chromium.launch({
              ...(executable === undefined ? {} : { executablePath: executable }),
              args: ["--no-sandbox"],
            })
          : await webkit.launch();
      try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        try {
          const id = "frontend-fixture-orb";
          const sleepUntil = "2026-09-18T00:00:00.000Z";
          let sleeping = true;
          const sleepView = (orb: Record<string, unknown>) => ({
            ...orb,
            state: "stopped",
            stateVersion: sleeping ? 2 : 3,
            sleepUntil: sleeping ? sleepUntil : undefined,
          });
          await page.route(`**/api/v1/orbs/${id}/stop`, async (route) => {
            sleeping = false;
            const response = await page.request.get(
              `http://127.0.0.1:${address.port}/api/v1/orbs/${id}`,
            );
            await route.fulfill({ json: sleepView(await response.json()) });
          });
          await page.route(`**/api/v1/orbs/${id}`, async (route) => {
            const response = await route.fetch();
            await route.fulfill({ response, json: sleepView(await response.json()) });
          });
          await page.route("**/api/v1/projects/*/orbs", async (route) => {
            const response = await route.fetch();
            const body = await response.json();
            body.items = body.items.map((orb: Record<string, unknown>) =>
              orb.id === id ? sleepView(orb) : orb,
            );
            await route.fulfill({ response, json: body });
          });

          const sleepingImage = 'img[src="/favicons/sleeping.svg"]';
          await gotoFrontendFixture(page, `http://127.0.0.1:${address.port}/#/`);
          const dashboardEntry = page.locator(".orb-entry", { hasText: "Frontend Playground" });
          await expect(dashboardEntry.locator(sleepingImage)).toHaveAttribute(
            "title",
            "Orb sleeping",
          );

          await dashboardEntry
            .getByRole("link", { name: "Frontend Playground", exact: true })
            .click();
          const currentRow = page.locator(`.ix-row[href="#/orbs/${id}"]`);
          await expect(currentRow).toHaveClass(/ix-row-sleep/);
          await expect(currentRow.locator(sleepingImage)).toHaveAttribute("title", "Orb sleeping");
          await expect(currentRow).toHaveCSS("background-color", "rgb(0, 0, 0)");
          await expect(page.locator(".orb-life").locator(sleepingImage)).toHaveCount(1);
          await expect(page.locator("#pi-orb-favicon")).toHaveAttribute(
            "href",
            "/favicons/sleeping.svg",
          );

          await page.keyboard.press("Meta+k");
          const find = page.getByRole("dialog");
          await find.getByRole("searchbox").fill("Frontend Playground");
          await expect(find.locator(sleepingImage)).toHaveAttribute("title", "Orb sleeping");
          await page.screenshot({
            path: `.context/sleep-icon/${engine}-sleeping.png`,
            fullPage: true,
          });
          await page.keyboard.press("Escape");

          await page.getByRole("button", { name: "Stop orb", exact: true }).click();
          await expect(page.locator(".orb-life img")).toHaveAttribute(
            "src",
            "/favicons/stopped.svg",
          );
          await expect(currentRow).toHaveClass(/ix-row-stop/);
          await expect(currentRow).not.toHaveClass(/ix-row-sleep/);
          await expect(page.locator("#pi-orb-favicon")).toHaveAttribute(
            "href",
            "/favicons/stopped.svg",
          );
          await page.keyboard.press("Meta+k");
          await find.getByRole("searchbox").fill("Frontend Playground");
          await expect(find.locator('img[src="/favicons/stopped.svg"]')).toHaveCount(1);
          await expect(find.locator(sleepingImage)).toHaveCount(0);
          await page.screenshot({
            path: `.context/sleep-icon/${engine}-cancelled.png`,
            fullPage: true,
          });
        } finally {
          try {
            await page.unrouteAll({ behavior: "wait" });
          } finally {
            await page.close();
          }
        }
      } finally {
        await browser.close();
      }
    } finally {
      await vite.close();
    }
  },
);
