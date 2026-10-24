import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UsageView } from "@pi-orb/protocol";
import { type Browser, chromium, expect, type Page, webkit } from "@playwright/test";
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
      expect(fixtureUsage.headers()["connection"]).toBe("close");
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
                    orbId: "00000000-0000-4000-8000-000000000001",
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
      const entry = page.getByRole("link", { name: "Token usage", exact: true });
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
      const tickLines = timeline.locator("g.x_ticks_marks line");
      const xLabelsApart = () =>
        timeline
          .locator('g.role-axis[aria-label^="X-axis"] g.role-axis-label text')
          .evaluateAll((ns) => {
            const boxes = ns
              .filter(
                (n) =>
                  n.textContent !== "" &&
                  n.ownerDocument.defaultView?.getComputedStyle(n).opacity !== "0",
              )
              .map((n) => n.getBoundingClientRect());
            return boxes.length > 1 && boxes.every((b, i) => (boxes[i - 1]?.right ?? 0) < b.left);
          });
      for (const [label, count] of [
        ["Last day", 96],
        ["Week", 168],
        ["Month", 120],
        ["6 months", 183],
      ] as const) {
        await page.getByRole("button", { name: label, exact: true }).click();
        await expect(tickLines).toHaveCount(count);
        for (const width of [320, 1440]) {
          await page.setViewportSize({ width, height: 1000 });
          await expect.poll(xLabelsApart).toBe(true);
        }
        await expect(timeline.locator("g.mark-line path")).toHaveCount(4);
        await expect(page.locator(".usage-rankings .chart-canvas svg")).toHaveCount(1);
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
      for (const [name, measure] of [
        ["Uncached input", "input"],
        ["Cached input", "cacheRead"],
        ["Cache write", "cacheWrite"],
        ["Output", "output"],
      ] as const) {
        const control = timeline.getByRole("button", { name, exact: true });
        await control.click();
        await expect(page.getByLabel("Measure")).toHaveValue(measure);
      }
      const cachedControl = timeline.getByRole("button", { name: "Cached input", exact: true });
      await cachedControl.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByLabel("Measure")).toHaveValue("cacheRead");
      await expect.poll(dimmed).toBe(3);
      await cachedControl.blur();
      const desktopOutput = timeline.getByRole("button", { name: "Output", exact: true });
      await desktopOutput.focus();
      await page.keyboard.press("Space");
      await expect(page.getByLabel("Measure")).toHaveValue("output");
      await desktopOutput.blur();

      const svgBox = await timeline.locator(".chart-canvas svg").boundingBox();
      if (svgBox === null) throw new Error("No plot bounds");
      await page.mouse.move(svgBox.x + svgBox.width * 0.4, svgBox.y + svgBox.height * 0.5);
      await expect(page.locator(".chart-tip")).toBeVisible();
      await expect(page.locator(".chart-tip tr")).toHaveCount(5);
      await expect(page.locator(".chart-tip")).toContainText("tokens");
      const readsBeforeFilters = windows.length;
      await page.getByLabel("Measure").selectOption("output");
      await expect(page.locator(".usage-bars svg text", { hasText: "5 tokens" })).toHaveCount(1);
      await expect(page.locator(".usage-orb-value")).toHaveText("5 tokens");
      await page.getByLabel("Breakdown").selectOption("use");
      await expect(timeline.locator("g.mark-line path")).toHaveCount(6);
      await page.getByLabel("Breakdown").selectOption("model");
      await expect(timeline.locator("g.mark-line path")).toHaveCount(1);
      await page.getByLabel("Breakdown").selectOption("orb");
      await expect(timeline.locator("g.mark-line path")).toHaveAttribute(
        "aria-label",
        /Recorded orb/,
      );
      await expect(
        timeline.getByRole("link", { name: "Recorded orb", exact: true }),
      ).toHaveAttribute("href", "/orbs/00000000-0000-4000-8000-000000000001");
      const orbPlot = await timeline.locator(".chart-canvas svg").boundingBox();
      if (orbPlot === null) throw new Error("No orb plot bounds");
      await page.mouse.move(orbPlot.x + orbPlot.width * 0.4, orbPlot.y + orbPlot.height * 0.5);
      await expect(page.locator(".chart-tip")).toContainText("Recorded orb");
      await page.getByLabel("Breakdown").selectOption("token_kind");
      expect(windows.length).toBe(readsBeforeFilters);
      await page.screenshot({ path: "/tmp/usage-implemented-1440.png", fullPage: true });
      for (const width of [1440, 901, 900, 621]) {
        await page.setViewportSize({ width, height: 1000 });
        const stacked = width <= 900;
        await expect
          .poll(() =>
            page.locator(".usage-overview").evaluate((n) => {
              const [summary, timeline] = [...n.children].map((c) => c.getBoundingClientRect());
              return !!summary && !!timeline && timeline.top >= summary.bottom;
            }),
          )
          .toBe(stacked);
        await expect
          .poll(() =>
            page.locator(".usage-bars").evaluate((n) => {
              const [orbs, uses] = [...n.children].map((c) => c.getBoundingClientRect());
              return !!orbs && !!uses && uses.top >= orbs.bottom;
            }),
          )
          .toBe(stacked);
        if (stacked) {
          await expect
            .poll(() =>
              timeline.evaluate((n) => {
                const plot = n.getBoundingClientRect();
                const overview = n.parentElement?.getBoundingClientRect();
                return overview !== undefined && Math.abs(plot.width - overview.width) < 1;
              }),
            )
            .toBe(true);
        }
        expect(
          await page
            .locator("html")
            .evaluate((n) => n.scrollWidth <= (n.ownerDocument.defaultView?.innerWidth ?? 0)),
        ).toBe(true);
        await page.screenshot({
          path: "/tmp/usage-layout-" + engine + "-" + width + ".png",
          fullPage: true,
        });
      }
      await expect(page.getByText("Recorded Pi + Luna", { exact: true })).toHaveCount(0);
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        const key = timeline.locator(".chart-key");
        await expect(key).toBeVisible();
        expect(
          await key
            .locator("a, button")
            .evaluateAll((nodes) =>
              nodes.every((node) => node.getBoundingClientRect().height >= 44),
            ),
        ).toBe(true);
        await key.locator('[data-series="Output"]').hover();
        await key.getByRole("button", { name: "Uncached input", exact: true }).click();
        await expect(page.getByLabel("Measure")).toHaveValue("input");
        const output = key.getByRole("button", { name: "Output", exact: true });
        await output.focus();
        await page.keyboard.press("Space");
        await expect(page.getByLabel("Measure")).toHaveValue("output");
        await output.hover();

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
      await page.unroute("**/api/v1/usage?*");
      await checkOrbLinks(page, origin);
      await checkAggregateLegend(page);
      expect(errors).toEqual([]);
    } finally {
      await browser?.close();
      await vite.close();
      await rm(cacheDir, { recursive: true, force: true });
    }
  },
);

async function checkOrbLinks(page: Page, origin: string) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(origin + "/usage");
  const rows = page.locator(".usage-orb-row");
  await expect(rows).toHaveCount(5);
  const response = await page.request.get(
    origin +
      "/api/v1/usage?boundaries=" +
      encodeURIComponent(JSON.stringify([Date.UTC(2026, 9, 13), Date.UTC(2026, 9, 14)])),
  );
  const metadata = ((await response.json()) as UsageView).orbs;
  for (const orb of metadata) {
    await expect(
      page.locator('.usage-orb-row[href="/orbs/' + encodeURIComponent(orb.id) + '"]'),
    ).toHaveCount(1);
  }
  const timeline = page.locator(".usage-timeline");
  await page.getByLabel("Breakdown").selectOption("orb");
  await expect(timeline.locator("g.mark-line path")).toHaveCount(5);
  for (const orb of metadata)
    await expect(timeline.locator("svg text", { hasText: orb.name ?? orb.id })).toHaveCount(1);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(timeline.locator(".chart-key [data-series]")).toHaveCount(5);
    expect(
      await timeline
        .locator(".chart-key a")
        .evaluateAll((nodes) => nodes.every((node) => node.getBoundingClientRect().height >= 44)),
    ).toBe(true);
    for (const orb of metadata)
      await expect(
        timeline.locator('.chart-key [data-series="' + (orb.name ?? orb.id) + '"]'),
      ).toBeVisible();
    expect(
      await page
        .locator("html")
        .evaluate((n) => n.scrollWidth <= (n.ownerDocument.defaultView?.innerWidth ?? 0)),
    ).toBe(true);
  }
  // Desktop SVG anchors and phone HTML anchors keep native new-tab and keyboard behavior.
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    const legend = timeline.locator(width === 320 ? ".chart-key" : ".chart-canvas svg");
    const namedOrb = metadata.find((orb) => orb.name !== null);
    const deletedOrb = metadata.find((orb) => orb.name === null);
    if (!namedOrb || !deletedOrb) throw new Error("Missing legend fixture metadata");
    for (const orb of [namedOrb, deletedOrb]) {
      const link = legend.getByRole("link", { name: orb.name ?? orb.id, exact: true });
      const href = "/orbs/" + encodeURIComponent(orb.id);
      await expect(link).toHaveAttribute("href", href);
      await link.focus();
      await expect(link).toBeFocused();
      const opened = page.context().waitForEvent("page");
      await link.click({ modifiers: ["ControlOrMeta"] });
      const tab = await opened;
      await expect(tab).toHaveURL(origin + href);
      if (orb.name === null)
        await expect(
          tab.getByRole("heading", { name: "Orb doesn't exist", exact: true }),
        ).toBeVisible();
      // Closing a loading WebKit tab corrupts its network process (docs/postmortems/2026-10-15-webkit-tab-close-libsoup.md).
      await tab.waitForLoadState("networkidle");
      await tab.close();
      await expect(page).toHaveURL(origin + "/usage");
    }
    for (const activation of ["click", "keyboard"]) {
      const link = legend.getByRole("link", { name: namedOrb.name ?? namedOrb.id, exact: true });
      if (activation === "click") await link.click();
      else {
        await link.focus();
        await page.keyboard.press("Enter");
      }
      await expect(page).toHaveURL(origin + "/orbs/" + encodeURIComponent(namedOrb.id));
      await expect(page.locator(".orb-identity")).toContainText(namedOrb.name ?? namedOrb.id);
      await page.goBack();
      await expect(page).toHaveURL(origin + "/usage");
      await page.getByLabel("Breakdown").selectOption("orb");
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  const named = metadata.find((orb) => orb.name !== null);
  if (!named || named.name === null) throw new Error("No named usage fixture orb");
  const href = "/orbs/" + encodeURIComponent(named.id);
  const row = page.locator('.usage-orb-row[href="' + href + '"]');
  await row.hover();
  await expect(row).toHaveCSS("background-color", "rgb(242, 242, 242)");
  await expect(row.locator(".usage-orb-name")).toHaveCSS("text-decoration-line", "underline");
  await expect(row.locator(".usage-orb-value")).toHaveCSS("text-decoration-line", "none");
  for (const part of [".usage-orb-name", ".usage-orb-bar", ".usage-orb-value"]) {
    await row.locator(part).click();
    await expect(page).toHaveURL(origin + href);
    await expect(page.locator(".orb-identity")).toContainText(named.name);
    await page.goBack();
    await expect(page).toHaveURL(origin + "/usage");
    await expect(rows).toHaveCount(5);
  }
  const newPage = page.context().waitForEvent("page");
  await row.click({ modifiers: ["ControlOrMeta"] });
  const tab = await newPage;
  await expect(tab).toHaveURL(origin + href);
  await expect(page).toHaveURL(origin + "/usage");
  await tab.waitForLoadState("networkidle");
  await tab.close();
  await page.mouse.move(0, 0);
  await page.getByLabel("Measure").focus();
  for (const target of await rows.all()) {
    await page.keyboard.press("Tab");
    await expect(target).toBeFocused();
    await expect(target).toHaveCSS("outline-width", "2px");
    await expect(target).toHaveCSS("outline-style", "solid");
  }
  await page.keyboard.press("Tab");
  await expect(page.locator(".usage-orb-row:focus")).toHaveCount(0);
  await row.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(origin + href);
  await expect(page.locator(".orb-identity")).toContainText(named.name);
  await page.goBack();
  await expect(page).toHaveURL(origin + "/usage");
  await expect(rows).toHaveCount(5);
  const missing = metadata.find((orb) => orb.name === null);
  if (!missing) throw new Error("No deleted usage fixture orb");
  const missingHref = "/orbs/" + encodeURIComponent(missing.id);
  await page.locator('.usage-orb-row[href="' + missingHref + '"]').click();
  await expect(page).toHaveURL(origin + missingHref);
  await expect(page.getByRole("heading", { name: "Orb doesn't exist", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to dashboard" })).toHaveAttribute("href", "/");
  await page.goBack();
  await expect(page).toHaveURL(origin + "/usage");
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(rows).toHaveCount(5);
    expect(
      await rows.evaluateAll((ns) =>
        ns.every((n) => {
          const box = n.getBoundingClientRect();
          return (
            box.height >= 44 &&
            box.x >= 0 &&
            box.right <= (n.ownerDocument.defaultView?.innerWidth ?? 0)
          );
        }),
      ),
    ).toBe(true);
    expect(
      await page
        .locator(".usage-orb-value")
        .evaluateAll((ns) =>
          ns.every(
            (n) =>
              n.getBoundingClientRect().right <= (n.ownerDocument.defaultView?.innerWidth ?? 0),
          ),
        ),
    ).toBe(true);
  }
}

async function checkAggregateLegend(page: Page) {
  const ids = Array.from({ length: 7 }, (_, i) => "00000000-0000-4000-8000-00000000000" + (i + 1));
  await page.route("**/api/v1/usage?*", async (route) => {
    const boundaries = JSON.parse(
      new URL(route.request().url()).searchParams.get("boundaries") ?? "[]",
    ) as number[];
    const totals = { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, calls: 1 };
    await route.fulfill({
      json: {
        boundaries,
        summary: { ...totals, input: 70, calls: 7 },
        buckets: ids.map((orbId) => ({
          ...totals,
          orbId,
          at: boundaries[0],
          use: "root",
          provider: "p",
          model: "m",
        })),
        orbs: ids.map((id, i) => ({
          ...totals,
          id,
          name: i === 0 ? "Other" : i === 1 ? null : "Same",
        })),
      },
    });
  });
  await page.reload();
  await page.getByLabel("Breakdown").selectOption("orb");
  const timeline = page.locator(".usage-timeline");
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(timeline.getByRole("link")).toHaveCount(5);
    await expect(
      timeline.getByRole("link", { name: "Other · " + ids[0], exact: true }),
    ).toHaveAttribute("href", "/orbs/" + ids[0]);
    await expect(timeline.getByRole("link", { name: ids[1]!, exact: true })).toHaveAttribute(
      "href",
      "/orbs/" + ids[1],
    );
    await expect(
      timeline.getByRole("link", { name: "Same · " + ids[2], exact: true }),
    ).toHaveAttribute("href", "/orbs/" + ids[2]);
    await expect(timeline.getByRole("link", { name: "Other", exact: true })).toHaveCount(0);
    await expect(timeline.getByRole("button", { name: "Other", exact: true })).toHaveCount(0);
    const aggregate =
      width === 1440
        ? timeline.locator("svg text", { hasText: /^Other [0-9]/ })
        : timeline.locator('.chart-key [data-series="Other"]');
    // Use the painted center for inert SVG text; action entries use normal locator clicks above.
    await aggregate.scrollIntoViewIfNeeded();
    const point = await aggregate.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      return { x, y, hitsLabel: node.contains(node.ownerDocument.elementFromPoint(x, y)) };
    });
    expect(point.hitsLabel).toBe(true);
    await page.mouse.click(point.x, point.y);
    await expect(page).toHaveURL(/\/usage$/);
  }
}
