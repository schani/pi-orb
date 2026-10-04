import { join } from "node:path";
import { chromium, expect, webkit } from "@playwright/test";
import { createServer } from "vite";
import { it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";
import { gotoFrontendHistory } from "./testkit/frontend-fixture.ts";

it.each(["chromium", "webkit"] as const)(
  "%s: cancelling cold navigation preserves the mounted conversation and live connection",
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
    const a = "frontend-long-history";
    const b = "frontend-editor-shortcuts";
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrived = () => {};
    const metadataRequested = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    let hellos = 0;
    let connections = 0;
    let closes = 0;
    let historyReads = 0;
    const heldPaths: string[] = [];
    page.on("websocket", (socket) => {
      if (!socket.url().endsWith(`/orbs/${a}/live`)) return;
      connections++;
      socket.on("close", () => {
        closes++;
      });
    });
    try {
      await page.routeWebSocket(`**/orbs/${a}/live`, (socket) => {
        const server = socket.connectToServer();
        socket.onMessage((message) => {
          if (JSON.parse(String(message)).type === "client.hello") hellos++;
          server.send(message);
        });
        server.onMessage((message) => socket.send(message));
      });
      await page.route(`**/api/v1/orbs/${a}/history`, async (route) => {
        historyReads++;
        await route.continue();
      });
      // Both cold reads are owned. History may not begin until metadata completes.
      for (const suffix of ["", "/history"]) {
        await page.route(`**/api/v1/orbs/${b}${suffix}`, async (route) => {
          heldPaths.push(new URL(route.request().url()).pathname);
          const response = await route.fetch();
          if (suffix === "") arrived();
          await gate;
          await route.fulfill({ response });
        });
      }
      const history = page.locator(".history");
      const pane = page.locator(".orb-transcript-scroll");
      const composer = page.getByRole("textbox", { name: "Message the orb", exact: true });
      const ready = page.getByRole("button", { name: "Change thinking", exact: true });
      const layout = () =>
        page.evaluate(
          "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
        );
      await gotoFrontendHistory(page, `${origin}/orbs/${a}`, a, composer);
      await expect(ready).toBeEnabled();
      await expect(history).toContainText("Review 100");
      await expect.poll(() => hellos).toBe(1);
      await composer.fill("draft survives cancelled cold navigation");
      await pane.evaluate((node) => {
        node.scrollTop = 200;
      });
      await layout();
      const mounted = await history.elementHandle();
      const row = await history.locator(".rec").last().elementHandle();
      const scroll = await pane.evaluate((node) => node.scrollTop);
      const original = { hellos, connections, closes, historyReads };

      await page.locator(`.orb-index a[href="/orbs/${b}"]`).click();
      await metadataRequested;
      await expect(page).toHaveURL(`${origin}/orbs/${b}`);
      expect(await mounted.evaluate((node) => node.isConnected)).toBe(true);
      await page.locator(`.orb-index a[href="/orbs/${a}"]`).click();
      await expect(page).toHaveURL(`${origin}/orbs/${a}`);
      await expect(ready).toBeEnabled();
      await expect(composer).toHaveValue("draft survives cancelled cold navigation");
      await layout();
      expect(
        await mounted.evaluate((node) => node === node.ownerDocument.querySelector(".history")),
      ).toBe(true);
      expect(await row.evaluate((node) => node.isConnected)).toBe(true);
      expect(await pane.evaluate((node) => node.scrollTop)).toBe(scroll);
      expect({ hellos, connections, closes, historyReads }).toEqual(original);

      // Drain stale responses before checking that they cannot take navigation authority.
      release();
      await page.unrouteAll({ behavior: "wait" });
      await layout();
      await expect(page).toHaveURL(`${origin}/orbs/${a}`);
      await expect(page.locator(".orb-name")).toHaveText("Long history · typing performance");
      await expect(composer).toHaveValue("draft survives cancelled cold navigation");
      expect(
        await mounted.evaluate((node) => node === node.ownerDocument.querySelector(".history")),
      ).toBe(true);
      expect(await row.evaluate((node) => node.isConnected)).toBe(true);
      expect(await pane.evaluate((node) => node.scrollTop)).toBe(scroll);
      expect({ hellos, connections, closes, historyReads }).toEqual(original);
      expect(heldPaths).toContain(`/api/v1/orbs/${b}`);
    } finally {
      release();
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
      await browser.close();
      await vite.close();
    }
  },
);
