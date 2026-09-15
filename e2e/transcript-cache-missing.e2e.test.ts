import { join } from "node:path";
import { expect as check, chromium, type WebSocket, webkit } from "@playwright/test";
import { createServer } from "vite";
import { it } from "vitest";

it.each(["chromium", "webkit"] as const)(
  "%s: history 404 retires live ownership even when metadata is still running",
  async (engine) => {
    const root = join(import.meta.dirname, "../apps/web");
    const vite = await createServer({
      root,
      configFile: join(root, "vite.config.ts"),
      mode: "frontend",
      server: { host: "127.0.0.1", port: 0 },
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("No fixture port");
    const browser = await (engine === "chromium" ? chromium : webkit).launch();
    const page = await browser.newPage();
    const origin = `http://127.0.0.1:${address.port}`;
    const a = "frontend-long-history",
      b = "frontend-fixture-orb";
    let state = "stopped",
      refresh = false;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sockets = new Set<WebSocket>();
    page.on("websocket", (socket) => {
      if (!socket.url().endsWith(`/orbs/${a}/live`)) return;
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    try {
      await page.route(`**/api/v1/orbs/${a}`, async (route) => {
        const response = await route.fetch();
        return route.fulfill({ response, json: { ...(await response.json()), state } });
      });
      await page.route(`**/orbs/${a}/history`, async (route) => {
        if (!refresh) return route.continue();
        await gate;
        return route.fulfill({
          status: 404,
          json: { error: { code: "not_found", message: "Orb doesn't exist", retryable: false } },
        });
      });
      await page.goto(`${origin}/#/orbs/${a}`);
      await check(page.locator(".history")).toContainText("Review 100");
      await page.locator(`.orb-index a[href="#/orbs/${b}"]`).click();
      await check(page.locator(".orb-name")).toHaveText("Frontend Playground");
      refresh = true;
      await page.locator(`.orb-index a[href="#/orbs/${a}"]`).click();
      await check(page.locator(".history")).toContainText("Review 100");
      // A newer metadata poll starts live synchronization while the older HTTP
      // request is held. Its definitive 404 must still retire all live ownership.
      state = "running";
      await check(page.getByRole("button", { name: "Change thinking", exact: true })).toBeEnabled();
      await check.poll(() => sockets.size).toBe(1);
      release();
      await check(page.getByText("Orb doesn't exist", { exact: true })).toBeVisible();
      await check.poll(() => sockets.size).toBe(0);
      check(page.url()).toBe(`${origin}/#/orbs/${a}`);
    } finally {
      release();
      await page.close();
      await browser.close();
      await vite.close();
    }
  },
);
