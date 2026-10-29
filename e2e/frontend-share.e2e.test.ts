import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Browser, chromium, expect, type Page, webkit } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";
import { closeRoutedPage } from "./testkit/close-routed-page.ts";
import { gotoFrontendHistory } from "./testkit/frontend-fixture.ts";

const ORB_ID = "frontend-fixture-orb";
const ORB_PATH = `/orbs/${ORB_ID}`;
const UPLOAD_PATH = "M3 10v3h10v-3 M8 10V2 M5 5l3-3 3 3";

async function installCapabilities(page: Page, native: boolean): Promise<void> {
  await page.addInitScript(`
    window.shareFixture = { calls: [], copies: [], outcome: "success" };
    document.execCommand = () => false;
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: ${native} ? async (data) => {
        window.shareFixture.calls.push(data);
        const outcome = window.shareFixture.outcome;
        if (outcome === "abort") throw new DOMException("Cancelled", "AbortError");
        if (outcome === "failure") throw new DOMException("Share blocked by fixture", "NotAllowedError");
      } : undefined,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text) => {
        window.shareFixture.copies.push(text);
        if (window.shareFixture.outcome === "failure") {
          throw new DOMException("Clipboard blocked by fixture", "NotAllowedError");
        }
      } },
    });
  `);
}

describe.each(["chromium", "webkit"] as const)("page sharing · %s", (engine) => {
  let vite: ViteDevServer;
  let browser: Browser;
  let origin: string;

  beforeAll(async () => {
    const root = join(import.meta.dirname, "../apps/web");
    vite = await createServer({
      root,
      configFile: join(root, "vite.config.ts"),
      mode: "frontend",
      server: { host: "127.0.0.1", port: 0 },
    });
    await listenFrontend(vite);
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("No owned share fixture port");
    origin = `http://127.0.0.1:${address.port}`;
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
  });

  afterAll(async () => {
    await browser?.close();
    await vite?.close();
  });

  it.each([
    { width: 1280, name: "Short" },
    { width: 390, name: "Short" },
    { width: 320, name: "A long orb title ".repeat(5) },
  ])("anchors pencil then Share before lifecycle at $width px", async ({ width, name }) => {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    await installCapabilities(page, true);
    await page.route(`**/api/v1/orbs/${ORB_ID}`, async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...(await response.json()), name } });
    });
    try {
      const share = page.getByRole("button", { name: "Share current page", exact: true });
      await gotoFrontendHistory(page, `${origin}${ORB_PATH}`, ORB_ID, page.locator(".orb-name"));
      await expect(share).toBeVisible();
      await expect(page.locator(".orb-name")).toHaveText(name);
      await expect(
        page.locator(".orb-identity").getByRole("button", { name: "Share current page" }),
      ).toHaveCount(1);
      const rename = page.getByRole("button", { name: "Rename orb", exact: true });
      for (const control of [rename, share]) {
        await expect(control).toBeInViewport({ ratio: 1 });
        if (width < 600) {
          await expect(control).toHaveCSS("width", "44px");
          await expect(control).toHaveCSS("height", "44px");
        }
      }
      const geometry = await page.locator(".orb-header").evaluate((header) => {
        const identity = header.querySelector(".orb-identity");
        const view = header.ownerDocument.defaultView;
        if (!identity || !view) throw new Error("Missing title region");
        const rect = (selector: string) => {
          const element = header.querySelector(selector);
          if (!element) throw new Error(`Missing header element: ${selector}`);
          const box = element.getBoundingClientRect();
          return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
        };
        return {
          name: rect(".orb-name"),
          identity: rect(".orb-identity"),
          identityPadding: Number.parseFloat(view.getComputedStyle(identity).paddingRight),
          rename: rect('[aria-label="Rename orb"]'),
          share: rect('[aria-label="Share current page"]'),
          life: rect(".orb-life"),
          overflow:
            header.ownerDocument.documentElement.scrollWidth >
            header.ownerDocument.documentElement.clientWidth,
        };
      });
      expect(geometry.name.right).toBeLessThanOrEqual(geometry.rename.left + 1);
      expect(geometry.rename.right).toBeLessThanOrEqual(geometry.share.left + 1);
      expect(geometry.share.right).toBeCloseTo(
        geometry.identity.right - geometry.identityPadding,
        0,
      );
      expect(geometry.share.right).toBeLessThanOrEqual(geometry.life.left + 1);
      expect(geometry.rename.top).toBeCloseTo(geometry.share.top, 0);
      expect(geometry.share.top).toBeLessThan(geometry.life.bottom);
      expect(geometry.overflow).toBe(false);
      await expect(share.locator("svg use")).toHaveAttribute("href", "#i-share");
      await expect(page.locator("#i-share circle")).toHaveCount(3);
      await expect(page.locator("#i-share path")).not.toHaveAttribute("d", UPLOAD_PATH);
      await expect(page.locator("#i-upload path")).toHaveAttribute("d", UPLOAD_PATH);
      const upload = page.getByRole("button", { name: "Upload files", exact: true });
      if (width < 600) {
        await expect(upload).toBeHidden();
        await page.getByRole("button", { name: "Orb actions", exact: true }).click();
        await expect(page.locator(".orb-header")).toHaveAttribute("data-phone-actions", "true");
      }
      await expect(upload).toBeVisible();
      await expect(
        page.locator(".orb-header-actions").getByRole("button", { name: "Upload files" }),
      ).toHaveCount(1);
      await expect(upload.locator("svg use")).toHaveAttribute("href", "#i-upload");
      if (width < 600) {
        const uploadBox = await upload.boundingBox();
        const shareBox = await share.boundingBox();
        expect(uploadBox?.y).toBeGreaterThanOrEqual((shareBox?.y ?? 0) + (shareBox?.height ?? 0));
      }
    } finally {
      await closeRoutedPage(page);
    }
  });

  it("shares fresh exact URL/title while busy, renaming, and stopping", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 844 } });
    await installCapabilities(page, true);
    await page.route(`**/api/v1/orbs/${ORB_ID}`, async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        json: { ...(await response.json()), state: "running", activity: "busy" },
      });
    });
    let releaseStop = () => {};
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    let reachedStop = () => {};
    const stopReached = new Promise<void>((resolve) => {
      reachedStop = resolve;
    });
    await page.route(`**/api/v1/orbs/${ORB_ID}/stop`, async (route) => {
      reachedStop();
      await stopGate;
      await route.fulfill({
        status: 503,
        json: {
          error: {
            code: "unavailable",
            message: "Controlled stop fixture",
            retryable: true,
          },
        },
      });
    });
    try {
      await gotoFrontendHistory(page, `${origin}${ORB_PATH}`, ORB_ID, page.locator(".orb-name"));
      const share = page.getByRole("button", { name: "Share current page", exact: true });
      await expect(share).toBeEnabled();
      await page.getByRole("button", { name: "Rename orb", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "orb name", exact: true })).toBeVisible();
      await expect(share).toBeEnabled();
      await page.getByRole("button", { name: "cancel", exact: true }).click();
      await page.getByRole("button", { name: "Stop orb", exact: true }).click();
      await stopReached;
      await expect(share).toBeEnabled();
      for (const [query, title] of [
        ["?view=one#first", "First title"],
        ["?view=two%20words#second", "Fresh title"],
      ]) {
        await page.evaluate(
          `history.replaceState(history.state, "", "${ORB_PATH}${query}"); document.title = "${title}";`,
        );
        await share.click();
        await expect
          .poll(() => page.evaluate("window.shareFixture.calls.at(-1)"))
          .toEqual({
            url: `${origin}${ORB_PATH}${query}`,
            title,
          });
        await expect(share).toBeEnabled();
      }
      expect(await page.evaluate("window.shareFixture.copies")).toEqual([]);
    } finally {
      releaseStop();
      await closeRoutedPage(page);
    }
  });

  it("keeps native cancellation quiet and shows other share failures", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await installCapabilities(page, true);
    try {
      await gotoFrontendHistory(page, `${origin}${ORB_PATH}`, ORB_ID, page.locator(".orb-name"));
      const share = page.getByRole("button", { name: "Share current page", exact: true });
      await page.evaluate('window.shareFixture.outcome = "abort"');
      await share.click();
      await expect.poll(() => page.evaluate("window.shareFixture.calls.length")).toBe(1);
      await expect(share).toBeEnabled();
      await expect(page.locator(".orb-header-scroll").getByRole("alert")).toHaveCount(0);
      await page.evaluate('window.shareFixture.outcome = "failure"');
      await share.click();
      await expect(
        page.locator(".orb-header-scroll").getByRole("alert").filter({ hasText: /share/i }),
      ).toBeVisible();
      expect(await page.evaluate("window.shareFixture.copies")).toEqual([]);
      await expect(share).toBeEnabled();
    } finally {
      await closeRoutedPage(page);
    }
  });

  it("copies the exact current URL without native share and exposes clipboard failure", async () => {
    const page = await browser.newPage({ viewport: { width: 320, height: 844 } });
    await installCapabilities(page, false);
    try {
      await gotoFrontendHistory(page, `${origin}${ORB_PATH}`, ORB_ID, page.locator(".orb-name"));
      const copy = page.getByRole("button", { name: "Copy link", exact: true });
      await expect(copy).toBeVisible();
      const suffix = "?view=copy%20link#current";
      await page.evaluate(`history.replaceState(history.state, "", "${ORB_PATH}${suffix}")`);
      await copy.click();
      await expect
        .poll(() => page.evaluate("window.shareFixture.copies"))
        .toEqual([`${origin}${ORB_PATH}${suffix}`]);
      await expect(page.locator(".orb-header-scroll").getByRole("alert")).toHaveCount(0);
      await expect(
        page
          .locator(".orb-header-scroll")
          .getByRole("status")
          .filter({ hasText: /copied/i }),
      ).toBeVisible();
      await page.evaluate('window.shareFixture.outcome = "failure"');
      await copy.click();
      await expect(
        page
          .locator(".orb-header-scroll")
          .getByRole("alert")
          .filter({ hasText: /copy|clipboard/i }),
      ).toBeVisible();
      await expect(copy).toBeEnabled();
      expect(await page.evaluate("window.shareFixture.calls")).toEqual([]);
    } finally {
      await closeRoutedPage(page);
    }
  });
});
