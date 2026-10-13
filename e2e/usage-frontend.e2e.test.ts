import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UsageView } from "@pi-orb/protocol";
import { type Browser, chromium, expect, webkit } from "@playwright/test";
import { createServer } from "vite";
import { it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";
import { gotoFrontendFixture } from "./testkit/frontend-fixture.ts";

it.each(["chromium", "webkit"] as const)(
  "%s: Trend usage entry, shared interactive charts, dense civil days and visible failures",
  async (engine) => {
    const root = join(import.meta.dirname, "../apps/web");
    const cacheDir = await mkdtemp(join(tmpdir(), "pi-orb-usage-" + engine + "-"));
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
      const origin = "http://127.0.0.1:" + address.port;
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
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
        timezoneId: "America/Los_Angeles",
      });
      const fixtureUsage = await page.request.get(
        origin + "/api/v1/usage?boundaries=" + encodeURIComponent(JSON.stringify([0, 900000])),
      );
      expect(fixtureUsage.status()).toBe(200);
      expect(await fixtureUsage.json()).toMatchObject({
        boundaries: [0, 900000],
        summary: { calls: 0 },
      });
      await page.clock.install({ time: new Date("2026-12-01T18:00:00Z") });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      const windows: number[][] = [];
      let mode: "data" | "empty" | "failed" | "large" = "data";
      let releaseHeld: () => void = () => {};
      let hold = false;
      await page.route("**/api/v1/usage?*", async (route) => {
        const boundaries = JSON.parse(
          new URL(route.request().url()).searchParams.get("boundaries") ?? "[]",
        ) as number[];
        windows.push(boundaries);
        if (hold) {
          await new Promise<void>((resolve) => {
            releaseHeld = resolve;
          });
        }
        if (mode === "failed") {
          await route.fulfill({
            status: 503,
            json: { error: { code: "unavailable", message: "Usage unavailable", retryable: true } },
          });
          return;
        }
        const totals =
          mode === "large"
            ? {
                input: 1_000_000_000,
                output: 1_000_000_000,
                cacheRead: 8_000_000_000,
                cacheWrite: 0,
                calls: 5,
              }
            : { input: 10, output: 5, cacheRead: 80, cacheWrite: 5, calls: 1 };
        const data: UsageView = {
          boundaries,
          summary:
            mode === "empty"
              ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 }
              : totals,
          buckets:
            mode === "empty"
              ? []
              : [
                  {
                    ...totals,
                    at: boundaries[0] ?? 0,
                    use: "root",
                    provider: "openai",
                    model: "example",
                  },
                ],
          orbs:
            mode === "empty"
              ? []
              : [{ ...totals, id: "00000000-0000-4000-8000-000000000001", name: "Recorded orb" }],
        };
        await route.fulfill({ json: data });
      });
      await gotoFrontendFixture(page, origin + "/");
      const entry = page.getByRole("link", { name: "Token usage" });
      await expect(entry).toBeVisible();
      await expect(entry.locator("use")).toHaveAttribute("href", "#i-trend");
      await expect(entry.locator("xpath=following-sibling::*[1]")).toHaveAttribute(
        "aria-label",
        "Settings",
      );
      for (const width of [320, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        const linkBox = await entry.boundingBox();
        const settingsBox = await page
          .getByRole("button", { name: "Settings", exact: true })
          .boundingBox();
        expect(linkBox).not.toBeNull();
        expect(settingsBox).not.toBeNull();
        expect(
          Math.abs((linkBox?.x ?? 0) + (linkBox?.width ?? 0) - (settingsBox?.x ?? 0)),
        ).toBeLessThanOrEqual(1);
      }
      await entry.click();
      await expect(page).toHaveURL(origin + "/usage");
      const timeline = page.locator(".usage-timeline");
      const tickLines = timeline.locator('g.role-axis[aria-label^="X-axis"] g.role-axis-tick line');
      for (const [label, count] of [
        ["Last day", 96],
        ["Week", 168],
        ["Month", 120],
        ["6 months", 183],
      ] as const) {
        await page.getByRole("button", { name: label, exact: true }).click();
        await expect(tickLines).toHaveCount(count);
        await expect(timeline.locator("g.mark-line path")).toHaveCount(4);
        await expect(page.locator(".usage-rankings .chart-canvas svg")).toHaveCount(2);
      }
      await expect(page.locator(".usage-summary dd")).toHaveText(["100", "10", "5", "84.2%", "1"]);
      const daily = windows.at(-1) ?? [];
      expect(daily.slice(1).some((t, i) => t - (daily[i] ?? 0) === 25 * 3600000)).toBe(true);
      const summary = await page.locator(".usage-summary").boundingBox();
      const plot = await timeline.boundingBox();
      expect(summary?.x).toBeLessThan(plot?.x ?? 0);
      const label = timeline.locator("svg text", { hasText: /^Cached input / });
      await writeFile(
        "/tmp/usage-label-bounds-" + engine + ".json",
        JSON.stringify(
          await timeline.locator('text[aria-roledescription="text mark"]').evaluateAll((ns) =>
            ns.map((n) => {
              const r = n.getBoundingClientRect();
              return {
                label: n.textContent,
                transform: n.getAttribute("transform"),
                rect: { x: r.x, y: r.y, width: r.width, height: r.height },
                atCenter: n.ownerDocument.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
                  ?.textContent,
              };
            }),
          ),
          null,
          2,
        ),
      );
      const labelBox = await label.boundingBox();
      if (labelBox === null) throw new Error("No series label bounds");
      await page.mouse.move(labelBox.x + labelBox.width / 2, labelBox.y + labelBox.height / 2);
      const dimmed = () =>
        timeline
          .locator("g.mark-line path")
          .evaluateAll(
            (ns) => ns.filter((n) => Number(n.getAttribute("opacity") ?? 1) < 0.5).length,
          );
      await expect.poll(dimmed).toBe(3);
      const svgBox = await timeline.locator(".chart-canvas svg").boundingBox();
      if (svgBox === null) throw new Error("No plot bounds");
      await page.mouse.move(svgBox.x + svgBox.width * 0.4, svgBox.y + svgBox.height * 0.5);
      await expect(page.locator(".chart-tip")).toBeVisible();
      await expect(page.locator(".chart-tip tr")).toHaveCount(5);
      await expect(page.locator(".chart-tip")).toContainText("tokens");
      const readsBeforeFilters = windows.length;
      await page.getByLabel("Measure").selectOption("output");
      await expect(page.locator(".usage-bars svg text", { hasText: "5 tokens" })).toHaveCount(2);
      await page.getByLabel("Breakdown").selectOption("use");
      await expect(timeline.locator("g.mark-line path")).toHaveCount(6);
      await page.getByLabel("Breakdown").selectOption("model");
      await expect(timeline.locator("g.mark-line path")).toHaveCount(1);
      await page.getByLabel("Breakdown").selectOption("token_kind");
      expect(windows.length).toBe(readsBeforeFilters);
      await page.screenshot({ path: "/tmp/usage-implemented-1440.png", fullPage: true });
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        const key = timeline.locator(".chart-key");
        await expect(key).toBeVisible();
        await key.locator('[data-series="Output"]').hover();
        await expect.poll(dimmed).toBe(3);
        expect(
          await page
            .locator("html")
            .evaluate((n) => n.scrollWidth <= (n.ownerDocument.defaultView?.innerWidth ?? 0)),
        ).toBe(true);
        const clipped = await page
          .locator(".usage-rankings svg text")
          .evaluateAll((ns) =>
            ns
              .filter(
                (n) =>
                  n.getBoundingClientRect().x <
                  (n.closest("svg")?.getBoundingClientRect().x ?? 0) - 1,
              )
              .map((n) => n.textContent),
          );
        expect(clipped).toEqual([]);
        await page.screenshot({ path: "/tmp/usage-implemented-" + width + ".png", fullPage: true });
      }
      await page.getByLabel("Breakdown").selectOption("use");
      await expect(timeline.locator("g.mark-line path")).toHaveCount(6);
      await writeFile(
        "/tmp/usage-highlight-transition-" + engine + ".json",
        JSON.stringify(
          {
            keyHighlighted: await timeline.locator(".chart-key").getAttribute("data-highlighted"),
            keys: await timeline.locator(".chart-key [data-series]").evaluateAll((ns) =>
              ns.map((n) => ({
                series: n.getAttribute("data-series"),
                on: n.getAttribute("data-on"),
              })),
            ),
            dimmed: await dimmed(),
          },
          null,
          2,
        ),
      );
      await expect
        .poll(async () => {
          const key = timeline.locator(".chart-key");
          const highlighted = (await key.getAttribute("data-highlighted")) !== null;
          return highlighted
            ? (await key.locator("[data-on]").count()) === 1 && (await dimmed()) === 5
            : (await dimmed()) === 0;
        })
        .toBe(true);
      // A superseded read is explicitly held, not scheduled with a sleep.
      hold = true;
      await page.getByRole("button", { name: "Week", exact: true }).click();
      await expect.poll(() => windows.at(-1)?.length).toBe(169);
      hold = false;
      await page.getByRole("button", { name: "Last day", exact: true }).click();
      await expect(tickLines).toHaveCount(96);
      releaseHeld();
      await expect(tickLines).toHaveCount(96);
      await expect(page.getByLabel("Measure")).toHaveValue("output");
      await expect(page.getByLabel("Breakdown")).toHaveValue("use");
      mode = "failed";
      await page.getByRole("button", { name: "Month", exact: true }).click();
      await expect(page.getByRole("alert")).toContainText("Usage unavailable");
      mode = "empty";
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await expect(page.getByText("No recorded calls.", { exact: true })).toBeVisible();
      await expect(timeline.locator("svg")).toHaveCount(0);
      mode = "data";
      await page.clock.setFixedTime(new Date("2026-07-01T17:00:00Z"));
      await page.getByRole("button", { name: "6 months", exact: true }).click();
      await expect(tickLines).toHaveCount(181);
      const spring = windows.at(-1) ?? [];
      expect(spring.slice(1).some((t, i) => t - (spring[i] ?? 0) === 23 * 3600000)).toBe(true);
      mode = "large";
      await page.getByRole("button", { name: "Week", exact: true }).click();
      await expect(page.locator(".usage-summary dd")).toHaveText(["10B", "1B", "1B", "88.9%", "5"]);
      expect(
        await page
          .locator("html")
          .evaluate((n) => n.scrollWidth <= (n.ownerDocument.defaultView?.innerWidth ?? 0)),
      ).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await browser?.close();
      await vite.close();
      await rm(cacheDir, { recursive: true, force: true });
    }
  },
);
