import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HistoryRecord, projectDisplayRecord } from "@pi-orb/protocol";
import { type Browser, chromium, expect } from "@playwright/test";
import { createServer } from "vite";
import { it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";
import { gotoFrontendHistory } from "./testkit/frontend-fixture.ts";

const orbId = "frontend-lazy-details";
const command = `printf '${"x".repeat(1150)}CANARY_AFTER_1K'`;

it("fetches the full bash command only when its call opens", async () => {
  const root = join(import.meta.dirname, "../apps/web");
  const cacheDir = await mkdtemp(join(tmpdir(), "pi-orb-lazy-command-"));
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
    browser = await chromium.launch({
      ...(process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"] || existsSync("/usr/bin/chromium")
        ? { executablePath: process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"] ?? "/usr/bin/chromium" }
        : {}),
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage();
    const origin = `http://127.0.0.1:${address.port}`;
    let reads = 0;
    const raw: HistoryRecord[] = [
      {
        id: "review-command",
        parentId: null,
        timestamp: "2026-01-01T00:00:00Z",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "tool_call",
            callId: "review-bash",
            name: "bash",
            arguments: { command, timeout: 1000 },
          },
        ],
        overflow: {},
      },
      {
        id: "review-result",
        parentId: "review-command",
        timestamp: "2026-01-01T00:00:01Z",
        type: "message",
        role: "tool",
        content: [
          { type: "tool_result", callId: "review-bash", content: [{ type: "text", text: "done" }] },
        ],
        overflow: {},
      },
    ];
    await page.route(`**/api/v1/orbs/${orbId}/history`, async (route) => {
      const response = await route.fetch();
      const view = await response.json();
      view.records.push(...raw.map(projectDisplayRecord));
      await route.fulfill({ response, json: view });
    });
    await page.route(`**/api/v1/orbs/${orbId}/details/**`, async (route) => {
      const url = new URL(route.request().url());
      const match = url.pathname.match(/\/details\/(review-command|review-result)\/([^/]+)$/);
      if (!match) return route.continue();
      reads++;
      const recordId = match[1];
      const detailKey = decodeURIComponent(match[2] ?? "");
      await route.fulfill({
        json: {
          v: 1,
          sessionId: url.searchParams.get("sessionId"),
          recordId,
          detailKey,
          state: "committed",
          body:
            recordId === "review-command"
              ? { type: "tool_call", arguments: { command } }
              : { type: "tool_result", content: [{ type: "text", text: "done" }] },
        },
      });
    });
    try {
      await gotoFrontendHistory(page, `${origin}/orbs/${orbId}`, orbId);
      const commands = page
        .locator("details.tool-activity-category")
        .filter({ has: page.locator(":scope > summary", { hasText: "commands" }) });
      await expect(commands).toHaveCount(1);
      expect(reads).toBe(0);
      expect(await page.locator(".history").textContent()).not.toContain("CANARY_AFTER_1K");
      await commands.locator(":scope > summary").click();
      expect(reads).toBe(0);
      const call = commands.locator("details.tool-activity-call");
      await expect(call.locator("summary code")).not.toContainText("CANARY_AFTER_1K");
      await call.locator(":scope > summary").click();
      await expect(call.locator(".tool-command-text")).toHaveText(command);
      await expect(call.locator(".tool-call-output")).toContainText("done");
      expect(reads).toBe(2);
      expect(await call.locator(".tool-command").textContent()).not.toContain("timeout");
    } finally {
      await page.close();
    }
  } finally {
    await browser?.close();
    await vite.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
});
