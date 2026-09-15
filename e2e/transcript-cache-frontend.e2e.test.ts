import { join } from "node:path";
import { expect as check, chromium, webkit } from "@playwright/test";
import { createServer } from "vite";
import { it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";

it.each(["chromium", "webkit"] as const)(
  "%s: running A→B→A uses parsed cache and actual delta hello",
  async (engine) => {
    const root = join(import.meta.dirname, "../apps/web");
    const vite = await createServer({
      root,
      configFile: join(root, "vite.config.ts"),
      mode: "frontend",
      server: { host: "127.0.0.1", port: 0 },
    });
    await listenFrontend(vite);
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("No fixture port");
    const browser = await (engine === "chromium" ? chromium : webkit).launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const origin = `http://127.0.0.1:${address.port}`;
    const a = "frontend-long-history",
      b = "frontend-fixture-orb";
    let forbidHistory = false,
      unexpectedHistory = 0,
      historyReads = 0;
    let lastRecord: string | null = null;
    const hellos: (string | null)[] = [];
    const committedReplies: string[] = [];
    try {
      await page.route(`**/orbs/${a}/history`, async (route) => {
        historyReads++;
        if (forbidHistory) {
          unexpectedHistory++;
          return route.abort();
        }
        const response = await route.fetch();
        const view = await response.json();
        // Large lossless payloads exercise real JSON processing without adding UI rows.
        for (const record of view.records) record.overflow.cacheFixture = "x".repeat(128 * 1024);
        lastRecord = view.cursor;
        return route.fulfill({ response, json: view });
      });
      await page.route(`**/orbs/${b}/history`, async (route) => {
        const response = await route.fetch();
        const view = await response.json();
        view.records[0].overflow.cacheFixture = "y".repeat(6 * 1024 * 1024);
        return route.fulfill({ response, json: view });
      });
      await page.routeWebSocket(`**/orbs/${a}/live`, (socket) => {
        const server = socket.connectToServer();
        socket.onMessage((message) => {
          const frame = JSON.parse(String(message));
          if (frame.type === "client.hello") hellos.push(frame.afterRecordId);
          server.send(message);
        });
        server.onMessage((message) => {
          const frame = JSON.parse(String(message));
          if (frame.type === "history.record") {
            lastRecord = frame.record.id;
            if (frame.record.role === "assistant")
              committedReplies.push(JSON.stringify(frame.record.content));
          }
          socket.send(message);
        });
      });
      await page.goto(`${origin}/#/orbs/${a}`);
      const ready = page.getByRole("button", { name: "Change thinking", exact: true });
      await check(ready).toBeEnabled();
      await check(page.locator(".history")).toContainText("Review 100");
      const composer = page.getByRole("textbox", { name: "Message the orb", exact: true });
      await composer.fill("cache a completed live record");
      await composer.press("Control+Enter");
      await check(page.locator(".history .rec-orb").last()).toContainText(
        "cache a completed live record",
      );
      await check
        .poll(() => committedReplies.some((text) => text.includes("cache a completed live record")))
        .toBe(true);
      await check(page.locator(".history .cur")).toHaveCount(0);
      await composer.fill("retain cache draft");
      await page.locator(`.orb-index a[href="#/orbs/${b}"]`).click();
      await check(page.locator(".orb-name")).toHaveText("Frontend Playground");
      await check(ready).toBeEnabled();
      const expectedCursor = lastRecord;
      hellos.length = 0;
      forbidHistory = true;
      let releaseMetadata = () => {},
        metadataArrived = () => {};
      const metadataGate = new Promise<void>((resolve) => {
        releaseMetadata = resolve;
      });
      const metadataRequested = new Promise<void>((resolve) => {
        metadataArrived = resolve;
      });
      const metadataPath = `**/api/v1/orbs/${a}`;
      await page.route(metadataPath, async (route) => {
        metadataArrived();
        await metadataGate;
        return route.continue();
      });
      await page.locator(`.orb-index a[href="#/orbs/${a}"]`).click();
      await metadataRequested;
      try {
        await check(page.locator(".orb-name")).toHaveText("Frontend Playground");
        await check(page.locator(".orb-main")).toHaveAttribute("inert", "");
      } finally {
        releaseMetadata();
      }
      await page.unroute(metadataPath);
      await check(page.locator(".history")).toContainText("Review 100");
      await check(ready).toBeEnabled();
      await check(composer).toHaveValue("retain cache draft");
      await check(page.locator(".history")).toContainText("cache a completed live record");
      check(unexpectedHistory).toBe(0);
      check(hellos.length).toBeGreaterThan(0);
      check(hellos.every((cursor) => cursor === expectedCursor)).toBe(true);
      // The cached view still owns a normal live session and can send.
      await composer.press("Control+Enter");
      await check(page.locator(".history .rec-orb").last()).toContainText("retain cache draft");
      await check
        .poll(() => committedReplies.some((text) => text.includes("retain cache draft")))
        .toBe(true);
      await check(page.locator(".history .cur")).toHaveCount(0);
      check(unexpectedHistory).toBe(0);
      // The app-owned cache survives dashboard navigation, including the phone layout.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("link", { name: "Dashboard", exact: true }).click();
      await page
        .getByRole("link", { name: "Long history · typing performance", exact: true })
        .click();
      await check(page.locator(".history .rec-orb").last()).toContainText("retain cache draft");
      await check(
        page.getByRole("button", { name: "Change thinking", exact: true, includeHidden: true }),
      ).toBeEnabled();
      await check(page.locator(".composer-input")).not.toBeFocused();
      check(unexpectedHistory).toBe(0);
      // Reload is explicitly a miss; no browser persistence is introduced.
      forbidHistory = false;
      const beforeReload = historyReads;
      await page.reload();
      await check(
        page.getByRole("button", { name: "Change thinking", exact: true, includeHidden: true }),
      ).toBeEnabled();
      check(historyReads).toBeGreaterThan(beforeReload);
      // Three other conversations evict A. A new cold read must still work normally.
      for (const [id, name] of [
        [b, "Frontend Playground"],
        ["frontend-editor-shortcuts", "Editor shortcuts"],
        ["frontend-backup-check", "Backup verification"],
      ]) {
        await page.locator("body").evaluate((node, orbId) => {
          node.ownerDocument.location.hash = `/orbs/${orbId}`;
        }, id);
        await check(page.locator(".orb-name")).toHaveText(name ?? "");
      }
      const beforeEvictionReturn = historyReads;
      await page.locator("body").evaluate((node, orbId) => {
        node.ownerDocument.location.hash = `/orbs/${orbId}`;
      }, a);
      await check(
        page.getByRole("button", { name: "Change thinking", exact: true, includeHidden: true }),
      ).toBeEnabled();
      check(historyReads).toBeGreaterThan(beforeEvictionReturn);
    } finally {
      await page.close();
      await browser.close();
      await vite.close();
    }
  },
);
