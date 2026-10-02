import { join } from "node:path";
import { type Browser, chromium, expect as expectPage } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, it } from "vitest";
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

for (const width of [1280, 390, 320]) {
  it(`balances real HistoryView receipt spacing and keeps adjacent rails joined at ${width}px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    try {
      await gotoFrontendHistory(
        page,
        `${origin}/orbs/frontend-fixture-orb`,
        "frontend-fixture-orb",
      );
      const rows = page.locator(".subagent-notice");
      await expectPage(rows).toHaveCount(3);
      await expectPage(page.locator("body")).not.toContainText("private-child-");
      const measure = async () =>
        page.evaluate(`(() => {
        const first = document.querySelector(".subagent-notice");
        const prose = [first?.previousElementSibling, first?.nextElementSibling];
        const rows = [...document.querySelectorAll(".subagent-notice")];
        const body = document.querySelector(".subagent-notice-body");
        const gap = (a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().bottom;
        return {
          above: gap(prose[0], rows[0]),
          below: gap(rows[0], prose[1]),
          adjacent: gap(rows[1], rows[2]),
          rail: getComputedStyle(rows[1], "::before").bottom,
          bodyLeft: body === null ? null : body.getBoundingClientRect().left + parseFloat(getComputedStyle(body).paddingLeft),
          railLeft: rows[0].getBoundingClientRect().left + parseFloat(getComputedStyle(rows[0], "::before").left),
          overflow: document.documentElement.scrollWidth - innerWidth,
        };
      })()`) as Promise<{
          above: number;
          below: number;
          adjacent: number;
          rail: string;
          bodyLeft: number;
          railLeft: number;
          overflow: number;
        }>;
      const collapsed = await measure();
      expectPage(collapsed.above).toBeCloseTo(collapsed.below, 1);
      expectPage(collapsed.adjacent).toBe(4);
      expectPage(collapsed.rail).toBe("-4px");
      expectPage(collapsed.overflow).toBeLessThanOrEqual(0);
      await rows.first().locator("summary").click();
      await rows.nth(1).locator("summary").click();
      await expectPage(rows.first().locator(".subagent-notice-body")).toBeVisible();
      await expectPage(rows.nth(1).locator(".subagent-notice-body")).toBeVisible();
      const expanded = await measure();
      expectPage(expanded.above).toBeCloseTo(expanded.below, 1);
      expectPage(expanded.adjacent).toBe(4);
      expectPage(expanded.bodyLeft).not.toBeNull();
      expectPage(expanded.bodyLeft ?? -Infinity).toBeGreaterThan(expanded.railLeft);
      await expectPage(rows.first().locator(".subagent-duration")).toHaveText("1.3s");
      await expectPage(rows.nth(1).locator(".subagent-duration")).toHaveCount(0);
      await expectPage(page.locator("body")).not.toContainText("private-child-");
    } finally {
      await page.close();
    }
  });
}
