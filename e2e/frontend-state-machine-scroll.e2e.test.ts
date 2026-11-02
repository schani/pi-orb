import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Browser, chromium, expect as expectPage, webkit } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";
import { gotoFrontendHistory } from "./testkit/frontend-fixture.ts";
import { waitForFixtureMedia } from "./testkit/media-ready.ts";

const evidence = ".context/state-machine-refactors/scroll-pinning";

describe.each(["chromium", "webkit"] as const)(
  "scroll gesture geometry ownership · %s",
  (engine) => {
    let vite: ViteDevServer;
    let browser: Browser;
    let origin: string;

    beforeAll(async () => {
      const root = join(import.meta.dirname, "../apps/web");
      vite = await createServer({
        root,
        configFile: join(root, "vite.config.ts"),
        mode: "frontend",
        server: { host: "127.0.0.1", port: 0 },
      });
      await listenFrontend(vite);
      const address = vite.httpServer?.address();
      if (!address || typeof address === "string") expectPage(false, "Owned TCP port").toBe(true);
      origin = `http://127.0.0.1:${typeof address === "object" ? address?.port : 0}`;
      const executablePath =
        process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"] ??
        (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
      browser =
        engine === "webkit"
          ? await webkit.launch()
          : await chromium.launch({
              ...(executablePath === undefined ? {} : { executablePath }),
              args: ["--no-sandbox"],
            });
    });

    afterAll(async () => {
      await browser?.close();
      await vite?.close();
    });

    it("retains following when a native stationary pointerup grows layout before window settlement", async () => {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      try {
        await gotoFrontendHistory(
          page,
          `${origin}/orbs/frontend-fixture-orb`,
          "frontend-fixture-orb",
        );
        await waitForFixtureMedia(page);
        await page.evaluate(() =>
          Reflect.get(globalThis, "document").fonts.ready.then(() => undefined),
        );
        const pane = page.locator(".orb-transcript-scroll");
        await expectPage
          .poll(() =>
            pane.evaluate(
              (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
            ),
          )
          .toBeLessThanOrEqual(1);
        // Acknowledge a real browser scroll, leaving no pending tail-write offset.
        await pane.evaluate(async (element) => {
          const move = (top: number) =>
            new Promise<void>((resolve) => {
              element.addEventListener("scroll", () => resolve(), { once: true });
              element.scrollTop = top;
            });
          await move(element.scrollHeight - element.clientHeight - 2);
          await move(element.scrollHeight - element.clientHeight);
        });
        await pane.hover({ position: { x: 8, y: 100 } });
        await pane.evaluate((element) => {
          const view = element.ownerDocument.defaultView;
          const content = element.querySelector(".orb-transcript-content");
          if (!view || !content) throw new Error("Fixture scroll content missing");
          const geometry = () => ({
            top: element.scrollTop,
            height: element.scrollHeight,
            viewport: element.clientHeight,
          });
          const edges: {
            edge: string;
            trusted?: boolean;
            x?: number;
            y?: number;
            top: number;
            height: number;
            viewport: number;
          }[] = [];
          Reflect.set(
            view,
            "nativePointerGrowth",
            new Promise((resolve) => {
              element.addEventListener(
                "pointerdown",
                (event: { isTrusted: boolean; clientX: number; clientY: number }) => {
                  edges.push({
                    edge: "pointerdown",
                    trusted: event.isTrusted,
                    x: event.clientX,
                    y: event.clientY,
                    ...geometry(),
                  });
                },
                { once: true },
              );
              element.addEventListener(
                "pointerup",
                (event: { isTrusted: boolean; clientX: number; clientY: number }) => {
                  const before = geometry();
                  const spacer = element.ownerDocument.createElement("div");
                  spacer.style.height = "800px";
                  content.append(spacer);
                  // Native target bubbling precedes OrbPage's existing window handler.
                  edges.push({
                    edge: "growth-before-window",
                    trusted: event.isTrusted,
                    x: event.clientX,
                    y: event.clientY,
                    ...geometry(),
                  });
                  view.addEventListener(
                    "pointerup",
                    () => {
                      edges.push({ edge: "window-after-owner", ...geometry() });
                    },
                    { once: true },
                  );
                  const observer = new view.ResizeObserver(() => {
                    observer.disconnect();
                    edges.push({ edge: "resize", ...geometry() });
                    view.requestAnimationFrame(() =>
                      resolve({
                        before,
                        edges,
                        after: geometry(),
                        trace: Reflect.get(view, "piOrbDebug")
                          .dump()
                          .trace.filter((entry: { event: string }) => entry.event === "scroll_pin"),
                      }),
                    );
                  });
                  observer.observe(content);
                },
                { once: true },
              );
            }),
          );
        });
        await page.mouse.down();
        await page.mouse.up();
        const result = await page.evaluate(() => Reflect.get(globalThis, "nativePointerGrowth"));
        mkdirSync(evidence, { recursive: true });
        writeFileSync(
          join(evidence, `implementation-${engine}-native-stationary-pointerup.json`),
          JSON.stringify(result, null, 2),
        );
        expectPage(result.edges.map((edge: { edge: string }) => edge.edge)).toEqual([
          "pointerdown",
          "growth-before-window",
          "window-after-owner",
          "resize",
        ]);
        const [down, growth] = result.edges;
        expectPage(down.trusted).toBe(true);
        expectPage(growth.trusted).toBe(true);
        expectPage({ x: growth.x, y: growth.y }).toEqual({ x: down.x, y: down.y });
        expectPage(
          result.before.height - result.before.viewport - result.before.top,
        ).toBeLessThanOrEqual(1);
        expectPage(growth.height - result.before.height).toBe(800);
        expectPage(growth.top).toBe(down.top);
        expectPage(result.before.top).toBe(down.top);
        // Settlement preserves ownership; only the geometry observer may write.
        expectPage(result.edges[2].top).toBe(down.top);
        expectPage(
          result.after.height - result.after.viewport - result.after.top,
          JSON.stringify(result),
        ).toBeLessThanOrEqual(1);
      } finally {
        await page.close();
      }
    });

    it.each(["pointerup", "pointercancel"])(
      "retains stationary pointer intent when growth precedes %s and resize delivery",
      async (release) => {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
        try {
          await gotoFrontendHistory(
            page,
            `${origin}/orbs/frontend-fixture-orb`,
            "frontend-fixture-orb",
          );
          await waitForFixtureMedia(page);
          await page.evaluate(() =>
            Reflect.get(globalThis, "document").fonts.ready.then(() => undefined),
          );
          const pane = page.locator(".orb-transcript-scroll");
          await expectPage
            .poll(() =>
              pane.evaluate(
                (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
              ),
            )
            .toBeLessThanOrEqual(1);
          const result = await pane.evaluate(async (element, release) => {
            const view = element.ownerDocument.defaultView;
            const content = element.querySelector(".orb-transcript-content");
            if (!view || !content) throw new Error("Fixture scroll content missing");
            // Clear an acknowledged programmatic offset, as a normal native event does.
            element.dispatchEvent(new view.Event("scroll"));
            const before = {
              top: element.scrollTop,
              height: element.scrollHeight,
              viewport: element.clientHeight,
            };
            element.dispatchEvent(new view.PointerEvent("pointerdown", { bubbles: true }));
            const spacer = element.ownerDocument.createElement("div");
            spacer.style.height = "800px";
            content.append(spacer);
            const grownHeight = element.scrollHeight;
            const stationaryTop = element.scrollTop;
            // All three edges occur in one task, before ResizeObserver can run.
            element.dispatchEvent(new view.PointerEvent(release, { bubbles: true }));
            await new Promise<void>((resolve) => {
              const observer = new view.ResizeObserver(() => {
                observer.disconnect();
                view.requestAnimationFrame(() => resolve());
              });
              observer.observe(content);
            });
            return {
              before,
              grownHeight,
              stationaryTop,
              after: {
                top: element.scrollTop,
                height: element.scrollHeight,
                viewport: element.clientHeight,
              },
              trace: Reflect.get(view, "piOrbDebug")
                .dump()
                .trace.filter((entry: { event: string }) => entry.event === "scroll_pin"),
            };
          }, release);
          mkdirSync(evidence, { recursive: true });
          writeFileSync(
            join(evidence, `implementation-${engine}-stationary-${release}.json`),
            JSON.stringify(result, null, 2),
          );
          expectPage(
            result.before.height - result.before.viewport - result.before.top,
          ).toBeLessThanOrEqual(1);
          expectPage(result.grownHeight - result.before.height).toBe(800);
          expectPage(result.stationaryTop).toBe(result.before.top);
          expectPage(
            result.after.height - result.after.viewport - result.after.top,
            JSON.stringify(result),
          ).toBeLessThanOrEqual(1);
        } finally {
          await page.close();
        }
      },
    );
  },
);
