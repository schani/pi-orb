import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Browser, chromium, expect as expectPage, webkit } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, it } from "vitest";

const WEB_ROOT = join(import.meta.dirname, "../apps/web");
const ORB_HASH = "#/orbs/frontend-fixture-orb";

// Each engine owns its fixture, so accepted messages cannot leak between engines.
describe.each(["chromium", "webkit"] as const)("phone frontend · %s", (engine) => {
  let vite: ViteDevServer;
  let browser: Browser;
  let origin: string;

  beforeAll(async () => {
    vite = await createServer({
      root: WEB_ROOT,
      configFile: join(WEB_ROOT, "vite.config.ts"),
      mode: "frontend",
      server: { host: "127.0.0.1", port: 0 },
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (address === null || address === undefined || typeof address === "string") {
      throw new Error("phone E2E Vite server did not own a TCP port");
    }
    origin = `http://127.0.0.1:${address.port}`;
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
  });

  afterAll(async () => {
    await browser?.close();
    await vite?.close();
  });

  it.each([320, 390, 600])(
    "uses the phone side rail at %ipx without changing desktop composition",
    async (width) => {
      const page = await browser.newPage({
        viewport: { width, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      let releaseAcceptance: () => void = () => {};
      const acceptanceGate = new Promise<void>((resolve) => {
        releaseAcceptance = resolve;
      });
      let accepted: () => void = () => {};
      const acceptanceReached = new Promise<void>((resolve) => {
        accepted = resolve;
      });
      let fail = true;
      await page.route("**/api/v1/orbs/frontend-fixture-orb/messages/*", async (route) => {
        if (route.request().method() !== "PUT") return route.continue();
        if (fail) {
          await route.fulfill({
            status: 503,
            json: {
              error: { code: "unavailable", message: "Phone send unavailable", retryable: true },
            },
          });
          return;
        }
        // Gate before delivery: the fixture also emits request.result acceptance
        // over its live socket, so holding only HTTP cannot withhold acceptance.
        accepted();
        await acceptanceGate;
        const response = await route.fetch();
        expectPage(response.status()).toBe(202);
        await route.fulfill({ response });
      });
      try {
        await page.goto(`${origin}/${ORB_HASH}`);
        const composer = page.locator(".composer");
        const input = composer.getByRole("textbox", { name: "Message the orb" });
        const write = composer.getByRole("button", { name: "Write message" });
        await expectPage(write).toBeVisible();
        await expectPage(page.locator(".orb-index")).toBeHidden();
        await expectPage(input).toBeHidden();
        expectPage(
          await page
            .locator("body")
            .evaluate((element) => element.ownerDocument.activeElement?.tagName),
        ).not.toBe("TEXTAREA");
        expectPage(
          await page
            .locator(".composer-phone-pad")
            .evaluate((element) => element.getBoundingClientRect().height),
        ).toBe(44);
        await write.tap();
        await expectPage(input).toBeFocused();
        await expectPage(composer.getByRole("button", { name: "abort", exact: true })).toBeHidden();
        expectPage(await input.evaluate((element) => element.getBoundingClientRect().height)).toBe(
          88,
        );
        const draft = `phone ${width} ${randomUUID()}`;
        await input.fill(draft);
        await input.press("Enter");
        await input.pressSequentially("second line");
        await expectPage(input).toHaveValue(`${draft}\nsecond line`);
        await composer.getByRole("button", { name: "Fold editor" }).tap();
        await expectPage(input).toBeHidden();
        await write.tap();
        await expectPage(input).toHaveValue(`${draft}\nsecond line`);
        await composer.getByRole("button", { name: "Send message" }).tap();
        await expectPage(composer.getByRole("status")).toContainText("Phone send unavailable");
        await expectPage(input).toHaveValue(`${draft}\nsecond line`);
        fail = false;
        await page.setViewportSize({ width, height: 390 });
        await composer.getByRole("button", { name: "Send message" }).tap();
        await acceptanceReached;
        await expectPage(input).toBeVisible();
        await expectPage(input).toHaveValue(`${draft}\nsecond line`);
        releaseAcceptance();
        await expectPage(write).toBeVisible();
        await expectPage(composer.locator("textarea")).toHaveValue("");
        expectPage(
          await page.locator("html").evaluate((element) => element.scrollWidth),
        ).toBeLessThanOrEqual(width);
        await page.setViewportSize({ width: 1280, height: 900 });
        await expectPage(page.locator(".orb-index")).toBeVisible();
        await expectPage(input).toBeVisible();
        await expectPage(composer.getByRole("button", { name: "Send message" })).toBeHidden();
        await expectPage(write).toBeHidden();
        expectPage(await input.evaluate((element) => element.getBoundingClientRect().height)).toBe(
          80,
        );
        expectPage(
          await page
            .locator(".orb-header")
            .evaluate((element) => element.getBoundingClientRect().height),
        ).toBe(24);
        expectPage(
          await page
            .locator(".orb-index")
            .evaluate((element) => element.getBoundingClientRect().width),
        ).toBe(236);
      } finally {
        releaseAcceptance();
        await page.close();
      }
    },
  );

  it("does not write phone scroll position during unrelated polling renders", async () => {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    await page.clock.install();
    let refreshed = false;
    await page.route("**/api/v1/orbs/frontend-fixture-orb", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      if (refreshed) body.name = "Phone scroll poll";
      await route.fulfill({ response, json: body });
    });
    try {
      await page.goto(`${origin}/${ORB_HASH}`);
      await expectPage(page.getByRole("button", { name: "Write message" })).toBeVisible();
      await page.clock.runFor(100);
      const scroller = page.locator(".orb-transcript-scroll");
      await expectPage
        .poll(() =>
          scroller.evaluate(
            (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
          ),
        )
        .toBeLessThanOrEqual(1);
      const instrumented = await scroller.evaluate((element) => {
        let prototype = Object.getPrototypeOf(element);
        while (prototype && !Object.getOwnPropertyDescriptor(prototype, "scrollTop"))
          prototype = Object.getPrototypeOf(prototype);
        const property = Object.getOwnPropertyDescriptor(prototype, "scrollTop");
        const get = property?.get;
        const set = property?.set;
        if (!get || !set) return false;
        element.setAttribute("data-scroll-writes", "0");
        Object.defineProperty(element, "scrollTop", {
          configurable: true,
          get() {
            return get.call(this);
          },
          set(value) {
            element.setAttribute(
              "data-scroll-writes",
              String(Number(element.getAttribute("data-scroll-writes")) + 1),
            );
            set.call(this, value);
          },
        });
        return true;
      });
      expectPage(instrumented).toBe(true);
      refreshed = true;
      await page.clock.runFor(2100);
      await expectPage(page.locator(".orb-name")).toHaveText("Phone scroll poll");
      await expectPage(scroller).toHaveAttribute("data-scroll-writes", "0");
    } finally {
      await page.close();
    }
  });

  it("keeps phone transcript pixels after a native wheel scroll round trip", async () => {
    // WebKit's mobile automation does not implement wheel input. Use its desktop
    // input backend at phone width to exercise native scrolling and raster output.
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
      await page.goto(`${origin}/#/orbs/frontend-long-history`);
      const scroller = page.locator(".orb-transcript-scroll");
      await expectPage(page.getByRole("button", { name: "Write message" })).toBeVisible();
      await expectPage
        .poll(() => scroller.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(0);
      await page.mouse.move(195, 350);
      await page.mouse.wheel(0, -1000000);
      await expectPage.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(0);
      const before = await scroller.screenshot();
      await page.mouse.wheel(0, 1200);
      await expectPage
        .poll(() => scroller.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(0);
      await page.mouse.wheel(0, -1000000);
      await expectPage.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(0);
      expectPage(await scroller.screenshot()).toEqual(before);
    } finally {
      await page.close();
    }
  });

  it("owns phone scrolling in one viewport through keyboard resize and pan events", async () => {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    // Model Safari's visual-only resizing: the layout viewport stays 844px tall.
    // This is a controlled geometry adapter, not a claim to emulate its keyboard.
    await page.addInitScript(`
      const viewport = new EventTarget();
      Object.assign(viewport, { height: 844, width: 390, offsetTop: 0, offsetLeft: 0, scale: 1 });
      Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true });
      window.setPhoneViewport = (height, offsetTop, scale = 1) => {
        Object.assign(viewport, { height, offsetTop, scale });
        viewport.dispatchEvent(new Event('resize'));
        viewport.dispatchEvent(new Event('scroll'));
      };
    `);
    try {
      await page.goto(`${origin}/#/orbs/frontend-long-history`);
      const composer = page.locator(".composer");
      const scroller = page.locator(".orb-transcript-scroll");
      const app = page.locator(".app");
      await expectPage(composer.getByRole("button", { name: "Write message" })).toBeVisible();
      await expectPage(app).toHaveCSS("height", "844px");
      await expectPage
        .poll(() =>
          scroller.evaluate(
            (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
          ),
        )
        .toBeLessThanOrEqual(1);
      await composer.getByRole("button", { name: "Write message" }).tap();
      await composer.getByRole("textbox").fill("keep this draft while the keyboard moves");
      // Tail pin follows a keyboard resize, without moving the document.
      await page.evaluate("window.setPhoneViewport(390, 61)");
      await expectPage(app).toHaveCSS("top", "61px");
      await expectPage(app).toHaveCSS("height", "390px");
      await expectPage
        .poll(() =>
          scroller.evaluate(
            (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
          ),
        )
        .toBeLessThanOrEqual(1);
      // Interleave explicit reader scrolls with browser-bar/keyboard geometry edges.
      for (const [height, top, scrollTop] of [
        [420, 30, 200],
        [360, 85, 400],
        [520, 0, 600],
      ] as const) {
        await scroller.evaluate((element, position) => {
          element.scrollTop = position;
          element.dispatchEvent(new Event("scroll"));
        }, scrollTop);
        await page.evaluate(`window.setPhoneViewport(${height}, ${top})`);
        await expectPage(app).toHaveCSS("height", `${height}px`);
        await expectPage(app).toHaveCSS("top", `${top}px`);
        expectPage(await scroller.evaluate((element) => element.scrollTop)).toBe(scrollTop);
        const bounds = await page.locator(".orb-main").evaluate((element) => {
          const header = element.querySelector(".orb-header").getBoundingClientRect();
          const reading = element.querySelector(".orb-transcript-scroll").getBoundingClientRect();
          const composer = element.querySelector(".composer").getBoundingClientRect();
          return {
            headerBottom: header.bottom,
            readingTop: reading.top,
            readingBottom: reading.bottom,
            composerTop: composer.top,
            composerBottom: composer.bottom,
          };
        });
        expectPage(bounds.readingTop).toBe(bounds.headerBottom);
        expectPage(bounds.readingBottom).toBe(bounds.composerTop);
        expectPage(bounds.composerBottom).toBe(height + top);
        expectPage(await page.evaluate("window.scrollY")).toBe(0);
      }
      // Native pinch zoom pans the existing layout instead of shrinking it again.
      await page.evaluate("window.setPhoneViewport(260, 20, 2)");
      await expectPage(app).toHaveCSS("height", "520px");
      await composer.getByRole("button", { name: "Fold editor" }).tap();
      await page.evaluate("window.setPhoneViewport(844, 0)");
      await expectPage(app).toHaveCSS("height", "844px");
      await composer.getByRole("button", { name: "Write message" }).tap();
      await expectPage(composer.getByRole("textbox")).toHaveValue(
        "keep this draft while the keyboard moves",
      );
      // Leaving the phone breakpoint restores document scrolling and removes overrides.
      await page.setViewportSize({ width: 1280, height: 900 });
      await expectPage(app).toHaveCSS("position", "static");
      await expectPage(scroller).toHaveCSS("display", "contents");
      expectPage(
        await app.evaluate((element) => element.style.getPropertyValue("--phone-viewport-height")),
      ).toBe("");
    } finally {
      await page.close();
    }
  });

  it("aborts only from the collapsed phone pad and retains the draft", async () => {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const operationId = randomUUID();
    let startOperation: () => void = () => {};
    let ready: () => void = () => {};
    const initialIdle = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let aborted: () => void = () => {};
    const abortReceived = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    await page.routeWebSocket("**/api/v1/orbs/frontend-fixture-orb/live", (socket) => {
      const server = socket.connectToServer();
      const event = (value: object) =>
        socket.send(
          JSON.stringify({
            v: 1,
            type: "runtime.event",
            at: new Date().toISOString(),
            event: value,
          }),
        );
      let controlled = false;
      server.onMessage((message) => {
        const frame = JSON.parse(message.toString());
        if (!controlled) socket.send(message);
        if (
          frame.type === "runtime.event" &&
          frame.event.type === "status" &&
          frame.event.activity === "idle"
        )
          ready();
      });
      startOperation = () => {
        controlled = true;
        event({ type: "operation_started", operationId });
        event({ type: "status", activity: "busy", operationId });
      };
      socket.onMessage((message) => {
        const frame = JSON.parse(message.toString());
        if (frame.type !== "client.request" || frame.action.type !== "abort") {
          server.send(message);
          return;
        }
        expectPage(frame.action.operationId).toBe(operationId);
        socket.send(
          JSON.stringify({
            v: 1,
            type: "request.result",
            at: new Date().toISOString(),
            requestId: frame.requestId,
            result: { type: "accepted", operationId, duplicate: false },
          }),
        );
        event({ type: "operation_finished", operationId, outcome: "aborted" });
        event({ type: "status", activity: "idle" });
        aborted();
      });
    });
    try {
      await page.goto(`${origin}/${ORB_HASH}`);
      await initialIdle;
      startOperation();
      const composer = page.locator(".composer");
      await expectPage(composer.getByRole("button", { name: "abort", exact: true })).toBeVisible();
      await composer.getByRole("button", { name: "Write message" }).tap();
      await expectPage(composer.getByRole("button", { name: "abort", exact: true })).toBeHidden();
      await composer.getByRole("textbox").fill("preserve through abort");
      await composer.getByRole("button", { name: "Fold editor" }).tap();
      const abort = composer.getByRole("button", { name: "abort", exact: true });
      await expectPage(abort.locator("use")).toHaveAttribute("href", "#i-x");
      await abort.tap();
      await abortReceived;
      await expectPage(composer.getByRole("textbox")).toBeHidden();
      await expectPage(abort).toHaveCount(0);
      await composer.getByRole("button", { name: "Write message" }).tap();
      await expectPage(composer.getByRole("textbox")).toHaveValue("preserve through abort");
    } finally {
      await page.close();
    }
  });
});
