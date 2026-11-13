import { existsSync } from "node:fs";
import { join } from "node:path";
import type { OrbLinksResponse } from "@pi-orb/protocol";
import { type Browser, chromium, expect as expectPage, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";
import { closeRoutedPage } from "./testkit/close-routed-page.ts";

const WEB_ROOT = join(import.meta.dirname, "../apps/web");
const PR = "https://github.com/owner/repo/pull/291";
const summary: OrbLinksResponse = {
  repository: "owner/repo",
  githubError: "GitHub: another repository is inaccessible (HTTP 403)",
  items: [
    {
      url: PR,
      addedAt: 1,
      github: {
        title: "Accessible pull request",
        status: "open",
        diff: null,
        comments: null,
        checks: [
          {
            id: "check-build",
            name: "build",
            result: "passed",
            url: null,
            startedAt: 1_000,
            completedAt: 2_000,
          },
          {
            id: "check-test",
            name: "tests",
            result: "failed",
            url: null,
            startedAt: 1_000,
            completedAt: 3_000,
          },
          {
            id: null,
            name: "external status",
            result: "passed",
            url: null,
            startedAt: null,
            completedAt: null,
          },
        ],
      },
    },
  ],
};
const steps = (name: string) => ({
  steps: [{ name, result: "failed", startedAt: 1_000, completedAt: 2_000 }],
  githubError: null,
});

let vite: ViteDevServer;
let browser: Browser;
let origin: string;

async function openDrawer(page: Page) {
  await page.goto(`${origin}/__orb-links`);
  await expectPage(page.locator(".orb-link-title")).toHaveText("Accessible pull request");
  await page.locator(".orb-links > summary").click();
  await expectPage(page.getByText(summary.githubError ?? "", { exact: true })).toBeVisible();
  await page.locator(".orb-link > summary").click();
  await expectPage(page.getByRole("row", { name: "build 1s" })).toBeVisible();
}

describe("orb links lazy browser reads", () => {
  beforeAll(async () => {
    vite = await createServer({
      root: WEB_ROOT,
      cacheDir: join(WEB_ROOT, "node_modules/.vite-test/orb-links"),
      configFile: join(WEB_ROOT, "vite.config.ts"),
      mode: "frontend",
      plugins: [
        {
          name: "test-orb-links",
          resolveId: (id) => (id === "virtual:orb-links-test" ? `\0${id}` : null),
          load(id) {
            if (id !== "\0virtual:orb-links-test") return null;
            return `
            import React, { useState } from "react";
            import { createRoot } from "react-dom/client";
            import { OrbLinks } from "/src/components/OrbLinks.tsx";
            import "/src/styles.css";
            function Fixture() {
              const [orbId, setOrbId] = useState("first");
              return React.createElement("main", null,
                React.createElement("button", { onClick: () => setOrbId("second") }, "Switch orb"),
                React.createElement(OrbLinks, { orbId }));
            }
            createRoot(document.getElementById("root")).render(React.createElement(Fixture));
          `;
          },
          configureServer(server) {
            server.middlewares.use(async (request, response, next) => {
              if (request.url !== "/__orb-links") return next();
              const html = await server.transformIndexHtml(
                request.url,
                '<main id="root"></main><script type="module">import "virtual:orb-links-test";</script>',
              );
              response.setHeader("Content-Type", "text/html");
              response.end(html);
            });
          },
        },
      ],
    });
    await listenFrontend(vite);
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("No orb links fixture port");
    origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({
      headless: true,
      ...(existsSync("/usr/bin/chromium") ? { executablePath: "/usr/bin/chromium" } : {}),
    });
  });
  afterAll(async () => {
    await browser?.close();
    await vite?.close();
  });

  it("reads only expanded checks, keeps partial-data warnings, and stops on collapse", async () => {
    const page = await browser.newPage();
    const selected: string[] = [];
    let listReads = 0;
    await page.route("**/api/v1/orbs/*/links**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/steps")) {
        expect(url.searchParams.get("url")).toBe(PR);
        selected.push(url.searchParams.get("checkId") ?? "");
        return route.fulfill({ json: steps("Run selected tests") });
      }
      listReads++;
      return route.fulfill({ json: summary });
    });
    try {
      await page.clock.install({ time: 0 });
      await page.clock.pauseAt(1000);
      await page.goto(`${origin}/__orb-links`);
      await expectPage(page.locator(".orb-link-title")).toHaveText("Accessible pull request");
      expect(selected).toEqual([]);
      await page.clock.runFor(15_001);
      await expectPage.poll(() => listReads).toBe(2);
      expect(selected).toEqual([]);
      await page.locator(".orb-links > summary").click();
      await expectPage(page.getByText(summary.githubError ?? "", { exact: true })).toBeVisible();
      await page.locator(".orb-link > summary").click();
      const check = page.getByRole("row", { name: "tests 2s" });
      await expectPage(check).toHaveAttribute("aria-expanded", "false");
      expect(selected).toEqual([]);
      await expectPage(page.getByRole("row", { name: "external status" })).not.toHaveAttribute(
        "aria-expanded",
      );
      await check.click();
      await expectPage(page.getByText("Run selected tests", { exact: false })).toBeVisible();
      expect(selected).toEqual(["check-test"]);
      await check.click();
      await expectPage(check).toHaveAttribute("aria-expanded", "false");
      await expectPage(page.getByText("Run selected tests", { exact: false })).toHaveCount(0);
      await page.clock.runFor(30_001);
      expect(selected).toEqual(["check-test"]);
      // Keyboard expansion follows the same individual-check path.
      await check.focus();
      await check.press("Enter");
      await expectPage(page.getByText("Run selected tests", { exact: false })).toBeVisible();
      expect(selected).toEqual(["check-test", "check-test"]);
      await page.locator(".orb-link > summary").click();
      await expectPage(page.locator(".orb-link")).not.toHaveAttribute("open");
      await page.clock.runFor(30_001);
      expect(selected).toEqual(["check-test", "check-test"]);
      await page.locator(".orb-links > summary").click();
      await page.clock.runFor(30_001);
      expect(selected).toEqual(["check-test", "check-test"]);
    } finally {
      await closeRoutedPage(page);
    }
  });

  it("discards a late check response after collapse and shows diagnostic failures on reopen", async () => {
    const page = await browser.newPage();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let handled = () => {};
    const completed = new Promise<void>((resolve) => {
      handled = resolve;
    });
    let reads = 0;
    await page.route("**/api/v1/orbs/*/links**", async (route) => {
      if (!new URL(route.request().url()).pathname.endsWith("/steps"))
        return route.fulfill({ json: summary });
      reads++;
      if (reads === 1) {
        await gate;
        await route.fulfill({ json: steps("Stale step") });
        handled();
        return;
      }
      return route.fulfill({
        json: { steps: [], githubError: "GitHub: job access denied (HTTP 403)" },
      });
    });
    try {
      await openDrawer(page);
      const check = page.getByRole("row", { name: "tests 2s" });
      const started = page.waitForRequest((request) => request.url().includes("/links/steps?"));
      await check.click();
      await started;
      const cancelled = page.waitForEvent("requestfailed", {
        predicate: (request) => request.url().includes("/links/steps?"),
      });
      await check.click();
      await cancelled;
      release();
      await completed;
      await expectPage(page.getByText("Stale step", { exact: false })).toHaveCount(0);
      await check.click();
      await expectPage(
        page.getByText("GitHub: job access denied (HTTP 403)", { exact: true }),
      ).toBeVisible();
      await expectPage(page.getByText("Stale step", { exact: false })).toHaveCount(0);
      expect(reads).toBe(2);
    } finally {
      release();
      await closeRoutedPage(page);
    }
  });

  it("resets expansion and ignores a held summary when the orb changes", async () => {
    const page = await browser.newPage();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let handled = () => {};
    const completed = new Promise<void>((resolve) => {
      handled = resolve;
    });
    await page.route("**/api/v1/orbs/*/links", async (route) => {
      if (route.request().url().includes("/first/")) {
        await gate;
        await route.fulfill({ json: summary });
        handled();
        return;
      }
      return route.fulfill({ json: { ...summary, githubError: null, items: [] } });
    });
    try {
      const started = page.waitForRequest("**/api/v1/orbs/first/links");
      await page.goto(`${origin}/__orb-links`);
      await started;
      const next = page.waitForResponse("**/api/v1/orbs/second/links");
      await page.getByRole("button", { name: "Switch orb" }).click();
      await next;
      release();
      await completed;
      await expectPage(page.locator(".orb-links")).toHaveCount(0);
      await expectPage(page.getByText("Accessible pull request")).toHaveCount(0);
    } finally {
      release();
      await closeRoutedPage(page);
    }
  });
});
