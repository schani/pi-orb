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
    const alertRequests: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (/\/(details|headlines)\/child-message-alert\//.test(path)) alertRequests.push(path);
    });
    try {
      await gotoFrontendHistory(
        page,
        `${origin}/orbs/frontend-fixture-orb`,
        "frontend-fixture-orb",
      );
      const rows = page.locator(".subagent-notice:not(.subagent-message-notice)");
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

      const alert = page.locator(".subagent-message-notice");
      const summary = alert.locator("summary");
      const preview = alert.locator(".activity-rail-headline");
      const body = alert.locator(".subagent-notice-body");
      await expectPage(alert).toHaveCount(1);
      await alert.scrollIntoViewIfNeeded();
      await expectPage(alert.locator(".activity-rail-label")).toHaveText("notification");
      await expectPage(preview).toContainText("Receipt <script>");
      await expectPage(preview).toHaveAttribute("title", /\*\*literal\*\*/);
      await expectPage(alert.locator(".activity-rail-metric > span")).toHaveAttribute(
        "title",
        /Inspect notification layout .* · worker-7/,
      );
      await expectPage(body).toHaveCount(0);
      expectPage(alertRequests).toEqual([]);
      const geometry = await summary.evaluate((element) => {
        const view = element.ownerDocument.defaultView;
        if (view === null) throw new Error("missing message window");
        const preview = element.querySelector(".activity-rail-headline");
        const source = element.querySelector(".activity-rail-metric");
        const text = element.querySelector(".activity-rail-summary");
        if (preview === null || source === null || text === null)
          throw new Error("missing message columns");
        return {
          lineHeight: Number.parseFloat(view.getComputedStyle(element).lineHeight),
          previewHeight: preview.getBoundingClientRect().height,
          sourceWidth: source.getBoundingClientRect().width,
          rowWidth: element.getBoundingClientRect().width,
          sourceRight: source.getBoundingClientRect().right,
          previewRight: text.getBoundingClientRect().right,
          clipped: source.scrollWidth > source.clientWidth && text.scrollWidth > text.clientWidth,
          whiteSpace: view.getComputedStyle(text).whiteSpace,
          overflow: element.ownerDocument.documentElement.scrollWidth - view.innerWidth,
        };
      });
      expectPage(geometry.whiteSpace).toBe("nowrap");
      expectPage(geometry.previewHeight).toBeLessThanOrEqual(geometry.lineHeight);
      expectPage(geometry.sourceWidth).toBeLessThan(geometry.rowWidth / 3);
      expectPage(geometry.sourceRight).toBeGreaterThan(geometry.previewRight);
      expectPage(geometry.clipped).toBe(true);
      expectPage(geometry.overflow).toBeLessThanOrEqual(0);
      const expectFocusedNotice = async () => {
        const focused = await summary.evaluate((element) => {
          const view = element.ownerDocument.defaultView;
          const source = element.querySelector(".activity-rail-metric");
          const text = element.querySelector(".activity-rail-summary");
          if (view === null || source === null || text === null)
            throw new Error("missing focused message columns");
          const style = view.getComputedStyle(element);
          return {
            focusVisible: element.matches(":focus-visible"),
            background: style.backgroundColor,
            color: style.color,
            sourceColor: view.getComputedStyle(source).color,
            outline: style.outlineStyle,
            outlineWidth: style.outlineWidth,
            outlineColor: style.outlineColor,
            sourceWidth: source.getBoundingClientRect().width,
            sourceLeft: source.getBoundingClientRect().left,
            textRight: text.getBoundingClientRect().right,
          };
        });
        expectPage(focused).toMatchObject({
          focusVisible: true,
          background: "rgb(255, 255, 255)",
          color: "rgb(0, 0, 0)",
          sourceColor: "rgb(85, 85, 85)",
          outline: "solid",
          outlineWidth: "1px",
          outlineColor: "rgb(85, 85, 85)",
        });
        expectPage(focused.sourceWidth).toBeGreaterThan(0);
        expectPage(focused.sourceLeft).toBeGreaterThanOrEqual(focused.textRight);
      };
      await page.keyboard.press("Tab");
      await summary.focus();
      await expectFocusedNotice();
      await summary.press("Enter");
      await expectPage(preview).toHaveCount(0);
      await expectFocusedNotice();
      await expectPage(body).toHaveText(
        `Receipt <script>globalThis.__inlineAlertExecuted=true</script> **literal**\n\n${"long-token-".repeat(90)} End of actual message.`,
      );
      await expectPage(body.locator("script, strong, p")).toHaveCount(0);
      await expectPage(body).not.toContainText("worker-7");
      expectPage(alertRequests).toHaveLength(1);
      expectPage(alertRequests[0]).toContain("/details/");
      expectPage(await page.evaluate("globalThis.__inlineAlertExecuted")).toBeUndefined();
      expectPage(
        await page.evaluate("document.documentElement.scrollWidth - innerWidth"),
      ).toBeLessThanOrEqual(0);
      await summary.press("Space");
      await expectPage(body).toHaveCount(0);
      await expectPage(preview).toBeVisible();
      await summary.press("Enter");
      await expectPage(body).toBeVisible();
      expectPage(alertRequests).toHaveLength(1);
    } finally {
      await page.close();
    }
  });
}
