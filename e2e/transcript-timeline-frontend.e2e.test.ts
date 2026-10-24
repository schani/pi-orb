import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium, expect, type Locator, webkit } from "@playwright/test";
import { createServer } from "vite";
import { it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";
import { gotoFrontendHistory } from "./testkit/frontend-fixture.ts";

const ORB = "frontend-timeline";

const top = async (locator: Locator) =>
  locator.evaluate((node) => Math.round(node.getBoundingClientRect().top));

it.each(["chromium", "webkit"] as const)(
  "%s: swaps a Pi turn's activity for its waterfall in place, several at once",
  async (engine) => {
    const root = join(import.meta.dirname, "../apps/web");
    const cacheDir = await mkdtemp(join(tmpdir(), `pi-orb-timeline-${engine}-`));
    const vite = await createServer({
      root,
      configFile: join(root, "vite.config.ts"),
      cacheDir,
      mode: "frontend",
      server: { host: "127.0.0.1", port: 0 },
    });
    let browser: Browser | undefined;
    try {
      await listenFrontend(vite);
      const address = vite.httpServer?.address();
      if (!address || typeof address === "string") throw new Error("No fixture port");
      const executable =
        process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"] ??
        (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
      browser =
        engine === "webkit"
          ? await webkit.launch()
          : await chromium.launch({
              ...(executable === undefined ? {} : { executablePath: executable }),
              args: ["--no-sandbox"],
            });
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(`pageerror ${error.message}`));
      // The fixture fails the retry turn until healed (503) and has no timeline for the missing one (404).
      page.on("response", (response) => {
        const path = new URL(response.url()).pathname;
        if (
          response.status() >= 400 &&
          !path.startsWith(`/api/v1/orbs/${ORB}/headlines/`) &&
          path !== `/api/v1/orbs/${ORB}/turns/timeline-u2/timeline` &&
          path !== `/api/v1/orbs/${ORB}/turns/timeline-u3/timeline`
        )
          errors.push(`${response.status()} ${path}`);
      });

      await gotoFrontendHistory(page, `http://127.0.0.1:${address.port}/orbs/${ORB}`, ORB);
      const bands = page.locator("article.rec-you");
      await expect(bands).toHaveCount(4);
      const first = bands.filter({ hasText: "Chart heatmap render time" });
      const control = (band: Locator) => band.getByRole("button", { name: "Turn timeline" });
      // Steering bands belong to their turn and get no control.
      await expect(page.getByRole("button", { name: "Turn timeline" })).toHaveCount(3);
      await expect(control(bands.filter({ hasText: "Cover the 320px" }))).toHaveCount(0);

      // Desktop: the control shows on hover.
      await page.mouse.move(0, 0);
      await expect(control(first)).toHaveCSS("opacity", "0");
      await first.hover();
      await expect(control(first)).toHaveCSS("opacity", "1");

      const before = await top(first);
      await control(first).click();
      await expect(control(first)).toHaveAttribute("aria-pressed", "true");
      const table = page.locator(".turn-timeline table.timeline-table");
      await expect(table).toHaveCount(1);
      await expect(table.locator("tr.timeline-row")).toHaveCount(13);
      expect(await top(first)).toBe(before);
      // The turn's activity and its steering band are now rows.
      await expect(bands).toHaveCount(3);
      const activity = page.locator("article.rec-orb", { hasText: "Querying render timings." });
      await expect(activity).toHaveCount(0);
      await expect(table.locator("tr.timeline-row", { hasText: "steering" })).toContainText(
        "Cover the 320px viewport too.",
      );
      await expect(table.locator(".timeline-indent")).toHaveCount(4);
      await expect(table.locator(".timeline-tool.timeline-failed")).toHaveCount(1);
      await expect(table.locator(".timeline-compaction")).toHaveCount(1);
      await expect(table.locator(".timeline-aux")).toHaveCount(1);
      await expect(table.locator(".timeline-think")).toHaveCount(2);

      const call = table.locator('tr[data-row="timeline-a1"]');
      await call.locator(".timeline-bar").hover();
      const tip = page.locator(".timeline-tip");
      await expect(tip).toBeVisible();
      await expect(tip).toContainText("first token");
      await expect(tip).toContainText("900ms");
      await expect(tip).toContainText("thinking");
      await expect(tip).toContainText("1.5s");
      await expect(tip).not.toContainText("said");
      await call.click();
      await expect(tip).toBeHidden();
      await expect(call).toHaveClass(/timeline-open/);
      const detail = table.locator("tr.timeline-detail");
      await expect(detail).toHaveCount(1);
      await expect(detail).toContainText("said");
      await expect(detail).toContainText("streaming");

      // Several turns open at once; a failed read retries in place.
      const retry = bands.filter({ hasText: "Retry the phone run." });
      await control(retry).click();
      const failure = page.locator(".timeline-failure[role=alert]");
      await expect(failure).toHaveText("Timeline unavailable. Retry");
      const healed = await page.request.post(
        `http://127.0.0.1:${address.port}/api/v1/orbs/${ORB}/fixture-timeline-heal`,
      );
      expect(healed.ok()).toBe(true);
      await failure.getByRole("button", { name: "Retry" }).click();
      await expect(page.locator(".turn-timeline table.timeline-table")).toHaveCount(2);
      await expect(page.locator(".timeline-llm.timeline-failed")).toHaveCount(1);
      await expect(page.locator('tr[data-row="timeline-a5"]')).toContainText(
        "503 upstream connect error",
      );

      const missing = bands.filter({ hasText: "One more." });
      await control(missing).click();
      await expect(page.locator(".timeline-failure")).toHaveText("This turn doesn’t exist.");

      await control(first).click();
      await expect(control(first)).toHaveAttribute("aria-pressed", "false");
      await expect(bands).toHaveCount(4);
      await expect(activity).toHaveCount(1);
      expect(await top(first)).toBe(before);

      // Phones have no hover: the control is always there at a touch size.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.mouse.move(0, 0);
      await expect(control(first)).toHaveCSS("opacity", "1");
      const size = await control(first).boundingBox();
      expect([size?.width, size?.height]).toEqual([44, 44]);
      expect(errors).toEqual([]);
    } finally {
      await browser?.close();
      await vite.close();
      await rm(cacheDir, { recursive: true, force: true });
    }
  },
);
