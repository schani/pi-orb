import { join } from "node:path";
import { chromium, expect, webkit } from "@playwright/test";
import { createServer } from "vite";
import { it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";
import { gotoFrontendHistory } from "./testkit/frontend-fixture.ts";

it.each(["chromium", "webkit"] as const)(
  "%s: mounts twenty tail rows and reveals anchored batches only on upward scrolling",
  async (engine) => {
    const root = join(import.meta.dirname, "../apps/web");
    const vite = await createServer({
      root,
      configFile: join(root, "vite.config.ts"),
      mode: "frontend",
      plugins: [
        {
          name: "observe-unchanged-markdown",
          transform(code, id) {
            // Deliver geometry/content changes before either native scroll handler.
            if (id.endsWith("/pages/OrbPage.tsx") || id.endsWith("/lib/use-history-tail.ts")) {
              const handler = "const onScroll = () => {";
              if (!code.includes(handler)) throw new Error("Scroll checkpoint missing");
              return code.replace(
                handler,
                `${handler} if (Reflect.get(globalThis, "__holdTailScroll")) return;`,
              );
            }
            if (!id.endsWith("/components/ChatMarkdown.tsx")) return;
            const anchor = /export function ChatMarkdown\(\{\s*children\s*\}[^)]*\)\s*\{/;
            if (!anchor.test(code)) throw new Error("Markdown parse checkpoint missing");
            return code.replace(
              anchor,
              (match) => `${match}
            if (children.startsWith('## Review ')) {
              const counts = Reflect.get(globalThis, '__reviewParses') ?? {};
              counts[children] = (counts[children] ?? 0) + 1;
              Reflect.set(globalThis, '__reviewParses', counts);
            }`,
            );
          },
        },
      ],
      server: { host: "127.0.0.1", port: 0 },
    });
    await listenFrontend(vite);
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("No fixture port");
    const browser = await (engine === "chromium" ? chromium : webkit).launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 500 } });
    const origin = `http://127.0.0.1:${address.port}`;
    const orb = "frontend-long-history";
    let historyReads = 0;
    try {
      await page.route(`**/orbs/${orb}/history`, async (route) => {
        historyReads++;
        await route.continue();
      });
      const rows = page.locator(".history > .rec");
      const history = page.locator(".history");
      const pane = page.locator(".orb-transcript-scroll");
      const composer = page.getByRole("textbox", { name: "Message the orb", exact: true });
      const ready = page.getByRole("button", { name: "Change thinking", exact: true });
      const layout = () =>
        page.evaluate(
          "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
        );
      const pinned = () =>
        pane.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop);
      const parses = () => page.evaluate(() => Reflect.get(globalThis, "__reviewParses"));
      await gotoFrontendHistory(page, `${origin}/orbs/${orb}`, orb, composer);
      await expect(ready).toBeEnabled();
      await expect(rows).toHaveCount(20);
      await expect(history).toContainText("Review iteration 91.");
      await expect(history).toContainText("Review 100");
      await expect(history).not.toContainText("Review iteration 90.");
      await expect(
        history.getByRole("button", { name: /earlier|older|more history/i }),
      ).toHaveCount(0);
      await expect.poll(pinned).toBeLessThanOrEqual(1);
      const initialParses = await parses();
      await composer.fill("short viewport must not fill history");
      await layout();
      await expect(rows).toHaveCount(20);
      expect(await parses()).toEqual(initialParses);

      // Settle both handlers, then deliver prepend geometry before either scroll acknowledgement.
      await pane.evaluate((node) => {
        node.scrollTop = 100;
        node.dispatchEvent(new Event("scroll"));
      });
      await layout();
      const anchor = await pane.evaluateHandle((node) => {
        const top = node.getBoundingClientRect().top;
        const row = [...node.querySelectorAll(".history > .rec")].find(
          (row) => row.getBoundingClientRect().bottom > top,
        );
        if (!row) throw new Error("Visible reader row missing");
        return row;
      });
      const anchorTop = await anchor.evaluate((node) => node.getBoundingClientRect().top);
      const oldGeometry = await pane.evaluate((node) => ({
        height: node.scrollHeight,
        bottomDistance: node.scrollHeight - node.clientHeight - node.scrollTop,
      }));
      // Upward intent at the settled offset, without native movement.
      await pane.evaluate((node) => {
        Reflect.set(globalThis, "__holdTailScroll", true);
        const view = node.ownerDocument.defaultView;
        if (!view) throw new Error("Transcript viewport window missing");
        const Wheel = Reflect.get(view, "WheelEvent");
        node.dispatchEvent(new Wheel("wheel", { deltaY: -1 }));
      });
      await expect(rows).toHaveCount(40);
      await layout();
      expect(
        (await pane.evaluate((node) => node.scrollHeight)) - oldGeometry.height,
      ).toBeGreaterThan(oldGeometry.bottomDistance);
      expect(
        Math.abs((await anchor.evaluate((node) => node.getBoundingClientRect().top)) - anchorTop),
      ).toBeLessThanOrEqual(1);
      expect(await pinned()).toBeGreaterThan(48);
      await pane.evaluate((node) => {
        Reflect.set(globalThis, "__holdTailScroll", false);
        node.dispatchEvent(new Event("scroll"));
      });
      await expect(history).toContainText("Review iteration 81.");
      await expect(history).not.toContainText("Review iteration 80.");

      // Browser scroll events expose one batch per boundary, not a background drain.
      for (const count of [60, 80]) {
        const first = await rows.first().elementHandle();
        const top = await pane.evaluate((node) => {
          node.scrollTop = 0;
          const first = node.querySelector(".history > .rec");
          if (!first) throw new Error("Transcript row missing");
          return first.getBoundingClientRect().top;
        });
        await expect(rows).toHaveCount(count);
        await layout();
        expect(
          Math.abs((await first.evaluate((node) => node.getBoundingClientRect().top)) - top),
        ).toBeLessThanOrEqual(1);
      }
      await expect(history).toContainText("Review iteration 61.");
      await expect(history).not.toContainText("Review iteration 60.");
      const revealed = await parses();
      const readerTop = await pane.evaluate((node) => node.scrollTop);
      await composer.fill("append while reading revealed history");
      await composer.press("Control+Enter");
      await expect(history.locator(".rec-orb").last()).toContainText(
        "append while reading revealed history",
      );
      await expect(history.locator(".bit-register")).toHaveCount(0);
      await expect(rows).toHaveCount(82);
      expect(await parses()).toEqual(revealed);
      expect(await pane.evaluate((node) => node.scrollTop)).toBe(readerTop);
      await expect(history).toContainText("Review iteration 61.");

      await pane.evaluate((node) => {
        Reflect.set(globalThis, "__holdTailScroll", true);
        node.scrollTop = node.scrollHeight;
      });
      await layout();
      await composer.fill("append at pinned tail");
      await composer.press("Control+Enter");
      await expect(history.locator(".rec-orb").last()).toContainText("append at pinned tail");
      await expect(history.locator(".bit-register")).toHaveCount(0);
      await expect(rows).toHaveCount(84);
      // Both scroll acknowledgements are still pending: layout must not restore the old reader.
      await expect.poll(pinned).toBeLessThanOrEqual(1);
      await pane.evaluate((node) => {
        Reflect.set(globalThis, "__holdTailScroll", false);
        node.dispatchEvent(new Event("scroll"));
      });
      await expect.poll(pinned).toBeLessThanOrEqual(1);
      expect(await parses()).toEqual(revealed);

      // Separately exercise the normal path after an actual native scroll acknowledgement.
      await pane.evaluate(async (node) => {
        node.scrollTop -= 120;
        await new Promise<void>((resolve) => {
          node.addEventListener("scroll", () => resolve(), { once: true });
        });
        await new Promise<void>((resolve) => {
          node.addEventListener("scroll", () => resolve(), { once: true });
          node.scrollTop = node.scrollHeight;
        });
      });
      await composer.fill("append after native tail acknowledgement");
      await composer.press("Control+Enter");
      await expect(history.locator(".rec-orb").last()).toContainText(
        "append after native tail acknowledgement",
      );
      await expect(history.locator(".bit-register")).toHaveCount(0);
      await expect(rows).toHaveCount(86);
      await expect.poll(pinned).toBeLessThanOrEqual(1);
      expect(await parses()).toEqual(revealed);

      const reads = historyReads;
      await page.locator('.orb-index a[href="/orbs/frontend-fixture-orb"]').click();
      await expect(page.locator(".orb-name")).toHaveText("Frontend Playground");
      await page.locator(`.orb-index a[href="/orbs/${orb}"]`).click();
      await expect(ready).toBeEnabled();
      await expect(rows).toHaveCount(20);
      await expect(history).not.toContainText("Review iteration 61.");
      await expect(history).toContainText("append at pinned tail");
      await expect.poll(pinned).toBeLessThanOrEqual(1);
      expect(historyReads).toBe(reads);
    } finally {
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
      await browser.close();
      await vite.close();
    }
  },
);

it.each(["chromium", "webkit"] as const)(
  "%s: phone keyboard reveal excludes editors and anchors delayed image growth above the reader",
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
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const origin = `http://127.0.0.1:${address.port}`;
    let releaseImage = () => {};
    const imageGate = new Promise<void>((resolve) => {
      releaseImage = resolve;
    });
    let imageArrived = () => {};
    const imageRequested = new Promise<void>((resolve) => {
      imageArrived = resolve;
    });
    try {
      await page.route("**/delayed-prepend-image.svg", async (route) => {
        imageArrived();
        await imageGate;
        await route.fulfill({
          contentType: "image/svg+xml",
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="600"><rect width="200" height="600" fill="navy"/></svg>',
        });
      });
      const history = page.locator(".history");
      const rows = history.locator(":scope > .rec");
      const pane = page.locator(".orb-transcript-scroll");
      const layout = () =>
        page.evaluate(
          "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
        );
      await gotoFrontendHistory(
        page,
        `${origin}/orbs/frontend-long-history`,
        "frontend-long-history",
        history,
      );
      await expect(
        page.getByRole("button", { name: "Change thinking", exact: true, includeHidden: true }),
      ).toBeEnabled();
      await expect(rows).toHaveCount(20);
      const originalRow = await rows.first().elementHandle();

      // An actual editable target inside the viewport must not turn cursor keys into history intent.
      await rows.first().evaluate((node) => {
        const editor = node.ownerDocument.createElement("input");
        editor.id = "history-intent-editor";
        editor.value = "editor cursor only";
        node.append(editor);
      });
      await pane.evaluate((node) => {
        node.scrollTop = 100;
      });
      await layout();
      await page.locator("#history-intent-editor").evaluate((node) => {
        (node as typeof node & { focus(options: { preventScroll: boolean }): void }).focus({
          preventScroll: true,
        });
      });
      await layout();
      await pane.evaluate((node) => {
        const keys: { key: string; target: string | undefined; top: number }[] = [];
        Reflect.set(globalThis, "__editorKeys", keys);
        node.addEventListener(
          "keydown",
          (event: Event) => {
            const target = (event.target as { id?: string } | null)?.id;
            // Own geometry at dispatch: Safari may reveal the focused caret between frames.
            if (target === "history-intent-editor") node.scrollTop = 100;
            keys.push({
              key: (event as typeof event & { key: string }).key,
              target,
              top: node.scrollTop,
            });
          },
          { capture: true },
        );
      });
      await page.locator("#history-intent-editor").press("Home");
      await layout();
      await expect(rows).toHaveCount(20);
      // Native caret reveal may scroll the editor into view; only transcript batches are excluded.
      await pane.evaluate((node) => {
        node.scrollTop = 100;
      });
      await layout();
      await page.locator("#history-intent-editor").press("ArrowUp");
      await layout();
      await expect(rows).toHaveCount(20);
      const editorKeys = await page.evaluate<{ key: string; target: string; top: number }[]>(() =>
        Reflect.get(globalThis, "__editorKeys"),
      );
      expect(editorKeys.map(({ key, target }) => ({ key, target }))).toEqual([
        { key: "Home", target: "history-intent-editor" },
        { key: "ArrowUp", target: "history-intent-editor" },
      ]);
      for (const { top } of editorKeys) expect(top).toBeLessThanOrEqual(160);
      await page.locator("#history-intent-editor").evaluate((node) => node.remove());

      // Native phone-width keyboard scrolling reveals one batch from the initial tail.
      await pane.evaluate((node) => {
        node.scrollTop = node.scrollHeight;
        node.setAttribute("tabindex", "0");
        (node as typeof node & { focus(options: { preventScroll: boolean }): void }).focus({
          preventScroll: true,
        });
      });
      await layout();
      await page.keyboard.press("Home");
      await expect(rows).toHaveCount(40);
      await layout();
      await expect(history).toContainText("Review iteration 81.");
      await expect(history).not.toContainText("Review iteration 80.");

      // Establish native upward reader intent with the original tail row in view.
      await originalRow.evaluate((node) => {
        const pane = node.ownerDocument.querySelector(".orb-transcript-scroll");
        if (!pane) throw new Error("Transcript viewport missing");
        pane.scrollTop += node.getBoundingClientRect().top - pane.getBoundingClientRect().top - 20;
      });
      await layout();
      const box = await pane.boundingBox();
      if (!box) throw new Error("Transcript viewport missing");
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      const beforeWheel = await pane.evaluate((node) => node.scrollTop);
      await page.mouse.wheel(0, -1);
      await expect.poll(() => pane.evaluate((node) => node.scrollTop)).toBeLessThan(beforeWheel);
      await layout();

      // Browser-native image decoding changes a newly prepended row's intrinsic height.
      await rows.first().evaluate((node) => {
        const image = node.ownerDocument.createElement("img");
        image.id = "delayed-prepend-image";
        image.style.display = "block";
        image.src = "/delayed-prepend-image.svg";
        node.append(image);
      });
      await imageRequested;
      await layout();
      // Downward reader intent must replace the anchor, not abandon off-tail anchoring.
      const beforeDownward = await pane.evaluate((node) => node.scrollTop);
      await page.mouse.wheel(0, 100);
      await expect
        .poll(() => pane.evaluate((node) => node.scrollTop))
        .toBeGreaterThan(beforeDownward);
      await layout();
      await expect(rows).toHaveCount(40);
      expect(
        await pane.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop),
      ).toBeGreaterThan(160);
      const reader = await pane.evaluateHandle((node) => {
        const top = node.getBoundingClientRect().top;
        const row = [...node.querySelectorAll(".history > .rec")].find(
          (row) => row.getBoundingClientRect().bottom > top,
        );
        if (!row) throw new Error("Visible reader row missing");
        return row;
      });
      const before = await reader.evaluate((node) => node.getBoundingClientRect().top);
      const height = await pane.evaluate((node) => node.scrollHeight);
      const image = page.locator("#delayed-prepend-image");
      const initialImageHeight = await image.evaluate(
        (node) => node.getBoundingClientRect().height,
      );
      releaseImage();
      await expect
        .poll(() =>
          image.evaluate((node) => (node as typeof node & { naturalHeight: number }).naturalHeight),
        )
        .toBe(600);
      await layout();
      const growth =
        (await image.evaluate((node) => node.getBoundingClientRect().height)) - initialImageHeight;
      expect(growth).toBeGreaterThan(400);
      expect(await pane.evaluate((node) => node.scrollHeight)).toBe(height + growth);
      expect(
        Math.abs((await reader.evaluate((node) => node.getBoundingClientRect().top)) - before),
      ).toBeLessThanOrEqual(1);
      await expect(rows).toHaveCount(40);
    } finally {
      releaseImage();
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
      await browser.close();
      await vite.close();
    }
  },
);
