import { expect, type Locator, type Page } from "@playwright/test";
import { it } from "vitest";
import { gotoFrontendHistory } from "./testkit/frontend-fixture.ts";
import { createFrontendFixture } from "./testkit/frontend-owned.ts";

const ORB = "frontend-charts";

const row = (page: Page, title: string) =>
  page.locator("details.chart-strip").filter({ hasText: title });

/** WebKit's boundingBox() puts SVG text one font size below its glyphs; the DOM rect does not. */
async function hover(page: Page, target: Locator, xFraction: number, yFraction: number) {
  const box = await target.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  await page.mouse.move(box.x + box.width * xFraction, box.y + box.height * yFraction);
}

async function dimmedLines(chart: Locator): Promise<number> {
  return chart.evaluate(
    (node) =>
      [...node.querySelectorAll("g.mark-line path")].filter(
        (path) => Number(path.getAttribute("opacity") ?? "1") < 0.5,
      ).length,
  );
}

it.each(["chromium", "webkit"] as const)(
  "%s: renders code-mode charts as open rail rows with sorted tooltips and series isolation",
  async (engine) => {
    const { page, origin } = await createFrontendFixture(engine, {
      page: { viewport: { width: 1280, height: 900 } },
    });
    {
      const renders: unknown[] = [];
      const errors: string[] = [];
      // Chart failures surface as uncaught exceptions or Vega logger output (`WARN …`); failed
      // responses are tracked by path. Engine notices about unrelated app features are ignored.
      page.on("pageerror", (error) => errors.push(`pageerror ${error.message}`));
      page.on("console", (message) => {
        if (
          (message.type() === "error" || message.type() === "warning") &&
          /^(WARN|ERROR) |vega/i.test(message.text())
        )
          errors.push(message.text());
      });
      // Headlines are served only for frontend-activity-headlines, so ORB's headline requests may fail.
      page.on("response", (response) => {
        const path = new URL(response.url()).pathname;
        if (response.status() >= 400 && !path.startsWith(`/api/v1/orbs/${ORB}/headlines/`))
          errors.push(`${response.status()} ${path}`);
      });
      await page.exposeFunction("__chartRender", (detail: unknown) => renders.push(detail));
      await page.addInitScript(() => {
        const debug = console.debug.bind(console);
        console.debug = (...args) => {
          if (args[0] === "chart render")
            (globalThis as unknown as { __chartRender: (d: unknown) => void }).__chartRender(
              args[1],
            );
          debug(...args);
        };
      });

      await gotoFrontendHistory(page, `${origin}/orbs/${ORB}`, ORB);
      const rows = page.locator("details.chart-strip");
      await expect(rows).toHaveCount(10);
      for (const each of await rows.all()) {
        await expect(each).toHaveAttribute("open", "");
        await expect(each.locator(".chart-canvas svg")).toBeVisible();
        // Superseded mounts must not leave a second (finalized) chart behind.
        await expect(each.locator(".chart-canvas > div")).toHaveCount(1);
        await expect(each.locator(".chart-strip-spark svg")).toBeVisible();
      }
      await expect.poll(() => renders.length).toBe(10);
      expect(renders).toEqual(Array(10).fill(expect.objectContaining({ outcome: "rendered" })));

      // Single series: latest value in the summary, not repeated as an end label.
      const latency = row(page, "checkout-api p95 latency");
      await expect(latency.locator(".chart-strip-value")).toHaveText(/^\d+ ms$/);
      await expect(latency.locator(".chart-canvas svg text", { hasText: /^p95/ })).toHaveCount(0);

      // Before the rollback eu-central > us-east > us-west; the tooltip lists them highest first.
      const regions = row(page, "checkout-api p95 by region").locator(".chart-canvas svg");
      await regions.scrollIntoViewIfNeeded();
      await hover(page, regions, 0.2, 0.5);
      const tip = page.locator(".chart-tip");
      await expect(tip).toBeVisible();
      const cells = await tip.locator("tr").allInnerTexts();
      expect(cells[0]).toMatch(/^time\s+\d\d:\d\d$/);
      expect(cells.slice(1).map((cell) => cell.split(/\s+/)[0])).toEqual([
        "eu-central",
        "us-east",
        "us-west",
      ]);
      const values = cells.slice(1).map((cell) => Number(cell.split(/\s+/)[1]));
      expect([...values].sort((a, b) => b - a)).toEqual(values);
      await page.mouse.move(0, 0);
      await expect(tip).toBeHidden();

      const zones = row(page, "checkout-api p95 by zone").locator(".chart-canvas svg");
      await zones.scrollIntoViewIfNeeded();
      expect(await dimmedLines(zones)).toBe(0);
      await hover(page, zones.locator("text", { hasText: /^us-west-2b / }), 0.3, 0.5);
      await expect.poll(() => dimmedLines(zones)).toBe(5);
      await page.mouse.move(0, 0);
      await expect.poll(() => dimmedLines(zones)).toBe(0);

      const distribution = row(page, "latency distribution").locator(".chart-canvas svg");
      await distribution.scrollIntoViewIfNeeded();
      await hover(page, distribution.locator("text", { hasText: /^after p95 / }), 0.3, 0.5);
      await expect.poll(() => dimmedLines(distribution)).toBe(1);
      await page.mouse.move(0, 0);
      await expect.poll(() => dimmedLines(distribution)).toBe(0);

      await latency.locator("summary").click();
      await expect(latency.locator(".chart-canvas")).toBeHidden();
      await expect(latency.locator(".chart-strip-value")).toBeVisible();

      await page.setViewportSize({ width: 390, height: 844 });
      const narrowZones = row(page, "checkout-api p95 by zone");
      const key = narrowZones.locator(".chart-key");
      await expect(key).toBeVisible();
      await expect(
        narrowZones.locator(".chart-canvas svg text", { hasText: /^us-west-2b / }),
      ).toHaveCount(0);
      await key.locator("[data-series]", { hasText: "us-east-1b" }).hover();
      await expect.poll(() => dimmedLines(narrowZones.locator(".chart-canvas svg"))).toBe(5);
      expect(errors).toEqual([]);
    }
  },
);
