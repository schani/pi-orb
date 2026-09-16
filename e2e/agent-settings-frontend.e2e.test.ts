import { join } from "node:path";
import { expect as check, chromium, webkit } from "@playwright/test";
import { createServer } from "vite";
import { it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";

it.each(["chromium", "webkit"] as const)(
  "%s: lifecycle cluster and slash settings preserve drafts and synchronize tabs",
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
    const url = `http://127.0.0.1:${address.port}/#/orbs/frontend-fixture-orb`;
    try {
      await page.goto(url);
      const thinking = page.getByRole("button", { name: "Change thinking", exact: true });
      await check(thinking).toBeEnabled();
      const modelButton = page.getByRole("button", { name: "Change model", exact: true });
      await modelButton.click();
      const modelOptions = page.getByRole("option");
      await check(modelOptions).toHaveCount(4);
      for (const name of ["Astra", "Sol", "Terra", "Luna"])
        await check(page.getByRole("option", { name, exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      const input = page.getByRole("textbox", { name: "Message the orb", exact: true });
      await input.fill("keep this draft");
      await thinking.click();
      await check(input).toHaveValue("thinking ");
      await check(page.locator(".composer-line .composer-prefix")).toHaveText("/");
      await check(page.locator(".command-picker")).not.toContainText("←");
      await input.click();
      await check(page.locator(".command-picker")).toBeVisible();
      await input.press("Escape");
      await check(page.locator(".command-picker")).toHaveCount(0);
      await check(input).toHaveValue("keep this draft");
      await thinking.click();
      await page.locator(".orb-name").click();
      await check(page.locator(".command-picker")).toHaveCount(0);
      await check(input).toHaveValue("keep this draft");
      await thinking.click();
      await page.getByRole("option", { name: "low", exact: true }).focus();
      await page.keyboard.press("Escape");
      await check(page.locator(".command-picker")).toHaveCount(0);
      await check(input).toHaveValue("keep this draft");
      await thinking.click();
      await page.getByRole("option", { name: "low", exact: true }).click();
      await check(thinking).toHaveText("low");
      await check(input).toHaveValue("keep this draft");
      const second = await browser.newPage();
      await second.goto(url);
      await check(second.getByRole("button", { name: "Change thinking", exact: true })).toHaveText(
        "low",
      );
      await input.fill("");
      await input.press("/");
      await check(input).toHaveValue("");
      await input.press("Tab");
      await check(input).toHaveValue("model ");
      await input.press("Escape");
      await check(page.locator(".command-picker")).toHaveCount(0);
      await input.press("/");
      await input.pressSequentially("unknown");
      await input.press("Enter");
      await check(input).toHaveValue("unknown");
      await input.fill("model sol");
      await input.press("Enter");
      await check(page.getByRole("button", { name: "Change model", exact: true })).toHaveText(
        "Sol",
      );
      await check(second.getByRole("button", { name: "Change model", exact: true })).toHaveText(
        "Sol",
      );
      const bounds = await page.locator(".orb-header").evaluate((element) => ({
        height: element.getBoundingClientRect().height,
        overflow: element.scrollWidth > element.clientWidth,
      }));
      check(bounds).toEqual({ height: 24, overflow: false });
      const status = await page.locator(".orb-life").boundingBox();
      const stop = await page.getByRole("button", { name: "Stop orb", exact: true }).boundingBox();
      const model = await page
        .getByRole("button", { name: "Change model", exact: true })
        .boundingBox();
      check(status && stop && model && status.x < stop.x && stop.x < model.x).toBeTruthy();
      await page.reload();
      await check(page.getByRole("button", { name: "Change model", exact: true })).toHaveText(
        "Sol",
      );
      for (const width of [601, 768, 1024]) {
        await page.setViewportSize({ width, height: 900 });
        check(
          await page
            .locator(".orb-header")
            .evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
      }
      await page.setViewportSize({ width: 390, height: 844 });
      const rename = page.getByRole("button", { name: "Rename orb", exact: true });
      check((await rename.boundingBox())?.width).toBe(44);
      await page.getByRole("button", { name: "Write message", exact: true }).click();
      await input.fill("/thinking ");
      await page.getByRole("option", { name: "high", exact: true }).click();
      await check(input).toHaveValue("");
      await second.close();
    } finally {
      await browser.close();
      await vite.close();
    }
  },
);
