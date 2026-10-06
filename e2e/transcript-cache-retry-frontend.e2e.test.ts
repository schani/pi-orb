import { join } from "node:path";
import { chromium, expect, webkit } from "@playwright/test";
import { createServer } from "vite";
import { it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";
import { gotoFrontendHistory } from "./testkit/frontend-fixture.ts";

function barrier() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it.each(["chromium", "webkit"] as const)(
  "%s: cached metadata Retry retains the reader and draft, reconnects, and ignores obsolete navigation",
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
    const b = "frontend-fixture-orb";
    const failure = barrier();
    const failureArrived = barrier();
    const retry = barrier();
    const retryArrived = barrier();
    const stale = barrier();
    const staleArrived = barrier();
    const staleDrained = barrier();
    let mode: "normal" | "failure" | "retry" | "stale" = "normal";
    let historyReads = 0;
    const hellos: (string | null)[] = [];
    let cursor: string | null = null;
    let settings = barrier();
    try {
      await page.route(`**/orbs/${a}/history`, async (route) => {
        historyReads++;
        const response = await route.fetch();
        cursor = (await response.json()).cursor;
        await route.fulfill({ response });
      });
      await page.route(`**/api/v1/orbs/${a}`, async (route) => {
        const requestMode = mode;
        if (requestMode === "failure") {
          failureArrived.release();
          await failure.promise;
          await route.fulfill({
            status: 503,
            json: {
              error: { code: "unavailable", message: "Metadata unavailable", retryable: true },
            },
          });
        } else if (requestMode === "stale") {
          staleArrived.release();
          await stale.promise;
          try {
            await route.fulfill({
              status: 404,
              json: {
                error: { code: "not_found", message: "Orb doesn't exist", retryable: false },
              },
            });
          } finally {
            staleDrained.release();
          }
        } else {
          const response = await route.fetch();
          if (requestMode === "retry") {
            retryArrived.release();
            await retry.promise;
          }
          await route.fulfill({ response });
        }
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
          if (frame.type === "runtime.event" && frame.event.type === "agent_settings")
            settings.release();
          socket.send(message);
        });
      });
      const history = page.locator(".history");
      const pane = page.locator(".orb-transcript-scroll");
      const composer = page.getByRole("textbox", { name: "Message the orb", exact: true });
      const ready = page.getByRole("button", { name: "Change thinking", exact: true });
      const send = page.getByRole("button", {
        name: "Send message",
        exact: true,
        includeHidden: true,
      });
      const layout = () =>
        page.evaluate(
          "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
        );
      await gotoFrontendHistory(page, `${origin}/orbs/${a}`, a, composer);
      await settings.promise;
      await expect(ready).toBeEnabled();
      await composer.fill("draft before metadata failure");
      await page.locator(`.orb-index a[href="/orbs/${b}"]`).click();
      await expect(page.locator(".orb-name")).toHaveText("Frontend Playground");
      await expect(ready).toBeEnabled();
      const admissions = () =>
        page.evaluate((orbId) => {
          const debug = globalThis as typeof globalThis & {
            piOrbDebug: {
              dump(): { trace: { event: string; orbId?: string; outcome?: string }[] };
            };
          };
          return debug.piOrbDebug
            .dump()
            .trace.filter(
              (entry) =>
                entry.event === "cache" && entry.orbId === orbId && entry.outcome === "stored",
            ).length;
        }, a);
      const stored = await admissions();
      expect(stored).toBeGreaterThan(0);
      const reads = historyReads;
      hellos.length = 0;
      mode = "failure";
      await page.locator(`.orb-index a[href="/orbs/${a}"]`).click();
      await failureArrived.promise;
      await expect(history).toContainText("Review 100");
      await expect(composer).toBeEditable();
      await expect(composer).toHaveValue("draft before metadata failure");
      await composer.fill("draft edited through metadata Retry");
      await pane.evaluate((node) => {
        node.scrollTop -= 120;
      });
      await layout();
      const mounted = await history.elementHandle();
      const row = await history.locator(".rec").last().elementHandle();
      failure.release();
      const retryButton = page.getByRole("button", { name: "Retry", exact: true });
      await expect(retryButton).toBeVisible();
      await expect(history).toContainText("Review 100");
      await expect(composer).toBeEditable();
      await expect(send).toBeDisabled();
      await expect(ready).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Change model", exact: true })).toHaveCount(0);
      await composer.press("Control+Enter");
      await expect(composer).toHaveValue("draft edited through metadata Retry");
      expect(hellos).toEqual([]);
      expect(historyReads).toBe(reads);
      expect(await admissions()).toBe(stored);
      mode = "retry";
      settings = barrier();
      await retryButton.click();
      await retryArrived.promise;
      await layout();
      // Native activation reveals the notice; metadata completion must retain that position.
      const scroll = await pane.evaluate((node) => node.scrollTop);
      expect(
        await mounted.evaluate((node) => node === node.ownerDocument.querySelector(".history")),
      ).toBe(true);
      expect(await row.evaluate((node) => node.isConnected)).toBe(true);
      expect(await pane.evaluate((node) => node.scrollTop)).toBe(scroll);
      await expect(composer).toHaveValue("draft edited through metadata Retry");
      expect(hellos).toEqual([]);
      mode = "normal";
      retry.release();
      await settings.promise;
      await expect(ready).toBeEnabled();
      await expect(retryButton).toHaveCount(0);
      expect(
        await mounted.evaluate((node) => node === node.ownerDocument.querySelector(".history")),
      ).toBe(true);
      expect(await row.evaluate((node) => node.isConnected)).toBe(true);
      expect(await pane.evaluate((node) => node.scrollTop)).toBe(scroll);
      await expect(composer).toHaveValue("draft edited through metadata Retry");
      expect(hellos).toEqual([cursor]);
      expect(historyReads).toBe(reads);
      // Publishing again proves the completed resource acquired cache ownership.
      await expect.poll(admissions).toBeGreaterThan(stored);
      await composer.press("Control+Enter");
      await expect(history.locator(".rec-orb").last()).toContainText(
        "draft edited through metadata Retry",
      );
      await expect(history.locator(".bit-register")).toHaveCount(0);

      // Retiring the cached selection also retires its held metadata completion.
      await page.locator(`.orb-index a[href="/orbs/${b}"]`).click();
      await expect(page.locator(".orb-name")).toHaveText("Frontend Playground");
      await expect(ready).toBeEnabled();
      mode = "stale";
      await page.locator(`.orb-index a[href="/orbs/${a}"]`).click();
      await staleArrived.promise;
      await expect(history).toContainText("draft edited through metadata Retry");
      await page.locator(`.orb-index a[href="/orbs/${b}"]`).click();
      await expect(page.locator(".orb-name")).toHaveText("Frontend Playground");
      await expect(ready).toBeEnabled();
      await composer.fill("new resource owns this draft");
      const current = await history.elementHandle();
      stale.release();
      await staleDrained.promise;
      await page.unrouteAll({ behavior: "wait" });
      await layout();
      await expect(page).toHaveURL(`${origin}/orbs/${b}`);
      await expect(page.locator(".orb-name")).toHaveText("Frontend Playground");
      await expect(composer).toHaveValue("new resource owns this draft");
      await expect(page.getByText("Orb doesn't exist", { exact: true })).toHaveCount(0);
      expect(
        await current.evaluate((node) => node === node.ownerDocument.querySelector(".history")),
      ).toBe(true);
    } finally {
      failure.release();
      retry.release();
      stale.release();
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
      await browser.close();
      await vite.close();
    }
  },
);
