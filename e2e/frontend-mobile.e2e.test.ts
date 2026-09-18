import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Browser, chromium, expect as expectPage, webkit } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";

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
        await page.getByRole("button", { name: "Rename orb" }).tap();
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
      await page.goto(`${origin}/`);
      const configOpener = page.getByTitle("project config").first();
      await configOpener.click();
      const config = page.getByRole("dialog");
      const configClose = config.getByRole("button", { name: "Close project config" });
      await expectCloseColors(configClose, transparent, black);
      await page.keyboard.press("Shift+Tab");
      await expectPage(configClose).toBeFocused();
      await expectCloseColors(configClose, black, white);
      await page.keyboard.press("Tab");
      await configClose.hover();
      await expectCloseColors(configClose, black, white);
      await page.mouse.move(0, 0);
      await expectCloseColors(configClose, transparent, black);
      await page.keyboard.press("Shift+Tab");
      await expectPage(configClose).toBeFocused();
      await page.keyboard.press("Enter");
      await expectPage(config).toBeHidden();
      await expectPage(configOpener).toBeFocused();

      const personalOpener = page.getByRole("button", { name: "Personal instructions" });
      await personalOpener.click();
      const personal = page.getByRole("dialog", { name: "~/AGENTS.md" });
      const personalClose = personal.getByRole("button", { name: "Close personal instructions" });
      const personalEditor = personal.getByRole("textbox", { name: "Personal AGENTS.md" });
      await expectPage(personalEditor).toBeEnabled();
      await page.keyboard.press("Tab");
      await expectPage(personalEditor).toBeFocused();
      await expectCloseColors(personalClose, transparent, black);
      await page.keyboard.press("Shift+Tab");
      await expectPage(personalClose).toBeFocused();
      await expectCloseColors(personalClose, black, white);
      await page.keyboard.press("Tab");
      await personalClose.hover();
      await expectCloseColors(personalClose, black, white);
      await page.mouse.move(0, 0);
      await expectCloseColors(personalClose, transparent, black);
      await page.keyboard.press("Shift+Tab");
      await expectPage(personalClose).toBeFocused();
      await page.keyboard.press("Enter");
      await expectPage(personal).toBeHidden();
      await expectPage(personalOpener).toBeFocused();
    } finally {
      await page.close();
    }
  });

  it.each([1280, 390, 320])(
    "keeps modal closes in the corner and composer geometry fixed across modes at %ipx",
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
        expectPage(geometry?.width).toBe(phone ? 44 : 32);
        expectPage(geometry?.height).toBe(phone ? 44 : 32);
        expectPage(geometry?.iconWidth).toBe(18);
        expectPage(geometry?.iconHeight).toBe(18);
        expectPage(geometry?.titleRight).toBeLessThanOrEqual(geometry?.left ?? 0);
      };
      try {
        await page.goto(`${origin}/`);
        await page.getByTitle("project config").first().click();
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

        await page.getByRole("button", { name: "Personal instructions" }).click();
        const personal = page.getByRole("dialog", { name: "~/AGENTS.md" });
        await expectModalClose(personal, "Close personal instructions");
        await personal.getByRole("button", { name: "Close personal instructions" }).click();

        await page.keyboard.press("Meta+k");
        const search = page.getByRole("dialog", { name: "Find projects and orbs" });
        await expectPage(search.getByRole("button", { name: /close/i })).toHaveCount(0);
        await page.keyboard.press("Escape");

        await page.goto(`${origin}/${ORB_HASH}`);
        const composer = page.locator(".composer");
        const input = composer.getByRole("textbox");
        if (phone) await composer.getByRole("button", { name: "Write message" }).tap();
        const measureComposer = async (glyph: ">" | "!" | "!!" | "/") => {
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
            return {
              caretLeft: caretBox?.left ?? null,
              columnWidth: editorBox.left - gap - line.getBoundingClientRect().left,
              editorLeft: editorBox.left,
              editorWidth: editorBox.width,
              gap,
              pickerLeft: pickerBox?.left ?? null,
              pickerRight: pickerBox?.right ?? null,
              expectedPickerRight: Math.min(editorBox.left + 420, composerBox.right - 12),
              prefixTextWidth: prefixRange.getBoundingClientRect().width,
              prefixWidth: prefixBox.width,
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
          expectPage(geometry?.columnWidth).toBeCloseTo(original.columnWidth, 5);
          expectPage(geometry?.selectionStart).toBe(0);
          expectPage(geometry?.selectionEnd).toBe(0);
          if (!phone) expectPage(geometry?.caretLeft).toBeCloseTo(original.caretLeft ?? 0, 5);
        };

        const messageGeometry = await measureComposer(">");
        expectPage(messageGeometry).not.toBeNull();
        if (messageGeometry === null) throw new Error("composer geometry unavailable");
        expectPage(messageGeometry.gap).toBeGreaterThan(0);
        expectPage(messageGeometry.gap).toBeLessThanOrEqual(9);

        await input.fill("!");
        await expectPage(input).toHaveAttribute("aria-label", "Run a shell command");
        const shellGeometry = await measureComposer("!");
        expectStableEditor(shellGeometry, messageGeometry);
        await input.fill("!");
        const excludedGeometry = await measureComposer("!!");
        expectStableEditor(excludedGeometry, messageGeometry);
        expectPage(excludedGeometry?.prefixTextWidth).toBeGreaterThan(
          shellGeometry?.prefixTextWidth ?? Number.POSITIVE_INFINITY,
        );
        expectPage(excludedGeometry?.prefixWidth).toBeCloseTo(
          excludedGeometry?.columnWidth ?? 0,
          2,
        );

        if (phone) {
          await composer.getByRole("button", { name: "Fold editor" }).tap();
          const collapsed = composer.locator(".composer-open");
          await expectPage(collapsed.locator(".composer-prefix")).toHaveText("!!");
          const collapsedGeometry = await collapsed.evaluate((button) => {
            const prefix = button.querySelector(".composer-prefix");
            const preview = button.querySelector(".composer-draft-preview");
            const view = button.ownerDocument.defaultView;
            if (prefix === null || preview === null || view === null) return null;
            const gap = Number.parseFloat(view.getComputedStyle(button).columnGap);
            return {
              columnWidth:
                preview.getBoundingClientRect().left - gap - button.getBoundingClientRect().left,
              previewLeft: preview.getBoundingClientRect().left,
              prefixWidth: prefix.getBoundingClientRect().width,
            };
          });
          expectPage(collapsedGeometry?.columnWidth).toBeCloseTo(messageGeometry.columnWidth, 5);
          expectPage(collapsedGeometry?.previewLeft).toBeCloseTo(messageGeometry.editorLeft, 5);
          expectPage(collapsedGeometry?.prefixWidth).toBeCloseTo(
            excludedGeometry?.prefixWidth ?? 0,
            5,
          );
          await collapsed.tap();
          expectStableEditor(await measureComposer("!!"), messageGeometry);
        }

        await input.press("Backspace");
        expectStableEditor(await measureComposer("!"), messageGeometry);
        await input.press("Backspace");
        expectStableEditor(await measureComposer(">"), messageGeometry);
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
