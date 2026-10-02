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
  "%s: open reasoning polls once at a time and a late running response cannot replace final detail",
  async (engine) => {
    const root = join(import.meta.dirname, "../apps/web");
    const cacheDir = await mkdtemp(join(tmpdir(), `pi-orb-running-${engine}-`));
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
      await page.clock.install();
      const origin = `http://127.0.0.1:${address.port}`;
      let syncs = 0;
      let operationId = "";
      let blockId = "";
      let liveReads = 0;
      let releaseHeld!: () => void;
      const held = new Promise<void>((resolve) => {
        releaseHeld = resolve;
      });
      let heldRequest!: () => void;
      const secondRequested = new Promise<void>((resolve) => {
        heldRequest = resolve;
      });
      const frames: string[] = [];
      page.on("websocket", (socket) => {
        if (!socket.url().endsWith(`/orbs/${ORB}/live`)) return;
        socket.on("framereceived", ({ payload }) => {
          if (typeof payload !== "string") return;
          frames.push(payload);
          const frame = JSON.parse(payload);
          if (frame.type === "sync.completed") syncs++;
          if (
            frame.type === "runtime.event" &&
            frame.event?.type === "output_patch" &&
            frame.event?.blockType === "reasoning"
          ) {
            operationId = frame.event.operationId;
            blockId = frame.event.blockId;
          }
        });
      });
      await page.route(`**/api/v1/orbs/${ORB}/details/live/**`, async (route) => {
        const url = new URL(route.request().url());
        expect(url.searchParams.get("sessionId")).toBe(`fixture-session-${ORB}`);
        liveReads++;
        const response = await route.fetch();
        const body = await response.text();
        if (liveReads === 2) {
          heldRequest();
          await held;
        }
        await route.fulfill({ response, body });
      });
      try {
        await gotoFrontendHistory(page, `${origin}/#/orbs/${ORB}`, ORB);
        await expect.poll(() => syncs).toBeGreaterThanOrEqual(1);
        const composer = page.getByRole("textbox", {
          name: "Message the orb",
          exact: true,
        });
        await composer.fill("LAZY_RUNNING_HOLD");
        await composer.press("Control+Enter");
        await expect.poll(() => blockId).not.toBe("");
        const live = page.locator("details.activity-rail-row.reasoning").last();
        await expect(live).toBeVisible();
        await live.locator(":scope > summary").click();
        await expect(live.locator(".reasoning-body")).toContainText("running reasoning 1");
        expect(liveReads).toBe(1);
        await page.clock.runFor(1100);
        await secondRequested;
        await page.clock.runFor(3100);
        expect(liveReads, "held snapshot must not permit overlapping reads").toBe(2);
        await live.locator(":scope > summary").click();
        await page.clock.runFor(2100);
        expect(liveReads, "closed disclosure must stop refresh").toBe(2);
        await live.locator(":scope > summary").click();
        await expect(live.locator(".reasoning-body")).toBeVisible();
        expect(liveReads, "reopen coalesces the pending snapshot").toBe(2);
        expect(frames.join("\n")).not.toContain("running reasoning 1");
        expect(frames.join("\n")).not.toContain("running reasoning 2");
        const release = await page.request.post(
          `${origin}/api/v1/orbs/${ORB}/fixture-lazy-release`,
        );
        expect(release.status()).toBe(200);
        await expect(page.locator(".history")).toContainText("Lazy operation complete.");
        const final = page.locator("details.activity-rail-row.reasoning").last();
        await expect(final.locator(".reasoning-body")).toContainText("final reasoning");
        const lateResponse = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname ===
            `/api/v1/orbs/${ORB}/details/live/${operationId}/${blockId}`,
        );
        releaseHeld();
        await lateResponse;
        await expect(final.locator(".reasoning-body")).toContainText("final reasoning");
        await page.clock.runFor(2100);
        expect(liveReads).toBe(2);
        // Closing the committed disclosure and reopening uses the cached final detail.
        await final.locator(":scope > summary").click();
        await final.locator(":scope > summary").click();
        await expect(final.locator(".reasoning-body")).toContainText("final reasoning");
        expect(operationId).not.toBe("");
      } finally {
        releaseHeld();
        await page.close();
      }
    } finally {
      await browser?.close();
      await vite.close();
      await rm(cacheDir, { recursive: true, force: true });
    }
  },
);
