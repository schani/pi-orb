import { expect as check } from "@playwright/test";
import { it } from "vitest";
import { gotoFrontendFixture } from "./testkit/frontend-fixture.ts";
import { createFrontendFixture } from "./testkit/frontend-owned.ts";

it.each(["chromium", "webkit"] as const)(
  "%s git identity: tab order, load gate, validation, explicit save, retained draft and phone geometry",
  async (engine) => {
    const fixture = await createFrontendFixture(engine, {
      page: { viewport: { width: 1280, height: 900 } },
    });
    const { page, origin } = fixture;
    const url = `${origin}/`;
    const failure = (message: string) => ({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "unavailable", message, retryable: true } }),
    });
    {
      let failRead = true,
        failWrite = true;
      let releaseWrite: (() => void) | undefined;
      fixture.cleanup(async () => {
        releaseWrite?.();
      });
      let heldWrite: Promise<void> = Promise.resolve();
      await page.route("**/api/v1/git-identity", async (route) => {
        if (route.request().method() === "GET") {
          if (failRead) return route.fulfill(failure("Cannot load git identity"));
        } else {
          await heldWrite;
          if (failWrite) return route.fulfill(failure("Cannot save git identity"));
        }
        await route.continue();
      });
      await gotoFrontendFixture(page, url);
      const gear = page.getByRole("button", { name: "Settings", exact: true });
      await gear.click();
      const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
      await check(dialog.getByRole("tab")).toHaveText([
        "Instructions",
        "Skills",
        "Secrets",
        "Git",
        "Claude",
      ]);
      await dialog.getByRole("tab", { name: "Git", exact: true }).click();
      const name = dialog.getByRole("textbox", { name: "user.name", exact: true });
      const email = dialog.getByRole("textbox", { name: "user.email", exact: true });
      const panel = dialog.getByRole("tabpanel", { name: "Git" });
      const save = panel.getByRole("button", { name: "Save", exact: true });
      const close = dialog.getByRole("button", { name: "Close settings" });
      await check(panel.getByRole("alert")).toContainText("Cannot load git identity");
      await check(name).toBeDisabled();
      await check(save).toBeDisabled();
      failRead = false;
      await panel.getByRole("button", { name: "Retry", exact: true }).click();
      await check(name).toBeEnabled();
      await check(name).toHaveValue("");
      await check(save).toBeDisabled();

      await name.fill("Ada Lovelace");
      await check(save).toBeDisabled();
      await check(panel.getByRole("alert")).toBeVisible();
      await email.fill("ada@example");
      await check(save).toBeDisabled();
      await check(panel.getByRole("alert")).toHaveText("user.email must be an email address");
      await email.fill("ada@example.com");
      await check(save).toBeEnabled();
      await check(panel.getByRole("status")).toHaveText("Unsaved");
      await name.fill("Ada <Lovelace>");
      await check(save).toBeDisabled();
      await name.fill("Ada Lovelace");

      await save.click();
      await check(panel.getByRole("alert")).toContainText("Cannot save git identity");
      await check(name).toHaveValue("Ada Lovelace");
      await dialog.getByRole("tab", { name: "Claude", exact: true }).click();
      await dialog.getByRole("tab", { name: "Git", exact: true }).click();
      await check(email).toHaveValue("ada@example.com");
      await close.click();
      await gear.click();
      await dialog.getByRole("tab", { name: "Git", exact: true }).click();
      await check(name).toHaveValue("Ada Lovelace");

      failWrite = false;
      heldWrite = new Promise((resolve) => {
        releaseWrite = resolve;
      });
      await save.click();
      await check(close).toBeDisabled();
      await check(name).toBeDisabled();
      await check(dialog.getByRole("tab", { name: "Instructions", exact: true })).toBeDisabled();
      await check(panel.getByRole("status")).toHaveText("Saving…");
      await page.keyboard.press("Escape");
      await check(dialog).toBeVisible();
      releaseWrite?.();
      await check(panel.getByRole("status")).toHaveText("Saved · next orb start");
      await check(save).toBeDisabled();

      await page.reload();
      await gear.click();
      await dialog.getByRole("tab", { name: "Git", exact: true }).click();
      await check(name).toHaveValue("Ada Lovelace");
      await check(email).toHaveValue("ada@example.com");
      await name.fill("");
      await email.fill("");
      await save.click();
      await check(panel.getByRole("status")).toHaveText("Saved · next orb start");

      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 844 });
        for (const field of [name, email])
          check(
            await field.evaluate(
              (element) => element.ownerDocument.defaultView?.getComputedStyle(element).fontSize,
            ),
          ).toBe("16px");
        check((await save.boundingBox())?.height).toBeGreaterThanOrEqual(48);
        check(
          await page
            .locator("html")
            .evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
      }
    }
  },
);
