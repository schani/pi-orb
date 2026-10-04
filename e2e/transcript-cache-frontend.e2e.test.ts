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
    const mutations: string[] = [];
    let heldMetadata = false;
    page.on("request", (request) => {
      if (heldMetadata && request.method() !== "GET" && request.url().includes(`/orbs/${a}/`))
        mutations.push(`${request.method()} ${new URL(request.url()).pathname}`);
    });
    const terminalConnections: string[] = [];
    page.on("websocket", (socket) => {
      if (heldMetadata && socket.url().endsWith(`/orbs/${a}/terminal`))
        terminalConnections.push(socket.url());
    });
    // Readiness assertions follow the frame that supplies settings, not large-history wall time.
    const settingsWaiters: (() => void)[] = [];
    const nextSettings = () => new Promise<void>((resolve) => settingsWaiters.push(resolve));
    try {
      await page.route(`**/orbs/${a}/history`, async (route) => {
        historyReads++;
        if (forbidHistory) {
          unexpectedHistory++;
          return route.abort();
        }
        const response = await route.fetch();
        const view = await response.json();
        // Browser history is the compact display projection, never the native transcript.
        check(JSON.stringify(view)).not.toContain('"overflow"');
        lastRecord = view.cursor;
        return route.fulfill({ response, json: view });
      });
      await page.route(`**/orbs/${b}/history`, async (route) => {
        const response = await route.fetch();
        const view = await response.json();
        check(JSON.stringify(view)).not.toContain('"overflow"');
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
          if (frame.type === "runtime.event" && frame.event.type === "agent_settings")
            settingsWaiters.shift()?.();
          if (frame.type === "history.record") {
            lastRecord = frame.record.id;
            if (frame.record.role === "assistant")
              committedReplies.push(JSON.stringify(frame.record.content));
          }
          socket.send(message);
        });
      });
      const initialSettings = nextSettings();
      await page.goto(`${origin}/orbs/${a}`);
      const ready = page.getByRole("button", { name: "Change thinking", exact: true });
      await initialSettings;
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
      await check(page.locator(".history .bit-register")).toHaveCount(0);
      await composer.fill("retain cache draft");
      await page.locator(`.orb-index a[href="/orbs/${b}"]`).click();
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
      heldMetadata = true;
      let metadataDrained = () => {};
      const metadataFinished = new Promise<void>((resolve) => {
        metadataDrained = resolve;
      });
      await page.route(metadataPath, async (route) => {
        metadataArrived();
        await metadataGate;
        try {
          return await route.continue();
        } finally {
          metadataDrained();
        }
      });
      const cachedSettings = nextSettings();
      await page.locator(`.orb-index a[href="/orbs/${a}"]`).click();
      await metadataRequested;
      const history = page.locator(".history");
      const scroller = page.locator(".orb-transcript-scroll");
      let mounted: Awaited<ReturnType<typeof history.elementHandle>> | null = null;
      let heldScroll = 0;
      try {
        await check(history).toContainText("cache a completed live record");
        await check(history).not.toContainText("Use this orb to check");
        await check(page.locator(".orb-main")).not.toHaveAttribute("inert", "");
        await check(composer).toBeEditable();
        await check(composer).toHaveValue("retain cache draft");
        await composer.fill("draft typed before metadata");
        await composer.press("Control+Enter");
        await check(
          page.getByRole("button", { name: "Send message", exact: true, includeHidden: true }),
        ).toBeDisabled();
        for (const name of ["Rename orb", "Archive orb", "Delete orb", "Change model"]) {
          await check(page.getByRole("button", { name, exact: true })).toBeDisabled();
        }
        await check(
          page.getByRole("button", { name: "Open terminal", exact: true, includeHidden: true }),
        ).toHaveCount(0);
        await composer.press("Control+j");
        await check(
          page.getByRole("button", { name: "Upload files", exact: true, includeHidden: true }),
        ).toHaveCount(0);
        await page.locator(".orb-main").evaluate((node) => {
          const browser = globalThis as unknown as {
            DataTransfer: new () => { items: { add(file: File): void } };
            DragEvent: new (
              type: string,
              options: { bubbles: boolean; cancelable: boolean; dataTransfer: unknown },
            ) => Event;
          };
          const transfer = new browser.DataTransfer();
          transfer.items.add(
            new File(["cached navigation upload"], "cached.txt", { type: "text/plain" }),
          );
          node.dispatchEvent(
            new browser.DragEvent("drop", {
              bubbles: true,
              cancelable: true,
              dataTransfer: transfer,
            }),
          );
        });
        await check(page.getByRole("button", { name: /^(Start|Stop) orb$/ })).toHaveCount(0);
        await check(ready).toBeDisabled();
        check(hellos).toEqual([]);
        check(mutations).toEqual([]);
        check(terminalConnections).toEqual([]);
        check(unexpectedHistory).toBe(0);
        await scroller.evaluate((pane) => {
          pane.scrollTop -= 120;
        });
        await page.evaluate(
          "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
        );
        heldScroll = await scroller.evaluate((pane) => pane.scrollTop);
        mounted = await history.elementHandle();
      } finally {
        heldMetadata = false;
        releaseMetadata();
        await metadataFinished;
      }
      await page.unroute(metadataPath);
      await cachedSettings;
      if (!mounted) throw new Error("Cached transcript was not mounted");
      check(
        await mounted.evaluate((node) => node === node.ownerDocument.querySelector(".history")),
      ).toBe(true);
      check(await scroller.evaluate((pane) => pane.scrollTop)).toBe(heldScroll);
      await check(page.locator(".history")).toContainText("Review 100");
      await check(ready).toBeEnabled();
      await check(composer).toHaveValue("draft typed before metadata");
      await check(page.locator(".history")).toContainText("cache a completed live record");
      await composer.fill("retain cache draft");
      check(unexpectedHistory).toBe(0);
      check(hellos.length).toBeGreaterThan(0);
      check(hellos.every((cursor) => cursor === expectedCursor)).toBe(true);
      // The cached view still owns a normal live session and can send.
      await composer.press("Control+Enter");
      await check(page.locator(".history .rec-orb").last()).toContainText("retain cache draft");
      await check
        .poll(() => committedReplies.some((text) => text.includes("retain cache draft")))
        .toBe(true);
      await check(page.locator(".history .bit-register")).toHaveCount(0);
      check(unexpectedHistory).toBe(0);
      // The app-owned cache survives dashboard navigation, including the phone layout.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("link", { name: "Dashboard", exact: true }).click();
      const dashboardSettings = nextSettings();
      await page
        .getByRole("link", { name: "Long history · typing performance", exact: true })
        .click();
      await dashboardSettings;
      await check(page.locator(".history .rec-orb").last()).toContainText("retain cache draft");
      await check(
        page.getByRole("button", { name: "Change thinking", exact: true, includeHidden: true }),
      ).toBeEnabled();
      await check(page.locator(".composer-input")).not.toBeFocused();
      check(unexpectedHistory).toBe(0);
      // Reload is explicitly a miss; no browser persistence is introduced.
      forbidHistory = false;
      const beforeReload = historyReads;
      const reloadedSettings = nextSettings();
      await page.reload();
      await reloadedSettings;
      await check(
        page.getByRole("button", { name: "Change thinking", exact: true, includeHidden: true }),
      ).toBeEnabled();
      check(historyReads).toBeGreaterThan(beforeReload);
      // Three other small conversations do not evict A under the byte budget.
      for (const [id, name] of [
        [b, "Frontend Playground"],
        ["frontend-editor-shortcuts", "Editor shortcuts"],
        ["frontend-backup-check", "Backup verification"],
      ]) {
        await page.locator("body").evaluate((node, orbId) => {
          node.ownerDocument.defaultView!.history.pushState(null, "", `/orbs/${orbId}`);
          node.ownerDocument.defaultView!.dispatchEvent(new Event("pi-orb:navigate"));
        }, id);
        await check(page.locator(".orb-name")).toHaveText(name ?? "");
      }
      const beforeReturn = historyReads;
      forbidHistory = true;
      const cachedReturnSettings = nextSettings();
      await page.locator("body").evaluate((node, orbId) => {
        node.ownerDocument.defaultView!.history.pushState(null, "", `/orbs/${orbId}`);
        node.ownerDocument.defaultView!.dispatchEvent(new Event("pi-orb:navigate"));
      }, a);
      await cachedReturnSettings;
      await check(
        page.getByRole("button", { name: "Change thinking", exact: true, includeHidden: true }),
      ).toBeEnabled();
      check(historyReads).toBe(beforeReturn);
      check(unexpectedHistory).toBe(0);
    } finally {
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
      await browser.close();
      await vite.close();
    }
  },
);
