import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectDisplayRecord } from "@pi-orb/protocol";
import { expect as check, chromium, webkit } from "@playwright/test";
import { createServer } from "vite";
import { it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";

it.each(["chromium", "webkit"] as const)(
  "%s: stopped cache paints before refresh, retries errors, and obeys 404",
  async (engine) => {
    const root = join(import.meta.dirname, "../apps/web");
    const cacheDir = await mkdtemp(join(tmpdir(), `pi-orb-stopped-${engine}-`));
    const vite = await createServer({
      root,
      cacheDir,
      configFile: join(root, "vite.config.ts"),
      mode: "frontend",
      server: { host: "127.0.0.1", port: 0 },
    });
    await listenFrontend(vite);
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("No fixture port");
    const browser = await (engine === "chromium" ? chromium : webkit).launch();
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    const chronology: { event: string; url: string; status?: number }[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/v1/orbs/"))
        chronology.push({ event: "request", url: request.url() });
    });
    page.on("response", (response) => {
      if (response.url().includes("/api/v1/orbs/"))
        chronology.push({
          event: "response",
          url: response.url(),
          status: response.status(),
        });
    });
    await page.addInitScript(`(() => {
      const events = [];
      Object.defineProperty(window, "__orbClickEvidence", { value: events });
      for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click"])
        window.addEventListener(type, (event) => {
          const target = event.target instanceof Element ? event.target : null;
          events.push({ type, phase: "capture", anchor: target?.closest("a[href]")?.getAttribute("href"),
            x: event.clientX, y: event.clientY, url: location.href });
          if (events.length > 100) events.shift();
          if (type === "click") queueMicrotask(() => events.push({ type, phase: "after",
            defaultPrevented: event.defaultPrevented, url: location.href }));
        }, true);
    })();`);
    await page.context().tracing.start({ screenshots: true, snapshots: true });
    const origin = `http://127.0.0.1:${address.port}`;
    const a = "frontend-long-history",
      b = "frontend-fixture-orb";
    let refresh = false,
      missing = false,
      fail = true,
      holdReturnMetadata = false;
    let metadataArrived = () => {};
    const metadataRequested = new Promise<void>((resolve) => {
      metadataArrived = resolve;
    });
    let releaseMetadata = () => {};
    const metadataGate = new Promise<void>((resolve) => {
      releaseMetadata = resolve;
    });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await page.route(`**/api/v1/orbs/${a}`, async (route) => {
        if (missing)
          return route.fulfill({
            status: 404,
            json: {
              error: {
                code: "not_found",
                message: "Orb doesn't exist",
                retryable: false,
              },
            },
          });
        const held = holdReturnMetadata;
        if (held) metadataArrived();
        const response = await route.fetch();
        if (held) await metadataGate;
        const orb = await response.json();
        orb.state = "stopped";
        return route.fulfill({ response, json: orb });
      });
      await page.route(`**/orbs/${a}/history`, async (route) => {
        const response = await route.fetch();
        if (!refresh) return route.fulfill({ response });
        await gate;
        if (fail)
          return route.fulfill({
            status: 503,
            json: {
              error: {
                code: "unavailable",
                message: "held refresh failure",
                retryable: true,
              },
            },
          });
        const view = await response.json();
        view.records.push(
          projectDisplayRecord({
            id: "cache-new-tail",
            parentId: view.cursor,
            timestamp: "now",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "REFRESH_NEW_TAIL" }],
            overflow: {},
          }),
        );
        view.cursor = "cache-new-tail";
        view.headId = view.cursor;
        return route.fulfill({ response, json: view });
      });
      await page.goto(`${origin}/orbs/${a}`);
      await check(page.locator(".history")).toContainText("Review 100");
      // Overflowing header progress must scroll without stealing the transcript or composer.
      await page.setViewportSize({ width: 1280, height: 320 });
      await page.locator(".orb-header-stack").evaluate((stack) => {
        const scroller = stack.querySelector(".orb-header-scroll") ?? stack;
        for (let index = 0; index < 24; index++) {
          const row = stack.ownerDocument.createElement("div");
          row.className = "workspace-uploads test-upload-row";
          row.textContent = `upload ${index + 1}`;
          scroller.append(row);
        }
      });
      try {
        const layout = await page.locator(".orb-main").evaluate((main) => {
          const doc = main.ownerDocument;
          const stack = main.querySelector(".orb-header-stack");
          const composer = main.querySelector(".composer");
          const pane = main.querySelector(".orb-transcript-scroll");
          const index = doc.querySelector('.orb-index a[href="/orbs/frontend-fixture-orb"]');
          const archive = main.querySelector('button[aria-label="Archive orb"]');
          if (!stack || !composer || !pane || !index || !archive)
            throw new Error("Missing orb layout");
          const scroller = stack.querySelector(".orb-header-scroll") ?? stack;
          const row = scroller.querySelector(".test-upload-row:last-child");
          if (!row) throw new Error("Missing upload progress row");
          const anchorTop = index.getBoundingClientRect().top;
          scroller.scrollTop = scroller.scrollHeight;
          pane.scrollTop = 0;
          const first = pane.scrollTop;
          pane.scrollTop = 64;
          const action = archive.getBoundingClientRect();
          const hit = doc.elementFromPoint(
            action.left + action.width / 2,
            action.top + action.height / 2,
          );
          return {
            rootOverflow:
              (doc.scrollingElement?.scrollHeight ?? 0) - (doc.scrollingElement?.clientHeight ?? 0),
            rootTop: doc.scrollingElement?.scrollTop,
            headerScroll: scroller.scrollTop,
            actionHit: hit === archive || archive.contains(hit),
            rowBottom: row.getBoundingClientRect().bottom,
            headerBottom: stack.getBoundingClientRect().bottom,
            composerBottom: composer.getBoundingClientRect().bottom,
            transcriptHeight: pane.getBoundingClientRect().height,
            transcriptScroll: pane.scrollTop - first,
            indexShift: index.getBoundingClientRect().top - anchorTop,
          };
        });
        check(layout.rootOverflow).toBe(0);
        check(layout.rootTop).toBe(0);
        check(layout.headerScroll).toBeGreaterThan(0);
        check(layout.actionHit).toBe(true);
        check(layout.rowBottom).toBeLessThanOrEqual(layout.headerBottom);
        check(layout.composerBottom).toBeLessThanOrEqual(320);
        check(layout.transcriptHeight).toBeGreaterThanOrEqual(40);
        check(layout.transcriptScroll).toBeGreaterThan(0);
        check(layout.indexShift).toBe(0);
      } finally {
        await page.locator(".test-upload-row").evaluateAll((rows) => {
          for (const row of rows) row.remove();
        });
        await page.setViewportSize({ width: 1280, height: 900 });
      }
      const owner = await page.locator(".orb-transcript-scroll").evaluate((pane) => {
        const root = pane.ownerDocument.scrollingElement;
        if (!root) throw new Error("Missing document scroller");
        const overflow = pane.scrollHeight - pane.clientHeight;
        pane.scrollTop = 0;
        const top = pane.scrollTop;
        pane.scrollTop = pane.scrollHeight;
        return {
          rootOverflow: root.scrollHeight - root.clientHeight,
          rootTop: root.scrollTop,
          overflow,
          top,
          bottom: pane.scrollTop,
        };
      });
      check(owner.rootOverflow).toBe(0);
      check(owner.rootTop).toBe(0);
      check(owner.overflow).toBeGreaterThan(32);
      check(owner.top).toBe(0);
      check(owner.bottom).toBeGreaterThan(32);
      // Rendering may precede admission; departure must own a stored snapshot.
      await check
        .poll(() =>
          page.evaluate((orbId) => {
            const debug = globalThis as typeof globalThis & {
              piOrbDebug: {
                dump(): {
                  trace: { event: string; orbId?: string; outcome?: string }[];
                };
              };
            };
            return debug.piOrbDebug
              .dump()
              .trace.filter((entry) => entry.event === "cache" && entry.orbId === orbId)
              .at(-1)?.outcome;
          }, a),
        )
        .toBe("stored");
      await page.locator(`.orb-index a[href="/orbs/${b}"]`).click();
      await check(page.locator(".orb-name")).toHaveText("Frontend Playground");
      await check(page.locator(".orb-index")).toHaveAttribute("aria-busy", "false");
      check(page.url()).toBe(`${origin}/orbs/${b}`);
      refresh = true;
      // The original zero-delay native return is not gated by metadata.
      await page.locator(`.orb-index a[href="/orbs/${a}"]`).click();
      await check.poll(() => page.url()).toBe(`${origin}/orbs/${a}`);
      await check(page.locator(".history")).toContainText("Review 100");
      await check
        .poll(() =>
          page.evaluate((orbId) => {
            const debug = globalThis as typeof globalThis & {
              piOrbDebug: {
                dump(): {
                  trace: { event: string; orbId?: string; outcome?: string }[];
                };
              };
            };
            return debug.piOrbDebug
              .dump()
              .trace.filter((entry) => entry.event === "navigation" && entry.orbId === orbId)
              .at(-1)?.outcome;
          }, a),
        )
        .toBe("metadata_completion");
      await check(page.locator(".orb-main")).toHaveAttribute("aria-busy", "false");

      // Held metadata paints cached A without granting mutation authority.
      await page.locator(`.orb-index a[href="/orbs/${b}"]`).click();
      await check(page.locator(".orb-name")).toHaveText("Frontend Playground");
      holdReturnMetadata = true;
      await page.locator(`.orb-index a[href="/orbs/${a}"]`).click();
      await metadataRequested;
      await check.poll(() => page.url()).toBe(`${origin}/orbs/${a}`);
      await check(page.locator(".history")).toContainText("Review 100");
      await check(page.locator(".history")).not.toContainText("Frontend playground");
      const composer = page.getByRole("textbox", { name: "Message the orb", exact: true });
      await check(composer).toBeEditable();
      await composer.fill("stopped cached draft before metadata");
      await check(
        page.getByRole("button", { name: "Send message", exact: true, includeHidden: true }),
      ).toBeDisabled();
      await check(page.getByRole("button", { name: "Rename orb", exact: true })).toBeDisabled();
      await check
        .poll(() =>
          page.evaluate((orbId) => {
            const debug = globalThis as typeof globalThis & {
              piOrbDebug: {
                dump(): { trace: { event: string; orbId?: string; outcome?: string }[] };
              };
            };
            return debug.piOrbDebug
              .dump()
              .trace.filter((entry) => entry.event === "navigation" && entry.orbId === orbId)
              .at(-1)?.outcome;
          }, a),
        )
        .toBe("cached_selection");
      const metadataResponse = page.waitForResponse((response) =>
        response.url().endsWith(`/api/v1/orbs/${a}`),
      );
      releaseMetadata();
      check((await metadataResponse).status()).toBe(200);
      await check
        .poll(() =>
          page.evaluate((orbId) => {
            const debug = globalThis as typeof globalThis & {
              piOrbDebug: {
                dump(): {
                  trace: { event: string; orbId?: string; outcome?: string }[];
                };
              };
            };
            return debug.piOrbDebug
              .dump()
              .trace.filter((entry) => entry.event === "navigation" && entry.orbId === orbId)
              .at(-1)?.outcome;
          }, a),
        )
        .toBe("metadata_completion");
      await check(page.locator(".history")).toContainText("Review 100");
      await check(composer).toHaveValue("stopped cached draft before metadata");
      await check(page.locator(".orb-main")).toHaveAttribute("aria-busy", "false");
      release();
      await check(page.getByText(/held refresh failure/)).toBeVisible();
      await check(page.locator(".history")).toContainText("Review 100");
      fail = false;
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await check(page.locator(".history")).toContainText("REFRESH_NEW_TAIL");
      await check(page.getByText(/held refresh failure/)).toHaveCount(0);
      missing = true;
      await check(page.getByText("Orb doesn't exist", { exact: true })).toBeVisible();
      check(page.url()).toBe(`${origin}/orbs/${a}`);
      await check(page.locator(".history")).toHaveCount(0);
      await check(page.getByRole("link", { name: "Back to dashboard", exact: true })).toBeVisible();
    } catch (error) {
      const directory = join(
        import.meta.dirname,
        `../test-failures/stopped-cache-${engine}-${Date.now()}`,
      );
      await mkdir(directory, { recursive: true });
      const snapshot = await page
        .evaluate(() => {
          const browser = globalThis as typeof globalThis & {
            piOrbDebug?: { dump(): unknown };
            __orbClickEvidence?: unknown[];
            location: { href: string };
            document: {
              querySelector(selector: string): {
                textContent: string | null;
                getAttribute(name: string): string | null;
              } | null;
            };
            performance: { getEntriesByType(type: string): { name: string }[] };
          };
          return {
            url: browser.location.href,
            documentNavigation: browser.performance
              .getEntriesByType("navigation")
              .map((entry) => entry.name),
            debug: browser.piOrbDebug?.dump(),
            clicks: browser.__orbClickEvidence,
            name: browser.document.querySelector(".orb-name")?.textContent,
            busy: browser.document.querySelector(".orb-main")?.getAttribute("aria-busy"),
            history: browser.document.querySelector(".history")?.textContent?.slice(0, 300),
          };
        })
        .catch((cause) => ({ evaluationError: String(cause) }));
      await writeFile(
        join(directory, "evidence.json"),
        JSON.stringify(
          {
            error: String(error),
            snapshot,
            chronology: chronology.slice(-100),
          },
          null,
          2,
        ),
      );
      await page
        .screenshot({ path: join(directory, "failure.png"), fullPage: true })
        .catch(() => {});
      await page.context().tracing.stop({ path: join(directory, "trace.zip") });
      throw error;
    } finally {
      releaseMetadata();
      release();
      await page
        .context()
        .tracing.stop()
        .catch(() => {});
      await page.close();
      await browser.close();
      await vite.close();
      await rm(cacheDir, { recursive: true, force: true });
    }
  },
);
