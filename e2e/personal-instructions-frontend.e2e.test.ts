import { expect as check } from "@playwright/test";
import { it } from "vitest";
import { gotoFrontendFixture } from "./testkit/frontend-fixture.ts";
import { createFrontendFixture } from "./testkit/frontend-owned.ts";

it.each(["chromium", "webkit"] as const)(
  "%s personal editor: explicit save, load/failure gates, retained drafts, scope and phone geometry",
  async (engine) => {
    const fixture = await createFrontendFixture(engine, {
      page: { viewport: { width: 1280, height: 900 } },
    });
    const { page, origin } = fixture;
    const path = "**/api/v1/personal-instructions";
    const url = `${origin}/`;
    {
      let failRead = true,
        failWrite = true;
      let releaseRead: (() => void) | undefined;
      fixture.cleanup(async () => {
        releaseRead?.();
      });
      let releaseWrite: (() => void) | undefined;
      fixture.cleanup(async () => {
        releaseWrite?.();
      });
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
      const gear = page.getByRole("button", { name: "Settings", exact: true });
      await check(
        page.locator(".dashboard-totals").getByRole("button", { name: "Settings" }),
      ).toBeVisible();
      await gear.click();
      const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
      const input = dialog.getByRole("textbox", { name: "Personal AGENTS.md", exact: true });
      const save = dialog.getByRole("button", { name: "Save", exact: true });
      const close = dialog.getByRole("button", { name: "Close settings" });
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
      await dialog.getByRole("tab", { name: "Claude", exact: true }).click();
      await check(dialog.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
      await dialog.getByRole("tab", { name: "Instructions", exact: true }).click();
      await check(input).toHaveValue("# Personal\nAll projects.\n");
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
      await check(dialog.getByRole("tab", { name: "Claude", exact: true })).toBeDisabled();
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
    }
  },
);
