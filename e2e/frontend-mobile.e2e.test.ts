import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type HistoryRecord, type OrbView, projectDisplayRecord } from "@pi-orb/protocol";
import { type Browser, chromium, expect as expectPage, type Page, webkit } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";
import { mockClaudeOwnerConnection } from "./testkit/claude-auth-fixture.ts";
import { closeRoutedPage } from "./testkit/close-routed-page.ts";
import { gotoFrontendFixture, gotoFrontendHistory } from "./testkit/frontend-fixture.ts";
import { waitForFixtureMedia } from "./testkit/media-ready.ts";
import { armNativeWheel } from "./testkit/native-wheel.ts";
import { expectTabletTouchFocus } from "./testkit/tablet-touch-focus.ts";

const WEB_ROOT = join(import.meta.dirname, "../apps/web");
const ORB_PATH = "/orbs/frontend-fixture-orb";
const DEJAVU_MONO = readFileSync(
  join(import.meta.dirname, "fixtures/fonts/DejaVuSansMono.ttf"),
).toString("base64");

/** Controlled geometry adapter for Safari's visual-only resizing, not keyboard emulation. */
async function fakeVisualViewport(page: Page, width: number, height: number): Promise<void> {
  await page.addInitScript(`
    const viewport = new EventTarget();
    Object.assign(viewport, { height: ${height}, width: ${width}, offsetTop: 0, offsetLeft: 0, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true });
    window.setVisualViewport = (height, offsetTop, scale = 1, notify = true) => {
      Object.assign(viewport, { height, offsetTop, scale });
      if (notify) {
        viewport.dispatchEvent(new Event('resize'));
        viewport.dispatchEvent(new Event('scroll'));
      }
    };
  `);
}

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
    await listenFrontend(vite);
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

  it.each([1280, 320])(
    "keeps required GitHub login visible at the transcript tail at %ipx",
    async (width) => {
      const page = await browser.newPage({ viewport: { width, height: 740 } });
      const orbId = "frontend-long-history";
      await page.route(`**/api/v1/orbs/${orbId}`, async (route) => {
        const response = await route.fetch();
        const original: OrbView = await response.json();
        await route.fulfill({
          json: {
            ...original,
            centralAgent: true,
            state: "creating",
            activity: "busy",
            actionRequired: {
              type: "github_device_login",
              verificationUri: "https://github.com/login/device",
              userCode: "AUTH-2468",
              expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
            },
          } satisfies OrbView,
        });
      });
      try {
        await gotoFrontendHistory(page, `${origin}/orbs/${orbId}`, orbId);
        const scroller = page.locator(".orb-transcript-scroll");
        await expectPage
          .poll(() =>
            scroller.evaluate((element) => ({
              long: element.scrollTop > element.clientHeight,
              atTail:
                Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop) <= 1,
            })),
          )
          .toEqual({ long: true, atTail: true });
        const code = page.locator(".user-code");
        await expectPage(code).toBeInViewport({ ratio: 1 });
        const before = await code.boundingBox();
        await scroller.evaluate(
          (element) =>
            new Promise<void>((resolve) => {
              element.addEventListener("scroll", () => queueMicrotask(resolve), { once: true });
              element.scrollTop -= 100;
            }),
        );
        expectPage(await code.boundingBox()).toEqual(before);
        await expectPage(code).toBeInViewport({ ratio: 1 });
      } finally {
        await closeRoutedPage(page);
      }
    },
  );

  it.each([320, 390, 402, 600, 631, 632, 1280])(
    "fills dashboard width with one column or equal masonry columns at %ipx",
    async (width) => {
      const page = await browser.newPage({
        viewport: { width, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      await page.route("**/api/v1/projects/frontend-fixture-project/orbs", async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        await route.fulfill({
          response,
          json: {
            ...body,
            items: body.items.filter((orb: { state: string }) => orb.state === "archived"),
          },
        });
      });
      try {
        await gotoFrontendFixture(page, origin, page.locator(".dashboard .project-column").first());
        const columns = page.locator(".dashboard > *");
        await expectPage(columns.first()).toBeVisible();
        const actions = page.locator(".dashboard .project-head-actions > .icon-button");
        expectPage(await actions.count()).toBeGreaterThan(0);
        for (const action of await actions.all()) {
          await expectPage(action).toHaveCSS("width", width <= 600 ? "48px" : "24px");
          await expectPage(action).toHaveCSS("height", width <= 600 ? "48px" : "24px");
        }
        const geometry = await columns.evaluateAll((elements) =>
          elements.map((element) => element.getBoundingClientRect().width),
        );
        expectPage(geometry.length).toBeGreaterThan(1);
        for (const columnWidth of geometry) {
          expectPage(columnWidth).toBe(Math.floor(width / Math.max(1, Math.floor(width / 316))));
        }
        expectPage(
          await page.evaluate(() => {
            const doc = Reflect.get(globalThis, "document").documentElement;
            return doc.scrollWidth <= doc.clientWidth;
          }),
        ).toBe(true);
        if (width < 632) {
          await expectPage(page.locator(".project-progress")).toHaveCount(0);
          const archiveProject = page.locator("#project-frontend-fixture-project");
          await expectPage(archiveProject.locator(":scope > .orb-entry")).toHaveCount(0);
          const archive = archiveProject.locator(".project-archive");
          await expectPage(archive).toBeVisible();
          const collapsedHeight = (await archiveProject.boundingBox())?.height;
          for (const expanded of [false, true]) {
            if (expanded) {
              await archive.locator("summary").click();
              await expectPage(archive.locator(".orb-entry")).toBeVisible();
              expectPage((await archiveProject.boundingBox())?.height).toBeGreaterThan(
                collapsedHeight ?? 0,
              );
            }
            const unusedHeights = await page
              .locator(".dashboard .project-column")
              .evaluateAll((projects) =>
                projects.map((project) => {
                  const bottom = Math.max(
                    ...[...project.children].map((child) => child.getBoundingClientRect().bottom),
                  );
                  return project.getBoundingClientRect().bottom - bottom;
                }),
              );
            for (const unusedHeight of unusedHeights) {
              // Only the section's 1px bottom rule follows its last visible child.
              expectPage(unusedHeight).toBeCloseTo(1, 0);
            }
          }
        }
        for (const field of await page.locator(".new-project input").all()) {
          await expectPage(field).toHaveCSS("font-size", "16px");
        }
      } finally {
        await page.close();
      }
    },
  );

  it.each([320, 390])(
    "wraps assistant failure text inside the phone transcript at %ipx",
    async (width) => {
      const page = await browser.newPage({
        viewport: { width, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      const long = "*".repeat(155);
      await page.route("**/api/v1/orbs/frontend-long-history", async (route) => {
        const response = await route.fetch();
        await route.fulfill({ response, json: { ...(await response.json()), state: "stopped" } });
      });
      await page.route("**/api/v1/orbs/frontend-long-history/history", async (route) => {
        const response = await route.fetch();
        const history = await response.json();
        const records = history.records;
        const failure: HistoryRecord = {
          id: "long-assistant-failure",
          parentId: records.at(-1).id,
          timestamp: records.at(-1).timestamp,
          type: "message",
          role: "assistant",
          finishReason: "error",
          failure: { message: `Incorrect API key provided: sk-example${long}.`, diagnostics: [] },
          content: [],
          overflow: {},
        };
        records.push(projectDisplayRecord(failure));
        await route.fulfill({
          response,
          json: {
            ...history,
            records,
            cursor: "long-assistant-failure",
            headId: "long-assistant-failure",
          },
        });
      });
      try {
        await gotoFrontendHistory(
          page,
          `${origin}/orbs/frontend-long-history`,
          "frontend-long-history",
          page.locator(".history"),
        );
        const failure = page.locator('.rec-orb .error-text[role="alert"]');
        await expectPage(failure).toContainText("Incorrect API key provided:");
        const widths = await page.locator(".orb-transcript-scroll").evaluate((pane) => {
          const history = pane.querySelector(".history");
          if (history === null) return null;
          return {
            pane: pane.clientWidth,
            paneScroll: pane.scrollWidth,
            history: history.getBoundingClientRect().width,
            document: pane.ownerDocument.documentElement.scrollWidth,
            viewport: pane.ownerDocument.documentElement.clientWidth,
          };
        });
        expectPage(widths).not.toBeNull();
        if (widths === null) throw new Error("Transcript geometry unavailable");
        expectPage(widths.history).toBeLessThanOrEqual(widths.pane);
        expectPage(widths.paneScroll).toBeLessThanOrEqual(widths.pane);
        expectPage(widths.document).toBeLessThanOrEqual(widths.viewport);
      } finally {
        await page.close();
      }
    },
  );

  it.each([
    { width: 1280, hasTouch: false },
    { width: 820, hasTouch: true },
    { width: 390, hasTouch: true },
    { width: 320, hasTouch: false },
  ])(
    "keeps the reading face and zoom-safe input typography at $width px with touch=$hasTouch",
    async ({ width, hasTouch }) => {
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        hasTouch,
      });
      try {
        const composer = page.getByRole("textbox", { name: "Message the orb", exact: true });
        await gotoFrontendHistory(
          page,
          `${origin}${ORB_PATH}`,
          "frontend-fixture-orb",
          page.locator(".history"),
        );
        if (width <= 600) await page.locator(".composer-open").click();
        const inputSize = width <= 600 || hasTouch ? "16px" : "13px";
        await expectPage(composer).toHaveCSS("font-size", inputSize);
        const typography = await page.locator(".orb-main").evaluate((main) => {
          const input = main.querySelector(".composer-input");
          const prose = main.querySelector(".rec-orb .chat-markdown");
          const mirror = main.querySelector(".composer-caret-mirror");
          return [input, prose, mirror].map((element) => {
            if (!element) return null;
            const style = element.ownerDocument.defaultView?.getComputedStyle(element);
            if (!style) return null;
            return {
              family: style.fontFamily,
              size: style.fontSize,
              ligatures: style.fontVariantLigatures,
              features: style.fontFeatureSettings,
            };
          });
        });
        expectPage(typography[0]?.family).toContain("Iosevka Etoile");
        const loaded = await composer.evaluate(async (element) => {
          const families = ["Iosevka Etoile", "JetBrains Mono"];
          return Promise.all(
            families.flatMap((family) =>
              ["", "bold ", "italic "].map(async (style) => {
                const faces = await element.ownerDocument.fonts.load(`${style}13px "${family}"`);
                return (
                  faces.length > 0 &&
                  faces.every((face: { status: string }) => face.status === "loaded")
                );
              }),
            ),
          );
        });
        expectPage(loaded).toEqual(Array(6).fill(true));
        await expectPage(page.locator(".chat-markdown code").first()).toHaveCSS(
          "font-family",
          /^"?JetBrains Mono"?, monospace$/,
        );
        if (engine === "chromium") {
          const session = await page.context().newCDPSession(page);
          await session.send("DOM.enable");
          await session.send("CSS.enable");
          const { root } = await session.send("DOM.getDocument");
          for (const [selector, family] of [
            [".rec-orb .chat-markdown p", "Orb Study 5"],
            [".chat-markdown code", "Orb Study 1"],
          ] as const) {
            const { nodeId } = await session.send("DOM.querySelector", {
              nodeId: root.nodeId,
              selector,
            });
            const { fonts } = await session.send("CSS.getPlatformFontsForNode", { nodeId });
            expectPage(
              fonts.some(
                (font: { familyName: string; isCustomFont: boolean; glyphCount: number }) =>
                  font.familyName === family && font.isCustomFont && font.glyphCount > 0,
              ),
            ).toBe(true);
          }
          await session.detach();
        }
        expectPage(typography[1]).toEqual({ ...typography[0], size: "13px" });
        expectPage(typography[2]).toEqual(typography[0]);
      } finally {
        await page.close();
      }
    },
  );

  it.runIf(engine === "webkit")(
    "leaves tablet-width touch focus and document position alone on tab return",
    async () => {
      await expectTabletTouchFocus(browser, origin, true);
    },
  );

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
        const renameButton = page.getByRole("button", { name: "Rename orb" });
        await gotoFrontendHistory(
          page,
          `${origin}${ORB_PATH}`,
          "frontend-fixture-orb",
          renameButton,
        );
        await renameButton.tap();
        const rename = page.getByRole("textbox", { name: "orb name" });
        await expectPage(rename).toBeFocused();
        const renameGeometry = await rename.evaluate((element) => {
          const frame = element.closest(".text-field-frame");
          const save = frame?.nextElementSibling;
          const view = element.ownerDocument.defaultView;
          if (frame === null || frame.parentElement === null || save === null || view === null)
            return null;
          const marks = view.getComputedStyle(frame, "::after");
          const fieldBox = element.getBoundingClientRect();
          const frameBox = frame.getBoundingClientRect();
          const saveBox = save.getBoundingClientRect();
          return {
            cropLeft: frameBox.left + Number.parseFloat(marks.left),
            fieldLeft: fieldBox.left,
            fieldWidth: fieldBox.width,
            flexWrap: view.getComputedStyle(frame.parentElement).flexWrap,
            frameWidth: frameBox.width,
            overlap:
              fieldBox.left < saveBox.right &&
              fieldBox.right > saveBox.left &&
              fieldBox.top < saveBox.bottom &&
              fieldBox.bottom > saveBox.top,
          };
        });
        expectPage(renameGeometry).not.toBeNull();
        expectPage(renameGeometry?.cropLeft).toBeCloseTo((renameGeometry?.fieldLeft ?? 0) - 3, 5);
        expectPage(renameGeometry?.flexWrap).toBe("wrap");
        expectPage(renameGeometry?.frameWidth).toBeCloseTo(renameGeometry?.fieldWidth ?? 0, 5);
        expectPage(renameGeometry?.overlap).toBe(false);
        await page.getByRole("button", { name: "cancel", exact: true }).tap();

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
        const focusStyle = await input.evaluate((element) => {
          const frame = element.closest(".text-field-frame");
          if (frame === null) return null;
          const view = element.ownerDocument.defaultView;
          if (view === null) return null;
          const inputStyle = view.getComputedStyle(element);
          const marks = view.getComputedStyle(frame, "::after");
          const inputBox = element.getBoundingClientRect();
          const frameBox = frame.getBoundingClientRect();
          return {
            background: inputStyle.backgroundColor,
            caret: inputStyle.caretColor,
            color: inputStyle.color,
            cropBottom: frameBox.bottom - Number.parseFloat(marks.bottom),
            cropLeft: frameBox.left + Number.parseFloat(marks.left),
            cropRight: frameBox.right - Number.parseFloat(marks.right),
            cropTop: frameBox.top + Number.parseFloat(marks.top),
            field: {
              bottom: inputBox.bottom,
              left: inputBox.left,
              right: inputBox.right,
              top: inputBox.top,
            },
            gradientCount: marks.backgroundImage.split("linear-gradient").length - 1,
            center: marks.backgroundColor,
          };
        });
        expectPage(focusStyle?.background).toBe("rgb(255, 255, 255)");
        expectPage(focusStyle?.caret).toBe("rgb(0, 0, 0)");
        expectPage(focusStyle?.color).toBe("rgb(0, 0, 0)");
        expectPage(focusStyle?.gradientCount).toBe(8);
        expectPage(focusStyle?.center).toBe("rgba(0, 0, 0, 0)");
        expectPage(focusStyle?.cropLeft).toBeCloseTo((focusStyle?.field.left ?? 0) - 3, 5);
        expectPage(focusStyle?.cropRight).toBeCloseTo((focusStyle?.field.right ?? 0) + 3, 5);
        expectPage(focusStyle?.cropTop).toBeCloseTo((focusStyle?.field.top ?? 0) - 3, 5);
        expectPage(focusStyle?.cropBottom).toBeCloseTo((focusStyle?.field.bottom ?? 0) + 3, 5);
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

  it("keeps modal close contrast through keyboard and hover focus", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 844 } });
    // macOS WebKit Tab skips buttons unless full keyboard access is on; Option+Tab does not.
    const tabModifier = engine === "webkit" && process.platform === "darwin" ? "Alt+" : "";
    const expectCloseColors = async (
      close: ReturnType<typeof page.getByRole>,
      background: string,
      color: string,
    ) => {
      expectPage(
        await close.evaluate((element) => {
          const style = element.ownerDocument.defaultView?.getComputedStyle(element);
          return { background: style?.backgroundColor, color: style?.color };
        }),
      ).toEqual({ background, color });
    };
    const transparent = "rgba(0, 0, 0, 0)";
    const black = "rgb(0, 0, 0)";
    const white = "rgb(255, 255, 255)";
    try {
      const configOpener = page.getByTitle("project config").first();
      await gotoFrontendFixture(page, `${origin}/`, configOpener);
      await configOpener.click();
      const config = page.getByRole("dialog");
      const configClose = config.getByRole("button", { name: "Close project config" });
      await expectCloseColors(configClose, transparent, black);
      await page.keyboard.press(`${tabModifier}Shift+Tab`);
      await expectPage(configClose).toBeFocused();
      await expectCloseColors(configClose, black, white);
      await page.keyboard.press(`${tabModifier}Tab`);
      await configClose.hover();
      await expectCloseColors(configClose, black, white);
      await page.mouse.move(0, 0);
      await expectCloseColors(configClose, transparent, black);
      await page.keyboard.press(`${tabModifier}Shift+Tab`);
      await expectPage(configClose).toBeFocused();
      await page.keyboard.press("Enter");
      await expectPage(config).toBeHidden();
      await expectPage(configOpener).toBeFocused();

      const personalOpener = page.getByRole("button", { name: "Settings" });
      await personalOpener.click();
      const personal = page.getByRole("dialog", { name: "Settings" });
      const personalClose = personal.getByRole("button", { name: "Close settings" });
      const personalEditor = personal.getByRole("textbox", { name: "Personal AGENTS.md" });
      await expectPage(personalEditor).toBeEnabled();
      await page.keyboard.press(`${tabModifier}Tab`);
      await expectPage(personal.getByRole("tab", { name: "Instructions" })).toBeFocused();
      await page.keyboard.press(`${tabModifier}Tab`);
      await expectPage(personalEditor).toBeFocused();
      await expectCloseColors(personalClose, transparent, black);
      await page.keyboard.press(`${tabModifier}Shift+Tab`);
      await page.keyboard.press(`${tabModifier}Shift+Tab`);
      await expectPage(personalClose).toBeFocused();
      await expectCloseColors(personalClose, black, white);
      await page.keyboard.press(`${tabModifier}Tab`);
      await personalClose.hover();
      await expectCloseColors(personalClose, black, white);
      await page.mouse.move(0, 0);
      await expectCloseColors(personalClose, transparent, black);
      await page.keyboard.press(`${tabModifier}Shift+Tab`);
      await expectPage(personalClose).toBeFocused();
      await page.keyboard.press("Enter");
      await expectPage(personal).toBeHidden();
      await expectPage(personalOpener).toBeFocused();
    } finally {
      await page.close();
    }
  });

  it.each([1280, 390, 320])(
    "keeps modal closes in the corner and message/command composer geometry fixed at %ipx",
    async (width) => {
      const phone = width <= 600;
      const page = await browser.newPage({
        viewport: { width, height: 844 },
        ...(phone ? { isMobile: true, hasTouch: true } : {}),
      });
      const expectModalClose = async (
        dialog: ReturnType<typeof page.getByRole>,
        closeName: string,
      ) => {
        const close = dialog.getByRole("button", { name: closeName });
        const geometry = await close.evaluate((element) => {
          const dialog = element.closest("[role='dialog']");
          const icon = element.querySelector("svg");
          const title = dialog?.querySelector("[id$='title']");
          if (dialog === null || icon === null || title === null) return null;
          const dialogBox = dialog.getBoundingClientRect();
          const closeBox = element.getBoundingClientRect();
          const iconBox = icon.getBoundingClientRect();
          return {
            bottom: closeBox.bottom,
            left: closeBox.left,
            dialogRight: dialogBox.right,
            dialogTop: dialogBox.top,
            height: closeBox.height,
            iconHeight: iconBox.height,
            iconWidth: iconBox.width,
            right: closeBox.right,
            titleRight: title.getBoundingClientRect().right,
            top: closeBox.top,
            width: closeBox.width,
          };
        });
        expectPage(geometry).not.toBeNull();
        expectPage(geometry?.top).toBeCloseTo((geometry?.dialogTop ?? 0) + 1, 5);
        expectPage(geometry?.right).toBeCloseTo((geometry?.dialogRight ?? 0) - 1, 5);
        const touchSize = closeName === "Close settings" ? 48 : 44;
        expectPage(geometry?.width).toBe(phone ? touchSize : 32);
        expectPage(geometry?.height).toBe(phone ? touchSize : 32);
        expectPage(geometry?.iconWidth).toBe(18);
        expectPage(geometry?.iconHeight).toBe(18);
        expectPage(geometry?.titleRight).toBeLessThanOrEqual(geometry?.left ?? 0);
      };
      try {
        const configOpener = page.getByTitle("project config").first();
        await gotoFrontendFixture(page, `${origin}/`, configOpener);
        await configOpener.click();
        const config = page.getByRole("dialog");
        await expectModalClose(config, "Close project config");
        const configTitle = config.locator("#project-config-title");
        const originalTitle = await configTitle.textContent();
        await configTitle.evaluate((element) => {
          element.textContent = `Config for ${"unbroken-project-name".repeat(8)}`;
        });
        await expectModalClose(config, "Close project config");
        expectPage(
          await config.locator(".project-secrets-header").evaluate((element) => ({
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
          })),
        ).toEqual({
          clientWidth: Math.min(558, width - 26),
          scrollWidth: Math.min(558, width - 26),
        });
        await configTitle.evaluate((element, title) => {
          element.textContent = title;
        }, originalTitle);
        const generalHeaderHeight = await config
          .locator(".project-secrets-header")
          .evaluate((element) => element.getBoundingClientRect().height);
        await config.getByRole("tab", { name: "Instructions" }).click();
        await expectModalClose(config, "Close project config");
        const instructionsHeaderHeight = await config
          .locator(".project-secrets-header")
          .evaluate((element) => element.getBoundingClientRect().height);
        expectPage(instructionsHeaderHeight).toBe(phone ? 44 : 32);
        expectPage(generalHeaderHeight).toBeGreaterThanOrEqual(instructionsHeaderHeight);
        await config.getByRole("button", { name: "Close project config" }).click();

        await page.getByRole("button", { name: "Settings" }).click();
        const personal = page.getByRole("dialog", { name: "Settings" });
        await expectModalClose(personal, "Close settings");
        await personal.getByRole("button", { name: "Close settings" }).click();

        await page.keyboard.press("Meta+k");
        const search = page.getByRole("dialog", { name: "Find projects and orbs" });
        await expectPage(search.getByRole("button", { name: /close/i })).toHaveCount(0);
        await page.keyboard.press("Escape");

        const composer = page.locator(".composer");
        await gotoFrontendHistory(page, `${origin}${ORB_PATH}`, "frontend-fixture-orb", composer);
        await page.addStyleTag({
          content: `@font-face { font-family: "Composer test DejaVu"; src: url(data:font/ttf;base64,${DEJAVU_MONO}); }
            .composer { font-family: "Composer test DejaVu" !important; }`,
        });
        await composer.evaluate((element) =>
          element.ownerDocument.fonts.load('13px "Composer test DejaVu"'),
        );
        expectPage(
          await composer.evaluate((element) =>
            element.ownerDocument.fonts.check('13px "Composer test DejaVu"'),
          ),
        ).toBe(true);
        const input = composer.getByRole("textbox");
        if (phone) await composer.getByRole("button", { name: "Write message" }).tap();
        const measureComposer = async (glyph: ">" | "/") => {
          const prefix = composer.locator(".composer-line > .composer-prefix");
          await expectPage(prefix).toHaveText(glyph);
          return composer.locator(".composer-line").evaluate((line) => {
            const prefix = line.querySelector(":scope > .composer-prefix");
            const editor = line.querySelector(":scope > .composer-editor");
            const input = editor?.querySelector("textarea");
            const caret = editor?.querySelector(".composer-caret");
            const composer = line.closest(".composer");
            const picker = composer?.querySelector(".command-picker");
            const view = line.ownerDocument.defaultView;
            if (
              prefix === null ||
              editor === null ||
              input === null ||
              composer === null ||
              view === null
            )
              return null;
            const prefixBox = prefix.getBoundingClientRect();
            const prefixRange = line.ownerDocument.createRange();
            prefixRange.selectNodeContents(prefix);
            const editorBox = editor.getBoundingClientRect();
            const composerBox = composer.getBoundingClientRect();
            const pickerBox = picker?.getBoundingClientRect();
            const caretBox = caret?.getBoundingClientRect();
            const gap = Number.parseFloat(view.getComputedStyle(line).columnGap);
            const prefixTextBox = prefixRange.getBoundingClientRect();
            return {
              caretLeft: caretBox?.left ?? null,
              prefixTrackWidth: prefixBox.width,
              prefixTextRight: prefixTextBox.right,
              editorLeft: editorBox.left,
              editorWidth: editorBox.width,
              gap,
              pickerLeft: pickerBox?.left ?? null,
              pickerRight: pickerBox?.right ?? null,
              expectedPickerRight: Math.min(editorBox.left + 420, composerBox.right - 12),
              selectionEnd: input.selectionEnd,
              selectionStart: input.selectionStart,
            };
          });
        };
        const expectStableEditor = (
          geometry: Awaited<ReturnType<typeof measureComposer>>,
          original: NonNullable<Awaited<ReturnType<typeof measureComposer>>>,
        ) => {
          expectPage(geometry).not.toBeNull();
          expectPage(geometry?.editorLeft).toBeCloseTo(original.editorLeft, 5);
          expectPage(geometry?.editorWidth).toBeCloseTo(original.editorWidth, 5);
          expectPage(geometry?.prefixTrackWidth).toBeCloseTo(original.prefixTrackWidth, 5);
          expectPage(geometry?.prefixTextRight).toBeLessThanOrEqual(geometry?.editorLeft ?? 0);
          expectPage(geometry?.selectionStart).toBe(0);
          expectPage(geometry?.selectionEnd).toBe(0);
          if (!phone) expectPage(geometry?.caretLeft).toBeCloseTo(original.caretLeft ?? 0, 5);
        };

        const messageGeometry = await measureComposer(">");
        expectPage(messageGeometry).not.toBeNull();
        if (messageGeometry === null) throw new Error("composer geometry unavailable");
        expectPage(messageGeometry.gap).toBeGreaterThan(0);
        expectPage(messageGeometry.gap).toBeLessThanOrEqual(9);
        expectPage(messageGeometry.prefixTextRight).toBeLessThanOrEqual(messageGeometry.editorLeft);

        // Suppress native selection notifications: normalization must update the
        // caret without depending on a later browser selection-event schedule.
        const selectionGate = await input.evaluateHandle((element) => {
          const gate = new AbortController();
          const hold = (event: Event) => event.stopImmediatePropagation();
          for (const type of ["select", "selectionchange"])
            element.ownerDocument.addEventListener(type, hold, {
              capture: true,
              signal: gate.signal,
            });
          return gate;
        });
        if (phone) {
          await composer.getByRole("button", { name: "Fold editor" }).tap();
          const collapsed = composer.locator(".composer-open");
          await expectPage(collapsed.locator(".composer-prefix")).toHaveText(">");
          const collapsedGeometry = await collapsed.evaluate((button) => {
            const prefix = button.querySelector(".composer-prefix");
            const preview = button.querySelector(".composer-draft-preview");
            if (prefix === null || preview === null) return null;
            const prefixRange = button.ownerDocument.createRange();
            prefixRange.selectNodeContents(prefix);
            return {
              prefixTrackWidth: prefix.getBoundingClientRect().width,
              prefixTextRight: prefixRange.getBoundingClientRect().right,
              previewLeft: preview.getBoundingClientRect().left,
            };
          });
          expectPage(collapsedGeometry?.prefixTrackWidth).toBeCloseTo(
            messageGeometry.prefixTrackWidth,
            5,
          );
          expectPage(collapsedGeometry?.previewLeft).toBeCloseTo(messageGeometry.editorLeft, 5);
          expectPage(collapsedGeometry?.prefixTextRight).toBeLessThanOrEqual(
            collapsedGeometry?.previewLeft ?? 0,
          );
          await collapsed.tap();
          expectStableEditor(await measureComposer(">"), messageGeometry);
        }

        await input.press("/");
        await expectPage(input).toHaveValue("");
        const commandGeometry = await measureComposer("/");
        expectStableEditor(commandGeometry, messageGeometry);
        expectPage(commandGeometry?.pickerLeft).toBeCloseTo(messageGeometry.editorLeft, 5);
        expectPage(commandGeometry?.pickerRight).toBeCloseTo(
          commandGeometry?.expectedPickerRight ?? 0,
          1,
        );
        await input.press("Escape");
        expectStableEditor(await measureComposer(">"), messageGeometry);
        await selectionGate.evaluate((gate) => gate.abort());
        await selectionGate.dispose();

        const sent = `composer geometry ${width} ${randomUUID()}`;
        const submitted = page.waitForRequest(
          (request) =>
            request.method() === "PUT" &&
            request.url().includes("/api/v1/orbs/frontend-fixture-orb/messages/"),
        );
        await input.fill(sent);
        if (phone) {
          const send = composer.getByRole("button", { name: "Send message" });
          const sendBox = await send.boundingBox();
          expectPage(sendBox?.x ?? width).toBeGreaterThanOrEqual(0);
          expectPage((sendBox?.x ?? width) + (sendBox?.width ?? 0)).toBeLessThanOrEqual(width);
          await send.tap();
        } else {
          await input.press("Control+Enter");
        }
        expectPage((await submitted).postDataJSON()).toEqual({
          content: [{ type: "text", text: sent }],
        });
        if (phone) {
          await expectPage(input).toBeHidden();
          await expectPage(composer.locator(".composer-draft-preview")).toHaveText("");
        } else await expectPage(input).toHaveValue("");
      } finally {
        await page.close();
      }
    },
  );

  it("follows the initial phone tail while default-open image details arrive", async () => {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    let releaseDetails = () => {};
    const detailsGate = new Promise<void>((resolve) => {
      releaseDetails = resolve;
    });
    await page.route("**/api/v1/orbs/frontend-fixture-orb/details/**", async (route) => {
      await detailsGate;
      await route.continue();
    });
    try {
      const firstDetail = page.waitForRequest((request) =>
        new URL(request.url()).pathname.startsWith("/api/v1/orbs/frontend-fixture-orb/details/"),
      );
      await gotoFrontendHistory(page, `${origin}${ORB_PATH}`, "frontend-fixture-orb");
      await firstDetail;
      const scroller = page.locator(".orb-transcript-scroll");
      const distanceFromTail = () =>
        scroller.evaluate(
          (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
        );
      await expectPage.poll(distanceFromTail).toBeLessThanOrEqual(1);
      releaseDetails();
      await waitForFixtureMedia(page);
      await expectPage.poll(distanceFromTail).toBeLessThanOrEqual(1);
    } finally {
      releaseDetails();
      await page.close();
    }
  });

  it.each(["wheel", "pointer", "PageUp", "Home", "ArrowUp", "Shift+Space", "focus"])(
    "preserves reader position after %s intent and content growth",
    async (intent) => {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      try {
        await gotoFrontendHistory(page, `${origin}${ORB_PATH}`, "frontend-fixture-orb");
        await waitForFixtureMedia(page);
        await expectPage(page.locator(".history .rec-q")).toHaveCount(2);
        const scroller = page.locator(".orb-transcript-scroll");
        const distance = () =>
          scroller.evaluate((pane) => pane.scrollHeight - pane.clientHeight - pane.scrollTop);
        await expectPage.poll(distance).toBeLessThanOrEqual(1);
        await scroller.evaluate((pane) => {
          pane.setAttribute("tabindex", "0");
          (pane as typeof pane & { focus(options: { preventScroll: boolean }): void }).focus({
            preventScroll: true,
          });
        });
        if (intent === "wheel") {
          await scroller.hover();
          await page.mouse.wheel(0, -500);
        } else if (intent === "pointer") {
          await scroller.hover();
          await page.mouse.down();
          await scroller.evaluate((pane) => {
            pane.scrollTop -= 500;
          });
          await page.mouse.up();
        } else if (intent === "focus") {
          await scroller.evaluate((pane) => {
            const first = pane.querySelector(".rec") as (typeof pane & { focus(): void }) | null;
            first?.setAttribute("tabindex", "0");
            first?.focus();
          });
        } else if (intent === "ArrowUp") {
          // macOS WebKit animates keyboard scrolls: a release before movement
          // cancels one and a press during one is dropped.
          const scrollSettled = () =>
            scroller.evaluate(
              (pane) =>
                new Promise<void>((resolve) => {
                  const view = pane.ownerDocument.defaultView;
                  if (!view) throw new Error("Transcript viewport window missing");
                  let previous = pane.scrollTop;
                  let stillFrames = 0;
                  const frame = () => {
                    stillFrames = pane.scrollTop === previous ? stillFrames + 1 : 0;
                    previous = pane.scrollTop;
                    if (stillFrames === 3) resolve();
                    else view.requestAnimationFrame(frame);
                  };
                  view.requestAnimationFrame(frame);
                }),
            );
          for (let press = 0; press < 3; press++) {
            const before = await distance();
            await page.keyboard.down(intent);
            await expectPage.poll(distance).toBeGreaterThan(before);
            await page.keyboard.up(intent);
            await scrollSettled();
          }
        } else {
          await page.keyboard.press(intent);
        }
        await expectPage.poll(distance).toBeGreaterThan(48);
        await scroller.evaluate((pane) => {
          // Deliver the current native offset before the same-task growth.
          pane.dispatchEvent(new Event("scroll"));
          const spacer = pane.ownerDocument.createElement("div");
          spacer.style.height = "800px";
          pane.querySelector(".orb-transcript-content")?.append(spacer);
        });
        await expectPage.poll(distance).toBeGreaterThan(800);
        const pinEdges = await page.evaluate(() =>
          (
            Reflect.get(globalThis, "window") as {
              piOrbDebug: {
                dump(): { trace: { event: string; outcome: string; contentHeight: number }[] };
              };
            }
          ).piOrbDebug
            .dump()
            .trace.filter((entry) => entry.event === "scroll_pin"),
        );
        expectPage(pinEdges.some((entry) => entry.outcome.startsWith("released:"))).toBe(true);
        expectPage(pinEdges.every((entry) => entry.contentHeight > 0)).toBe(true);
      } finally {
        await page.close();
      }
    },
  );

  it.each([390, 1280])("keeps tail intent after a no-op End key at %ipx", async (width) => {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    try {
      await gotoFrontendHistory(page, `${origin}${ORB_PATH}`, "frontend-fixture-orb");
      await waitForFixtureMedia(page);
      await expectPage(page.locator(".history .rec-q")).toHaveCount(2);
      const scroller = page.locator(".orb-transcript-scroll");
      const distance = () =>
        scroller.evaluate((pane) => pane.scrollHeight - pane.clientHeight - pane.scrollTop);
      await expectPage.poll(distance).toBeLessThanOrEqual(1);
      await scroller.evaluate((pane) => {
        pane.setAttribute("tabindex", "0");
        (pane as typeof pane & { focus(options: { preventScroll: boolean }): void }).focus({
          preventScroll: true,
        });
      });
      await page.keyboard.press("End");
      await expectPage.poll(distance).toBeLessThanOrEqual(1);
      await scroller.evaluate((pane) => {
        const spacer = pane.ownerDocument.createElement("div");
        spacer.style.height = "800px";
        pane.querySelector(".orb-transcript-content")?.append(spacer);
      });
      await expectPage.poll(distance).toBeLessThanOrEqual(1);
    } finally {
      await page.close();
    }
  });

  it.each([false, true])(
    "preserves cancelled touch pan and momentum through growth (scroll delivered: %s)",
    async (deliverScroll) => {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      let releaseFonts = () => {};
      const fontsGate = new Promise<void>((resolve) => {
        releaseFonts = resolve;
      });
      await page.route("**/fonts/*.woff2", async (route) => {
        await fontsGate;
        await route.continue();
      });
      const fontRequested = page.waitForRequest((request) => request.resourceType() === "font");
      try {
        await gotoFrontendHistory(page, `${origin}${ORB_PATH}`, "frontend-fixture-orb");
        await fontRequested;
        await waitForFixtureMedia(page);
        releaseFonts();
        // Absolute offsets are comparable only after font-swap anchor compensation.
        await page.evaluate(() =>
          Reflect.get(globalThis, "document").fonts.ready.then(() => undefined),
        );
        const scroller = page.locator(".orb-transcript-scroll");
        const distance = () =>
          scroller.evaluate((pane) => pane.scrollHeight - pane.clientHeight - pane.scrollTop);
        await expectPage.poll(distance).toBeLessThanOrEqual(1);
        await scroller.evaluate((pane, deliverScroll) => {
          const touch = (type: string, y: number) => {
            const event = new Event(type, { bubbles: true });
            Object.defineProperty(event, "touches", {
              value: type === "touchend" ? [] : [{ clientY: y }],
            });
            pane.dispatchEvent(event);
          };
          pane.dispatchEvent(
            new (Reflect.get(globalThis, "PointerEvent"))("pointerdown", {
              bubbles: true,
              pointerType: "touch",
            }),
          );
          touch("touchstart", 400);
          // Native touch scrolling cancels the pointer stream before movement settles.
          pane.dispatchEvent(
            new (Reflect.get(globalThis, "PointerEvent"))("pointercancel", {
              bubbles: true,
              pointerType: "touch",
            }),
          );
          touch("touchmove", 600);
          touch("touchend", 600);
          // Movement may continue as momentum after the finger leaves the pane.
          pane.scrollTop -= 300;
          pane.setAttribute("data-reader-top", String(pane.scrollTop));
          const spacer = pane.ownerDocument.createElement("div");
          spacer.style.height = "800px";
          pane.querySelector(".orb-transcript-content")?.append(spacer);
          if (deliverScroll) pane.dispatchEvent(new Event("scroll"));
          else
            pane.addEventListener(
              "scroll",
              (event: { stopImmediatePropagation(): void }) => event.stopImmediatePropagation(),
              { capture: true },
            );
        }, deliverScroll);
        // Allow the growth observer and its automatic scroll event to run before sampling.
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              const frame = Reflect.get(globalThis, "requestAnimationFrame");
              frame(() => frame(() => resolve()));
            }),
        );
        await expectPage.poll(distance).toBeGreaterThan(1000);
        expectPage(await scroller.evaluate((pane) => pane.scrollTop)).toBe(
          Number(await scroller.getAttribute("data-reader-top")),
        );
      } finally {
        releaseFonts();
        await page.close();
      }
    },
  );

  it.each(["inside", "outside", "cancel"])(
    "keeps tail during a stationary pointer with %s release",
    async (release) => {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      try {
        await gotoFrontendHistory(page, `${origin}${ORB_PATH}`, "frontend-fixture-orb");
        await waitForFixtureMedia(page);
        const scroller = page.locator(".orb-transcript-scroll");
        const distance = () =>
          scroller.evaluate((pane) => pane.scrollHeight - pane.clientHeight - pane.scrollTop);
        await expectPage.poll(distance).toBeLessThanOrEqual(1);
        await scroller.evaluate((pane) => {
          pane.dispatchEvent(
            new (Reflect.get(globalThis, "PointerEvent"))("pointerdown", { bubbles: true }),
          );
          const spacer = pane.ownerDocument.createElement("div");
          spacer.id = "pointer-spacer";
          spacer.style.height = "800px";
          pane.querySelector(".orb-transcript-content")?.append(spacer);
        });
        await expectPage.poll(distance).toBeLessThanOrEqual(1);
        await scroller.evaluate((pane, release) => {
          const target = release === "inside" ? pane : pane.ownerDocument.body;
          target.dispatchEvent(
            new (Reflect.get(globalThis, "PointerEvent"))(
              release === "cancel" ? "pointercancel" : "pointerup",
              {
                bubbles: true,
              },
            ),
          );
          const spacer = pane.querySelector("#pointer-spacer") as { style: { height: string } };
          spacer.style.height = "0px";
          pane.setAttribute("data-clamped-top", String(pane.scrollTop));
          spacer.style.height = "1600px";
          // The released gesture must no longer suppress native geometry protection.
          pane.addEventListener(
            "scroll",
            (event: { stopImmediatePropagation(): void }) => event.stopImmediatePropagation(),
            { capture: true },
          );
        }, release);
        await expectPage.poll(distance).toBeLessThanOrEqual(1);
      } finally {
        await page.close();
      }
    },
  );

  it("keeps tail when a stationary pointer precedes the auto-scroll event", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
      await gotoFrontendHistory(page, `${origin}${ORB_PATH}`, "frontend-fixture-orb");
      await waitForFixtureMedia(page);
      const scroller = page.locator(".orb-transcript-scroll");
      const distance = () =>
        scroller.evaluate((pane) => pane.scrollHeight - pane.clientHeight - pane.scrollTop);
      await expectPage.poll(distance).toBeLessThanOrEqual(1);
      await scroller.evaluate(
        (pane) =>
          new Promise<void>((resolve) => {
            const content = pane.querySelector(".orb-transcript-content");
            const div = (height: string) => {
              const element = pane.ownerDocument.createElement("div");
              element.style.height = height;
              return element;
            };
            let armed = false;
            // Registered after the page's observer, so it runs after the tail
            // write and before that write's scroll event in the next frame.
            const observer = new (Reflect.get(globalThis, "ResizeObserver"))(() => {
              if (!armed) {
                armed = true;
                setTimeout(() => content?.append(div("100px")));
                return;
              }
              observer.disconnect();
              pane.dispatchEvent(
                new (Reflect.get(globalThis, "PointerEvent"))("pointerdown", { bubbles: true }),
              );
              content?.append(div("800px"));
              resolve();
            });
            observer.observe(content);
          }),
      );
      await expectPage.poll(distance).toBeLessThanOrEqual(1);
      await scroller.evaluate((pane) =>
        pane.dispatchEvent(
          new (Reflect.get(globalThis, "PointerEvent"))("pointerup", { bubbles: true }),
        ),
      );
    } finally {
      await page.close();
    }
  });

  it.each([
    [390, 0, 500],
    [1280, 0, 500],
    [390, 500, 0],
    [1280, 500, 0],
    [390, 0, 0],
  ])("keeps tail after no-op wheel at %ipx (%i, %i)", async (width, dx, dy) => {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    try {
      await gotoFrontendHistory(page, `${origin}${ORB_PATH}`, "frontend-fixture-orb");
      await waitForFixtureMedia(page);
      const scroller = page.locator(".orb-transcript-scroll");
      const distance = () =>
        scroller.evaluate((pane) => pane.scrollHeight - pane.clientHeight - pane.scrollTop);
      await expectPage.poll(distance).toBeLessThanOrEqual(1);
      if (dx > 0) {
        await scroller.evaluate((pane) => {
          const code = pane.ownerDocument.createElement("div");
          code.id = "wheel-code";
          code.style.cssText = "overflow-x:auto;width:200px;height:40px";
          const line = pane.ownerDocument.createElement("div");
          line.style.cssText = "width:2000px;height:20px";
          code.append(line);
          pane.querySelector(".orb-transcript-content")?.append(code);
        });
        await expectPage.poll(distance).toBeLessThanOrEqual(1);
        await scroller.locator("#wheel-code").hover();
      } else {
        await scroller.hover();
      }
      await scroller.evaluate((pane) => {
        pane.addEventListener("wheel", () => pane.setAttribute("data-wheel-seen", "yes"), {
          once: true,
        });
      });
      if (dx === 0 && dy === 0) {
        await scroller.evaluate((pane) =>
          pane.dispatchEvent(new (Reflect.get(globalThis, "WheelEvent"))("wheel")),
        );
      } else {
        await page.mouse.wheel(dx, dy);
      }
      await expectPage(scroller).toHaveAttribute("data-wheel-seen", "yes");
      await scroller.evaluate((pane) => {
        const spacer = pane.ownerDocument.createElement("div");
        spacer.style.height = "800px";
        pane.querySelector(".orb-transcript-content")?.append(spacer);
      });
      await expectPage.poll(distance).toBeLessThanOrEqual(1);
    } finally {
      await page.close();
    }
  });

  it.each([false, true])(
    "keeps tail when clamping precedes resize (scroll delivered: %s)",
    async (deliverScroll) => {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      try {
        await gotoFrontendHistory(page, `${origin}${ORB_PATH}`, "frontend-fixture-orb");
        await waitForFixtureMedia(page);
        await expectPage(page.locator(".history .rec-q")).toHaveCount(2);
        const scroller = page.locator(".orb-transcript-scroll");
        await scroller.evaluate((pane) => {
          const spacer = pane.ownerDocument.createElement("div");
          spacer.id = "pin-growth-spacer";
          spacer.style.height = "400px";
          pane.querySelector(".orb-transcript-content")?.append(spacer);
        });
        const distance = () =>
          scroller.evaluate((pane) => pane.scrollHeight - pane.clientHeight - pane.scrollTop);
        await expectPage.poll(distance).toBeLessThanOrEqual(1);
        await scroller.evaluate((pane, deliverScroll) => {
          const spacer = pane.querySelector("#pin-growth-spacer") as {
            style: { height: string };
          } | null;
          if (!spacer) return;
          spacer.style.height = "0px";
          // Force native range clamping, then grow before the observer can run.
          const clamped = pane.scrollTop;
          spacer.style.height = "800px";
          pane.setAttribute("data-clamped-top", String(clamped));
          if (deliverScroll) pane.dispatchEvent(new Event("scroll"));
          else
            pane.addEventListener(
              "scroll",
              (event: { stopImmediatePropagation(): void }) => event.stopImmediatePropagation(),
              {
                capture: true,
              },
            );
        }, deliverScroll);
        await expectPage.poll(distance).toBeLessThanOrEqual(1);
      } finally {
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
      const write = page.getByRole("button", { name: "Write message" });
      await gotoFrontendHistory(page, `${origin}${ORB_PATH}`, "frontend-fixture-orb", write);
      await expectPage(write).toBeVisible();
      await waitForFixtureMedia(page);
      await expectPage(page.locator(".history .rec-q")).toHaveCount(2);
      await page.clock.runFor(100);
      const scroller = page.locator(".orb-transcript-scroll");
      await scroller.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
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

  it("keeps phone transcript pixels after a native wheel scroll round trip", async (ctx) => {
    // WebKit's mobile automation does not implement wheel input. Use its desktop
    // input backend at phone width to exercise native scrolling and raster output.
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    ctx.onTestFinished(() => page.close());
    const captures = join("test-failures", `mobile-wheel-${engine}-${randomUUID()}`);
    try {
      const scroller = page.locator(".orb-transcript-scroll");
      const write = page.getByRole("button", { name: "Write message" });
      await gotoFrontendHistory(
        page,
        `${origin}/orbs/frontend-long-history`,
        "frontend-long-history",
        write,
      );
      await expectPage(write).toBeVisible();
      await expectPage
        .poll(() => scroller.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(0);
      const rows = scroller.locator("[data-history-row]");
      const stableLayout = () =>
        scroller.evaluate(
          (element) =>
            new Promise<void>((resolve) => {
              const view = element.ownerDocument.defaultView;
              if (!view) throw new Error("Transcript viewport window missing");
              let previous = "";
              const frame = () => {
                const current = JSON.stringify([
                  element.scrollTop,
                  element.scrollHeight,
                  [...element.querySelectorAll("[data-history-row]")].map((row) => [
                    row.getAttribute("data-history-row"),
                    row.getBoundingClientRect().top,
                    row.getBoundingClientRect().height,
                  ]),
                ]);
                if (current === previous) resolve();
                else {
                  previous = current;
                  view.requestAnimationFrame(frame);
                }
              };
              view.requestAnimationFrame(frame);
            }),
        );
      const wheel = async (deltaY: number) => {
        await scroller.evaluate(armNativeWheel);
        await page.mouse.wheel(0, deltaY);
        await scroller.evaluate((element) => Reflect.get(element, "wheelFinished"));
        await stableLayout();
      };
      await expectPage(rows).toHaveCount(20);
      await stableLayout();
      await page.mouse.move(195, 350);
      // Native upward crossings prepend twenty-row batches and preserve the old anchor.
      let count = 20;
      while (count < 200) {
        await wheel(-1000000);
        await expectPage.poll(() => rows.count()).toBeGreaterThan(count);
        await expectPage
          .poll(() => scroller.evaluate((element) => element.scrollTop))
          .toBeGreaterThan(0);
        await stableLayout();
        const materialized = await rows.count();
        expectPage(materialized).toBeGreaterThan(count);
        expectPage(materialized).toBeLessThanOrEqual(200);
        expectPage((materialized - count) % 20).toBe(0);
        count = materialized;
        // Restored downward scrolls must not fill another batch without upward input.
        await stableLayout();
        await expectPage(rows).toHaveCount(count);
      }
      await expectPage(rows.first()).toHaveAttribute("data-history-row", "long-history-0");
      if ((await scroller.evaluate((element) => element.scrollTop)) > 0) await wheel(-1000000);
      await expectPage.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(0);
      await stableLayout();
      const before = await scroller.screenshot({ path: join(captures, "before.png") });
      await wheel(1200);
      await expectPage
        .poll(() => scroller.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(0);
      await wheel(-1000000);
      await expectPage.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(0);
      await stableLayout();
      expectPage(await scroller.screenshot({ path: join(captures, "after.png") })).toEqual(before);
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
    await fakeVisualViewport(page, 390, 844);
    try {
      const composer = page.locator(".composer");
      await gotoFrontendHistory(
        page,
        `${origin}/orbs/frontend-long-history`,
        "frontend-long-history",
        composer,
      );
      const scroller = page.locator(".orb-transcript-scroll");
      await expectPage(page.locator(".orb-main")).toHaveCSS("overflow", "hidden");
      await expectPage(scroller).toHaveCSS("overflow", "auto");
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
      await page.evaluate("window.setVisualViewport(390, 61)");
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
        await page.evaluate(`window.setVisualViewport(${height}, ${top})`);
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
      await page.evaluate("window.setVisualViewport(260, 20, 2)");
      await expectPage(app).toHaveCSS("height", "520px");
      await composer.getByRole("button", { name: "Fold editor" }).tap();
      await page.evaluate("window.setVisualViewport(844, 0)");
      await expectPage(app).toHaveCSS("height", "844px");
      await composer.getByRole("button", { name: "Write message" }).tap();
      await expectPage(composer.getByRole("textbox")).toHaveValue(
        "keep this draft while the keyboard moves",
      );
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.evaluate("window.setVisualViewport(900, 0)");
      await expectPage(page.locator(".orb-index")).toBeVisible();
      await expectPage(scroller).toHaveCSS("display", "block");
      await expectPage(app).toHaveCSS("top", "0px");
      await expectPage(app).toHaveCSS("height", "900px");
    } finally {
      await page.close();
    }
  });

  it("keeps the iPad desktop layout inside a shrunken, panned visual viewport", async () => {
    const page = await browser.newPage({
      viewport: { width: 1180, height: 820 },
      isMobile: true,
      hasTouch: true,
    });
    // iPadOS's floating input-assistant bar shrinks the visual viewport and pans it down.
    await fakeVisualViewport(page, 1180, 820);
    try {
      const composer = page.getByRole("textbox", { name: "Message the orb", exact: true });
      await gotoFrontendHistory(page, `${origin}${ORB_PATH}`, "frontend-fixture-orb", composer);
      const app = page.locator(".app");
      await composer.focus();
      for (const [height, top] of [
        [504, 316],
        [640, 120],
        [820, 0],
      ] as const) {
        await page.evaluate(`window.setVisualViewport(${height}, ${top})`);
        await expectPage(app).toHaveCSS("top", `${top}px`);
        await expectPage(app).toHaveCSS("height", `${height}px`);
        const bounds = await page.locator(".app").evaluate((element) => {
          const rect = (selector: string) => {
            const { top, bottom } = element.querySelector(selector).getBoundingClientRect();
            return { top, bottom };
          };
          return {
            header: rect(".orb-header"),
            composer: rect(".composer"),
            index: rect(".orb-index"),
          };
        });
        expectPage(bounds.header.top).toBe(top);
        expectPage(bounds.composer.bottom).toBe(height + top);
        expectPage(bounds.index).toEqual({ top, bottom: height + top });
        expectPage(await page.evaluate("window.scrollY")).toBe(0);
        await expectPage(composer).toBeFocused();
      }
    } finally {
      await page.close();
    }
  });

  it.each(["visibilitychange", "pageshow", "focus"])(
    "resamples iPad viewport geometry on %s without resize or scroll events",
    async (event) => {
      const page = await browser.newPage({
        viewport: { width: 1180, height: 820 },
        isMobile: true,
        hasTouch: true,
      });
      await fakeVisualViewport(page, 1180, 820);
      try {
        const composer = page.getByRole("textbox", { name: "Message the orb", exact: true });
        await gotoFrontendHistory(
          page,
          `${origin}/orbs/frontend-long-history`,
          "frontend-long-history",
          composer,
        );
        await composer.fill("keep this draft across resume");
        const scroller = page.locator(".orb-transcript-scroll");
        const resume = async (height: number, top: number) => {
          await page.evaluate(`
            Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
            document.dispatchEvent(new Event('visibilitychange'));
            window.setVisualViewport(${height}, ${top}, 1, false);
            Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
            ${event === "visibilitychange" ? "document" : "window"}.dispatchEvent(new Event('${event}'));
          `);
          await expectPage(page.locator(".app")).toHaveCSS("height", `${height}px`);
          const bounds = await page.locator(".app").evaluate((element) => {
            const rect = (selector: string) => {
              const { top, bottom } = element.querySelector(selector).getBoundingClientRect();
              return { top, bottom };
            };
            return {
              header: rect(".orb-header"),
              reading: rect(".orb-transcript-scroll"),
              composer: rect(".composer"),
              index: rect(".orb-index"),
            };
          });
          expectPage(bounds.header.top).toBe(top);
          expectPage(bounds.reading.top).toBe(bounds.header.bottom);
          expectPage(bounds.reading.bottom).toBe(bounds.composer.top);
          expectPage(bounds.composer.bottom).toBe(height + top);
          expectPage(bounds.index).toEqual({ top, bottom: height + top });
          expectPage(await page.evaluate("window.scrollY")).toBe(0);
        };
        await expectPage
          .poll(() =>
            scroller.evaluate(
              (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
            ),
          )
          .toBeLessThanOrEqual(1);
        await resume(504, 120);
        await expectPage
          .poll(() =>
            scroller.evaluate(
              (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
            ),
          )
          .toBeLessThanOrEqual(1);
        await scroller.evaluate((element) => {
          element.scrollTop = 200;
          element.dispatchEvent(new Event("scroll"));
        });
        await resume(640, 0);
        expectPage(await scroller.evaluate((element) => element.scrollTop)).toBe(200);
        await expectPage(composer).toHaveValue("keep this draft across resume");
        expectPage(
          await page.evaluate(() =>
            Reflect.get(globalThis, "piOrbDebug")
              .dump()
              .trace.filter((entry: { event: string }) => entry.event === "viewport")
              .map(
                (entry: {
                  outcome: string;
                  viewportHeight: number;
                  viewportOffsetTop: number;
                }) => ({
                  outcome: entry.outcome,
                  viewportHeight: entry.viewportHeight,
                  viewportOffsetTop: entry.viewportOffsetTop,
                }),
              ),
          ),
        ).toEqual([
          {
            outcome: event === "visibilitychange" ? "visible" : event,
            viewportHeight: 504,
            viewportOffsetTop: 120,
          },
          {
            outcome: event === "visibilitychange" ? "visible" : event,
            viewportHeight: 640,
            viewportOffsetTop: 0,
          },
        ]);
      } finally {
        await page.close();
      }
    },
  );

  it.each([
    { action: "connect", fail: false },
    { action: "add", fail: false },
    { action: "connect", fail: true },
    { action: "add", fail: true },
  ] as const)(
    "hands MCP $action to a separate browser before starting cookie-bound consent (launch failure: $fail)",
    async ({ action, fail }) => {
      const projectId = randomUUID();
      const id = randomUUID();
      const path = `/projects/${projectId}/mcp`;
      const page = await browser.newPage();
      const safari = await browser.newPage();
      const posts: string[] = [];
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      let connected = false;
      const connection = {
        name: "auth-handoff",
        description: "fixture",
        url: "https://mcp.example/mcp",
        headers: {},
        oauth: { id },
      };
      await page.addInitScript(`
        if (navigator.standalone !== true) {
          Object.defineProperty(navigator, "standalone", { value: true });
          Object.defineProperty(navigator, "maxTouchPoints", { value: 5 });
        }
      `);
      try {
        if (fail) {
          await page.route("**/src/lib/safari-links.ts*", async (route) => {
            const response = await route.fetch();
            const body = await response.text();
            // Inject a platform throw at the adapter, not a production failure switch.
            const assignment = "() => host.location.assign(url)";
            expectPage(body).toContain(assignment);
            await route.fulfill({
              response,
              body: body.replace(assignment, '() => { throw new Error("synthetic private URL"); }'),
            });
          });
        }
        expectPage(
          (
            await page.request.post(`${origin}/api/v1/projects`, {
              data: {
                id: projectId,
                name: "Auth handoff",
                repositoryUrl: "https://github.com/example/auth",
              },
            })
          ).status(),
        ).toBe(201);
        if (action === "connect") {
          expectPage(
            (
              await page.request.put(`${origin}/api/v1/projects/${projectId}/mcp`, {
                data: { revision: 0, servers: [connection] },
              })
            ).status(),
          ).toBe(200);
        }
        for (const [owner, label] of [
          [page, "pwa"],
          [safari, "safari"],
        ] as const) {
          await owner.route(`**/api/v1/projects/${projectId}/mcp/*/oauth{,/**}`, async (route) => {
            if (route.request().method() === "POST") {
              posts.push(label);
              await route.fulfill({
                headers: {
                  "set-cookie": "handoff_nonce=safari-only; HttpOnly; SameSite=Lax; Path=/",
                },
                json: { url: "https://consent.example/authorize" },
              });
            } else
              await route.fulfill({ json: { status: connected ? "connected" : "auth_required" } });
          });
          await owner.route("https://consent.example/**", (route) =>
            route.fulfill({ contentType: "text/html", body: "<p>Synthetic consent</p>" }),
          );
        }
        await gotoFrontendFixture(page, `${origin}${path}`);
        const mcp = page.getByRole("tabpanel", { name: "MCPs", exact: true });
        if (action === "connect") await mcp.locator("summary").click();
        else {
          await mcp.getByRole("button", { name: "add server", exact: true }).click();
          const add = mcp.locator(".mcp-add-area");
          await add.getByLabel("Name", { exact: true }).fill(connection.name);
          await add.getByLabel("Endpoint", { exact: true }).fill(connection.url);
        }
        const next = fail
          ? null
          : page.waitForRequest(
              (request) =>
                request.url().startsWith("x-safari-") ||
                (request.method() === "POST" && request.url().endsWith("/oauth/connect")),
            );
        await mcp
          .getByRole("button", {
            name: action === "connect" ? "connect" : "add & connect",
            exact: true,
          })
          .click();
        if (next) expectPage((await next).url()).toBe(`x-safari-${origin}${path}`);
        else await expectPage(mcp.getByRole("alert")).toContainText("Could not open Safari");
        expectPage(posts).toEqual([]);
        expectPage(page.url()).toBe(`${origin}${path}`);
        await expectPage(mcp.getByRole("button", { name: "connect", exact: true })).toBeEnabled();
        await expectPage(page.getByRole("button", { name: "Close project config" })).toBeEnabled();
        const saved = await (
          await page.request.get(`${origin}/api/v1/projects/${projectId}/mcp`)
        ).json();
        expectPage(saved.servers.map((server: { name: string }) => server.name)).toEqual([
          connection.name,
        ]);
        if (fail) {
          expectPage(errors).toEqual([]);
          await expectPage(mcp).not.toContainText("synthetic private URL");
          return;
        }
        await gotoFrontendFixture(safari, `${origin}${path}`);
        const received = safari.getByRole("tabpanel", { name: "MCPs", exact: true });
        await received.locator("summary").click();
        expectPage(posts).toEqual([]);
        await received.getByRole("button", { name: "connect", exact: true }).click();
        await expectPage(safari).toHaveURL("https://consent.example/authorize");
        expectPage(posts).toEqual(["safari"]);
        expectPage(
          (await safari.context().cookies(origin)).some(
            (cookie) => cookie.name === "handoff_nonce",
          ),
        ).toBe(true);
        expectPage(
          (await page.context().cookies(origin)).some((cookie) => cookie.name === "handoff_nonce"),
        ).toBe(false);
        connected = true;
        // A home-screen return can deliver visibilitychange without window focus.
        await page.evaluate('document.dispatchEvent(new Event("visibilitychange"))');
        await expectPage(mcp.locator("summary")).toContainText("grant stored");
        await expectPage(
          mcp.getByRole("button", { name: "disconnect", exact: true }),
        ).toBeEnabled();
      } finally {
        await closeRoutedPage(page);
        await closeRoutedPage(safari);
        expectPage(
          (await fetch(`${origin}/api/v1/projects/${projectId}`, { method: "DELETE" })).status,
        ).toBe(202);
      }
    },
  );

  it("hands Claude consent to Safari without opening an in-app tab", async () => {
    const page = await browser.newPage();
    await page.addInitScript(`
      Object.defineProperty(navigator, "standalone", { value: true });
      Object.defineProperty(navigator, "maxTouchPoints", { value: 5 });
    `);
    await mockClaudeOwnerConnection(page);
    const popups: Page[] = [];
    page.on("popup", (popup) => popups.push(popup));
    try {
      await gotoFrontendFixture(page, `${origin}/`);
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
      await dialog.getByRole("tab", { name: "Claude", exact: true }).click();
      const handoff = page.waitForRequest((request) => request.url().startsWith("x-safari-"));
      await dialog
        .getByRole("button", { name: "Connect Claude subscription", exact: true })
        .click();
      expectPage((await handoff).url()).toBe(
        "x-safari-https://claude.ai/oauth/authorize?fixture=1",
      );
      expectPage(popups).toEqual([]);
      await expectPage(dialog.getByLabel("Claude completion code")).toBeEnabled();
    } finally {
      await closeRoutedPage(page);
    }
  });

  it.each([true, false])(
    "opens external transcript links in Safari only from an iOS home-screen app (standalone %s)",
    async (standalone) => {
      const page = await browser.newPage({
        viewport: { width: 1180, height: 820 },
        isMobile: true,
        hasTouch: true,
      });
      await page
        .context()
        .route("https://example.com/**", (route) =>
          route.fulfill({ contentType: "text/html", body: "<title>external</title>" }),
        );
      // Playwright's WebKit reruns init scripts in the same document after the
      // unhandled-scheme navigation, so the script must be idempotent.
      await page.addInitScript(`
        if (window.linkClicks === undefined) {
          window.linkClicks = [];
          window.addEventListener("click", (event) => window.linkClicks.push(event.defaultPrevented));
          if (${standalone}) {
            Object.defineProperty(navigator, "standalone", { value: true });
            Object.defineProperty(navigator, "maxTouchPoints", { value: 5 });
          }
        }
      `);
      try {
        await gotoFrontendHistory(
          page,
          `${origin}${ORB_PATH}`,
          "frontend-fixture-orb",
          page.locator(".history"),
        );
        const link = page.locator('.history a[href="https://example.com/history"]');
        await expectPage(link).toHaveAttribute("target", "_blank");
        if (standalone) {
          // Navigation to the unhandled scheme surfaces as a request in both engines.
          const safari = page.waitForRequest((request) => request.url().startsWith("x-safari-"));
          await link.click();
          expectPage((await safari).url()).toBe("x-safari-https://example.com/history");
        } else {
          const popup = page.waitForEvent("popup");
          await link.click();
          const opened = await popup;
          await opened.waitForLoadState();
          expectPage(opened.url()).toBe("https://example.com/history");
        }
        await expectPage.poll(() => page.evaluate("window.linkClicks")).toEqual([standalone]);
        expectPage(page.url()).toBe(`${origin}${ORB_PATH}`);
      } finally {
        await page.close();
      }
    },
  );

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
      await gotoFrontendHistory(
        page,
        `${origin}${ORB_PATH}`,
        "frontend-fixture-orb",
        page.locator(".composer"),
      );
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
