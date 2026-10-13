import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OrbMessageView, ResourceWarning } from "@pi-orb/protocol";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";
import { it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";
import { closeRoutedPage } from "./testkit/close-routed-page.ts";
import { gotoFrontendHistory } from "./testkit/frontend-fixture.ts";

const orbId = "frontend-fixture-orb";
const apiPath = `/api/v1/orbs/${orbId}`;
const failure = "Resource preparation failed";
const path = ".agents/skills/<img src=x onerror=alert(1)>/SKILL.md";
const resourceWarnings: ResourceWarning[] = [{ path, code: "invalid_yaml" }];
// These message IDs are absent from replicated history, including the delivered message.
const messages: OrbMessageView[] = (["queued", "delivering", "delivered"] as const).map(
  (status, index) => ({
    id: `00000000-0000-4000-8000-00000000000${index}`,
    orbId,
    status,
    content: [{ type: "text", text: `Pending ${status} resource request` }],
    createdAt: "2026-10-09T00:00:00.000Z",
    updatedAt: "2026-10-09T00:00:00.000Z",
  }),
);

it("chromium: failed orb blocks pending delivery and retains escaped warnings after reload", async () => {
  const root = join(import.meta.dirname, "../apps/web");
  const cacheDir = await mkdtemp(join(tmpdir(), "resource-warnings-frontend-"));
  const vite = await createServer({
    root,
    cacheDir,
    configFile: join(root, "vite.config.ts"),
    mode: "frontend",
    server: { host: "127.0.0.1", port: 0 },
  });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await listenFrontend(vite);
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("No owned fixture port");
    await page.route(`**${apiPath}`, async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      json.state = "failed";
      json.stateVersion = 2;
      json.activity = "idle";
      json.lastError = failure;
      json.resourceWarnings = resourceWarnings;
      await route.fulfill({ response, json });
    });
    // Reload must obtain diagnostics from GET, not runtime/live events.
    await page.route(`**${apiPath}/messages/poll`, (route) =>
      route.fulfill({ json: { items: messages, updates: [], cursor: 2 } }),
    );
    const main = page.locator(".orb-main");
    const url = `http://127.0.0.1:${address.port}/orbs/${orbId}`;
    for (const phase of ["before-reload", "after-reload"]) {
      const [response] = await Promise.all([
        page.waitForResponse(
          (reply) =>
            reply.request().method() === "GET" && new URL(reply.url()).pathname === apiPath,
        ),
        phase === "before-reload" ? gotoFrontendHistory(page, url, orbId) : page.reload(),
      ]);
      const body = await response.json();
      expect(response.ok()).toBe(true);
      expect(body.state).toBe("failed");
      expect(body.lastError).toBe(failure);
      expect(body.resourceWarnings).toEqual(resourceWarnings);
      await expect(main.locator(".orb-life-word")).toHaveText("failed");
      await expect(main.locator(".orb-life img")).toHaveAttribute("src", "/favicons/failed.svg");
      await expect(main.locator(".orb-life")).not.toContainText("idle");
      await expect(main.locator(".orb-failure-banner")).toHaveText(failure);
      await expect(main.getByText(failure, { exact: true })).toHaveCount(1);
      await expect(main.locator(".busy-indicator")).toHaveCount(0);
      for (const { status } of messages) {
        const row = main.locator(".rec-q", { hasText: `Pending ${status} resource request` });
        await expect(row).toHaveCount(1);
        await expect(row).toBeVisible();
        const label = status === "delivered" ? "delivered" : "blocked";
        await expect(row.locator(".rec-status")).toHaveText(label);
        await expect(row.locator(".error-text")).toHaveCount(0);
      }
      await expect(main.locator(".rec-q")).toHaveCount(3);
      const warningText = `Skipped repository skill ${path}: invalid YAML.`;
      const warning = main.getByText(warningText, { exact: true });
      await expect(warning).toHaveCount(1);
      await expect(warning).toBeVisible();
      await expect(warning.locator("img")).toHaveCount(0);
    }
  } finally {
    await closeRoutedPage(page);
    await browser.close();
    await vite.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
});
