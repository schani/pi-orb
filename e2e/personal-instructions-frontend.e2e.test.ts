import { join } from "node:path";
import { expect as check, chromium, webkit } from "@playwright/test";
import { createServer } from "vite";
import { it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";
import { gotoFrontendFixture } from "./testkit/frontend-fixture.ts";

it.each(["chromium", "webkit"] as const)(
  "%s personal editor: explicit save, load/failure gates, retained drafts, scope and phone geometry",
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
    if (!address || typeof address === "string") throw new Error("No owned fixture port");
    const browser = await (engine === "chromium" ? chromium : webkit).launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const path = "**/api/v1/personal-instructions";
    const url = `http://127.0.0.1:${address.port}/#/`;
    try {
      let failRead = true,
        failWrite = true;
      let releaseRead: (() => void) | undefined;
      let releaseWrite: (() => void) | undefined;
      let heldRead: Promise<void> = Promise.resolve();
      let heldWrite: Promise<void> = Promise.resolve();
      await page.route(path, async (route) => {
        if (route.request().method() === "GET") {
          await heldRead;
          if (failRead)
            return route.fulfill({
              status: 503,
              contentType: "application/json",
              body: JSON.stringify({
                error: {
                  code: "unavailable",
                  message: "Cannot load personal instructions",
                  retryable: true,
                },
              }),
            });
        } else {
          await heldWrite;
          if (failWrite)
            return route.fulfill({
              status: 503,
              contentType: "application/json",
              body: JSON.stringify({
                error: {
                  code: "unavailable",
                  message: "Cannot save personal instructions",
                  retryable: true,
                },
              }),
            });
        }
        await route.continue();
      });
      await gotoFrontendFixture(page, url);
      const gear = page.getByRole("button", { name: "Personal instructions", exact: true });
      await check(
        page.locator(".dashboard-totals").getByRole("button", { name: "Personal instructions" }),
      ).toBeVisible();
      await gear.click();
      const dialog = page.getByRole("dialog", { name: "~/AGENTS.md", exact: true });
      const input = dialog.getByRole("textbox", { name: "Personal AGENTS.md", exact: true });
      const save = dialog.getByRole("button", { name: "Save", exact: true });
      const close = dialog.getByRole("button", { name: "Close personal instructions" });
      await check(dialog.getByRole("alert")).toContainText("Cannot load");
      await check(save).toBeDisabled();
      failRead = false;
      heldRead = new Promise((resolve) => {
        releaseRead = resolve;
      });
      await dialog.getByRole("button", { name: "Retry", exact: true }).click();
      await check(input).toBeDisabled();
      releaseRead?.();
      await check(input).toBeEnabled();
      await input.fill("# Personal\nAll projects.\n");
      await save.click();
      await check(dialog.getByRole("alert")).toContainText("Cannot save");
      await check(input).toHaveValue("# Personal\nAll projects.\n");
      await input.press("Escape");
      await check(dialog).toHaveCount(0);
      await check(gear).toBeFocused();
      await gear.click();
      await check(input).toHaveValue("# Personal\nAll projects.\n");
      failWrite = false;
      heldWrite = new Promise((resolve) => {
        releaseWrite = resolve;
      });
      await save.click();
      await check(close).toBeDisabled();
      await check(input).toBeDisabled();
      await page.keyboard.press("Escape");
      await check(dialog).toBeVisible();
      await check(dialog).not.toContainText("Saved · next orb start");
      releaseWrite?.();
      await check(dialog).toContainText("Saved · next orb start");
      await check(save).toBeDisabled();
      await page.reload();
      await gear.click();
      await check(input).toHaveValue("# Personal\nAll projects.\n");
      await input.fill("");
      await save.click();
      await check(dialog).toContainText("Saved · next orb start");
      await page.reload();
      await gear.click();
      await check(input).toBeEnabled();
      await check(input).toHaveValue("");
      await check(save).toBeDisabled();
      for (const width of [320, 390, 600]) {
        await page.setViewportSize({ width, height: 844 });
        check(
          await input.evaluate(
            (element) => element.ownerDocument.defaultView?.getComputedStyle(element).fontSize,
          ),
        ).toBe("16px");
        check(
          await page
            .locator("html")
            .evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
        await input.fill(`draft at ${width}`);
        await page.locator(".personal-instructions-backdrop").click({ position: { x: 2, y: 2 } });
        await check(dialog).toBeVisible();
        await close.click();
        await gear.click();
        await check(input).toHaveValue(`draft at ${width}`);
      }
    } finally {
      await browser.close();
      await vite.close();
    }
  },
);
