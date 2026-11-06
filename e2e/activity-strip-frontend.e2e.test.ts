import { join } from "node:path";
import { type Browser, chromium, expect as expectPage } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";
import { gotoFrontendHistory } from "./testkit/frontend-fixture.ts";

const root = join(import.meta.dirname, "../apps/web");
let vite: ViteDevServer;
let browser: Browser;
let origin: string;

beforeAll(async () => {
  vite = await createServer({
    root,
    configFile: join(root, "vite.config.ts"),
    mode: "frontend",
  });
  await listenFrontend(vite);
  const address = vite.httpServer?.address();
  if (address === null || address === undefined || typeof address === "string") {
    throw new Error("frontend fixture did not own a TCP port");
  }
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await vite?.close();
});

it("folds interleaved activity into dots that preview, open and overflow", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await gotoFrontendHistory(page, `${origin}/orbs/frontend-activity`, "frontend-activity");
    const strips = page.locator(".activity-strip");
    await expectPage(strips).toHaveCount(2);
    const first = strips.first();
    const dots = first.locator(".activity-strip-dot");
    await expectPage(dots).toHaveCount(35);
    await expectPage(first.locator(".activity-rail-metric")).toHaveText("35");
    await expectPage(page.locator(".rec-orb .reasoning")).toHaveCount(0);

    const failed = first.locator('[data-step="failed"]');
    await expectPage(failed).toHaveCount(1);
    const box = await failed.boundingBox();
    expect(box?.width).toBe(12);
    expect(box?.height).toBe(20);

    await failed.hover();
    await expectPage(page.getByRole("tooltip")).toContainText("codemode · text(await tools.bash");
    await failed.click();
    const body = first.locator(":scope > .activity-strip-body");
    const picked = body.locator(":scope > .activity-rail-row-failed");
    await expectPage(first).toHaveAttribute("open", "");
    await expectPage(body.locator(":scope > .activity-rail-row")).toHaveCount(1);
    await expectPage(picked).toHaveAttribute("open", "");
    await expectPage(picked.locator(".tool-call-output-error")).toBeVisible();
    await failed.click();
    await expectPage(picked).toHaveCount(0);
    await expectPage(first).not.toHaveAttribute("open", "");

    await first.locator(":scope > summary .activity-rail-label").click();
    await expectPage(first).toHaveAttribute("open", "");
    await expectPage(page.locator(".rec-orb .reasoning")).toHaveCount(20);

    const overflow = strips.nth(1);
    await expectPage(overflow.locator(".activity-rail-metric")).toHaveText("300");
    const more = Number((await overflow.locator(".activity-strip-more").textContent())?.slice(1));
    const shown = await overflow.locator(".activity-strip-dot").count();
    expect(more + shown).toBe(300);
    expect(more).toBeGreaterThan(0);
  } finally {
    await page.close();
  }
});
