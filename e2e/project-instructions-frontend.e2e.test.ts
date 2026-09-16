import { join } from "node:path";
import { expect as check, chromium, webkit } from "@playwright/test";
import { createServer } from "vite";
import { it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";

it.each(["chromium", "webkit"] as const)(
  "%s project Instructions tab: explicit acceptance, draft ownership, scope and phone layout",
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
    let releaseRead = () => {},
      releaseWrite = () => {};
    let heldRead = Promise.resolve(),
      heldWrite = Promise.resolve();
    let failRead = true,
      failWrite = true;
    try {
      await page.route("**/api/v1/projects/*/instructions", async (route) => {
        const reading = route.request().method() === "GET";
        await (reading ? heldRead : heldWrite);
        if (reading ? failRead : failWrite)
          return route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({
              error: {
                code: "unavailable",
                message: reading
                  ? "Cannot load project instructions"
                  : "Cannot save project instructions",
                retryable: true,
              },
            }),
          });
        await route.continue();
      });
      await page.goto(`http://127.0.0.1:${address.port}/#/`);
      const gears = page.getByRole("button", { name: /^Configure / });
      await check(gears.first()).toBeVisible();
      const name = await gears.first().getAttribute("aria-label");
      const gear = page.getByRole("button", { name: name ?? "", exact: true });
      const open = async () => {
        await gear.click();
        await page.getByRole("tab", { name: "Instructions", exact: true }).click();
      };
      await open();
      const dialog = page.getByRole("dialog");
      const panel = dialog.getByRole("tabpanel", { name: "Instructions", exact: true });
      const input = panel.getByRole("textbox", {
        name: "Additional project instructions",
        exact: true,
      });
      const save = panel.getByRole("button", { name: "Save", exact: true });
      const close = dialog.getByRole("button", { name: "Close project config" });
      await check(panel.getByRole("alert")).toContainText("Cannot load");
      await check(input).toBeDisabled();
      await check(save).toBeDisabled();
      failRead = false;
      heldRead = new Promise((resolve) => {
        releaseRead = resolve;
      });
      await panel.getByRole("button", { name: "Retry" }).click();
      await check(input).toBeDisabled();
      releaseRead();
      await check(input).toBeEnabled();
      const content = "# Project only\nKeep the repository files untouched.\n";
      await input.fill(content);
      await dialog.getByRole("tab", { name: "General", exact: true }).click();
      await dialog.getByRole("tab", { name: "Instructions", exact: true }).click();
      await check(input).toHaveValue(content);
      await save.click();
      await check(panel.getByRole("alert")).toContainText("Cannot save");
      await input.press("Escape");
      await check(dialog).toHaveCount(0);
      await check(gear).toBeFocused();
      await open();
      await check(input).toHaveValue(content);
      failWrite = false;
      heldWrite = new Promise((resolve) => {
        releaseWrite = resolve;
      });
      await save.click();
      await check(close).toBeDisabled();
      await check(input).toBeDisabled();
      await check(dialog.getByRole("tab", { name: "General", exact: true })).toBeDisabled();
      await page.keyboard.press("Escape");
      await check(dialog).toBeVisible();
      await check(panel).not.toContainText("Saved · next orb start");
      releaseWrite();
      await check(panel).toContainText("Saved · next orb start");
      await check(save).toBeDisabled();
      await page.reload();
      await open();
      await check(input).toHaveValue(content);
      await close.click();
      await gears.nth(1).click();
      await dialog.getByRole("tab", { name: "Instructions", exact: true }).click();
      await check(input).toBeEnabled();
      await check(input).toHaveValue("");
      await close.click();
      await open();
      await input.fill("");
      await save.click();
      await check(panel).toContainText("Saved · next orb start");
      await page.reload();
      await open();
      await check(input).toBeEnabled();
      await check(input).toHaveValue("");
      for (const width of [320, 390, 600]) {
        await page.setViewportSize({ width, height: 844 });
        check(
          await input.evaluate((el) => el.ownerDocument.defaultView?.getComputedStyle(el).fontSize),
        ).toBe("16px");
        check(await page.locator("html").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
          true,
        );
        await input.fill(`draft at ${width}`);
        await page.locator(".project-secrets-backdrop").click({ position: { x: 2, y: 2 } });
        await check(dialog).toBeVisible();
        await close.click();
        await open();
        await check(input).toHaveValue(`draft at ${width}`);
      }
    } finally {
      releaseRead();
      releaseWrite();
      await browser.close();
      await vite.close();
    }
  },
);
