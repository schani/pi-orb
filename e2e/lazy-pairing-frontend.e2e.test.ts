import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium, expect, webkit } from "@playwright/test";
import { createServer } from "vite";
import { it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";
import { gotoFrontendHistory } from "./testkit/frontend-fixture.ts";

const ORB = "frontend-lazy-details";

it.each(["chromium", "webkit"] as const)(
  "%s: open running tool binds committed detail across notice and alert",
  async (engine) => {
    const root = join(import.meta.dirname, "../apps/web");
    const cacheDir = await mkdtemp(join(tmpdir(), `pi-orb-pair-${engine}-`));
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
      const page = await browser.newPage();
      const origin = `http://127.0.0.1:${address.port}`;
      const detailRequests: string[] = [];
      const frames: string[] = [];
      page.on("request", (request) => {
        if (request.url().includes(`/api/v1/orbs/${ORB}/details/`))
          detailRequests.push(request.url());
      });
      page.on("websocket", (socket) => {
        if (socket.url().endsWith(`/orbs/${ORB}/live`)) {
          socket.on("framereceived", ({ payload }) => {
            if (typeof payload === "string") frames.push(payload);
          });
        }
      });
      try {
        await gotoFrontendHistory(page, `${origin}/orbs/${ORB}`, ORB);
        const composer = page.getByRole("textbox", { name: "Message the orb", exact: true });
        await composer.fill("LAZY_TOOL_PAIR_HOLD");
        await composer.press("Control+Enter");
        const category = page.locator("details.activity-rail-row.tool-activity-category").filter({
          has: page.locator('.activity-rail-headline[title="paired-tool.txt"]'),
        });
        await expect(category).toHaveCount(1);
        await expect(page.locator(".alert-band")).toContainText("Interposed tool alert");
        await expect(page.locator(".record-custom")).toContainText("Interposed tool notice");
        await category.locator(":scope > summary").click();
        await expect(category.locator("details")).toHaveCount(0);
        const call = category.locator(".tool-call-output");
        await expect(call).toContainText("running tool 1");
        const release = await page.request.post(
          `${origin}/api/v1/orbs/${ORB}/fixture-lazy-release`,
        );
        expect(release.status()).toBe(200);
        const { recordId, operationId } = (await release.json()) as {
          recordId: string;
          operationId: string;
        };
        await expect(call).toContainText("final paired tool detail");
        await expect(call).not.toContainText("running tool 1");
        await expect(category).toHaveClass(/activity-rail-row-completed/);
        const committedPath = `/api/v1/orbs/${ORB}/details/${recordId}/${recordId}%3A0`;
        expect(detailRequests.some((url) => new URL(url).pathname === committedPath)).toBe(true);
        expect(
          detailRequests.some(
            (url) =>
              new URL(url).pathname ===
              `/api/v1/orbs/${ORB}/details/live/${operationId}/${operationId}-tool`,
          ),
        ).toBe(true);
        expect(frames.join("\n")).not.toContain("final paired tool detail");
      } finally {
        await page.close();
      }
    } finally {
      await browser?.close();
      await vite.close();
      await rm(cacheDir, { recursive: true, force: true });
    }
  },
);
