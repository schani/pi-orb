import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Browser, chromium, expect as expectPage } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, it } from "vitest";

const WEB_ROOT = join(import.meta.dirname, "../apps/web");
const ORB_HASH = "#/orbs/frontend-fixture-orb";
let vite: ViteDevServer;
let browser: Browser;
let origin: string;

/**
 * Browser E2E for the exact cross-boundary path that unit tests cannot prove:
 * Vite fixture control -> IAP-shaped HTML 401 -> shared API adapter -> React
 * ribbon -> same-tab top-level auth round trip -> draft/session restoration.
 */
describe("frontend-only browser behavior", () => {
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
      throw new Error("frontend E2E Vite server did not own a TCP port");
    }
    origin = `http://127.0.0.1:${address.port}`;

    const configuredExecutable = process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"];
    const systemExecutable = existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined;
    browser = await chromium.launch({
      ...(configuredExecutable !== undefined
        ? { executablePath: configuredExecutable }
        : systemExecutable !== undefined
          ? { executablePath: systemExecutable }
          : {}),
      args: ["--no-sandbox"],
    });
  });

  afterAll(async () => {
    await browser?.close();
    await vite?.close();
  });

  it("keeps the index and conversation visible until an orb switch is ready", async () => {
    const page = await browser.newPage();
    await page.goto(`${origin}/${ORB_HASH}`);
    const composer = page.getByPlaceholder(/Message the orb/);
    await composer.fill("draft for the first orb");
    const index = page.getByRole("navigation", { name: "Project orbs" });
    const destination = index.locator('a[href="#/orbs/frontend-auth-copy-test"]');
    await expectPage(destination).toBeVisible();
    const indexNode = await index.elementHandle();
    const destinationNode = await destination.elementHandle();
    const oldHistory = await page.locator(".history").innerText();
    let release = () => {};
    let arrived = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requested = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    await page.route("**/api/v1/orbs/frontend-auth-copy-test/history", async (route) => {
      const response = await route.fetch();
      arrived();
      await gate;
      await route.fulfill({ response });
    });
    try {
      await destination.click();
      await requested;
      await expectPage(destination).toHaveAttribute("aria-current", "page");
      await expectPage(index).toHaveAttribute("aria-busy", "true");
      await expectPage(page.locator(".orb-main")).toHaveAttribute("inert", "");
      await expectPage(composer).toHaveValue("draft for the first orb");
      expectPage(await page.locator(".history").innerText()).toBe(oldHistory);
      release();
      await expectPage(index).toHaveAttribute("aria-busy", "false");
      await expectPage(page.getByText("COPY-2468")).toBeVisible();
      await expectPage(composer).toHaveValue("");
      expectPage(
        await indexNode?.evaluate(
          (node) => node === node.ownerDocument.querySelector(".orb-index"),
        ),
      ).toBe(true);
      expectPage(await destinationNode?.evaluate((node) => node.isConnected)).toBe(true);
      await index.locator(`a[href="${ORB_HASH}"]`).click();
      await expectPage(index).toHaveAttribute("aria-busy", "false");
      await expectPage(composer).toHaveValue("draft for the first orb");
      await expectPage(composer).toBeFocused();
    } finally {
      release();
      await page.close();
    }
  });

  it("discards a superseded orb load and preserves missing-resource URLs", async () => {
    const page = await browser.newPage();
    await page.goto(`${origin}/${ORB_HASH}`);
    const index = page.getByRole("navigation", { name: "Project orbs" });
    const destination = index.locator('a[href="#/orbs/frontend-auth-copy-test"]');
    await expectPage(destination).toBeVisible();
    let release = () => {};
    let arrived = () => {};
    let finished = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requested = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const completed = new Promise<void>((resolve) => {
      finished = resolve;
    });
    await page.route("**/api/v1/orbs/frontend-auth-copy-test/history", async (route) => {
      const response = await route.fetch();
      arrived();
      await gate;
      await route.fulfill({ response });
      finished();
    });
    try {
      await destination.click();
      await requested;
      await index.evaluate((node) => {
        node.ownerDocument.location.hash = "#/orbs/missing-switch-target";
      });
      await expectPage(page.getByText("Orb doesn't exist")).toBeVisible();
      const response = page.waitForResponse("**/api/v1/orbs/frontend-auth-copy-test/history");
      release();
      await completed;
      await (await response).finished();
      // A browser task after the response lets React process any stale completion.
      await index.evaluate(
        (node) =>
          new Promise<void>((resolve) =>
            node.ownerDocument.defaultView?.requestAnimationFrame(() => resolve()),
          ),
      );
      await expectPage(page.getByText("Orb doesn't exist")).toBeVisible();
      expectPage(page.url()).toBe(`${origin}/#/orbs/missing-switch-target`);
      await expectPage(page.getByRole("link", { name: "Back to dashboard" })).toBeVisible();
    } finally {
      release();
      await page.close();
    }
  });

  it("inserts orb URLs at typed @ and preserves cancelled mentions and shell input", async () => {
    const page = await browser.newPage();
    await page.goto(`${origin}/${ORB_HASH}`);
    const composer = page.getByPlaceholder(/Message the orb/);
    await composer.fill("before replace after");
    await composer.evaluate((element) => element.setSelectionRange(7, 14));
    await composer.press("@");
    const dialog = page.getByRole("dialog", { name: "Find orbs" });
    await expectPage(dialog).toBeVisible();
    await expectPage(composer).toHaveValue("before @ after");
    await dialog.getByRole("searchbox").fill("Finished design");
    await expectPage(dialog.getByRole("link")).toHaveCount(1);
    await dialog.getByRole("searchbox").press("Enter");
    const inserted = `${origin}/#/orbs/frontend-archived-orb`;
    await expectPage(composer).toHaveValue(`before ${inserted} after`);
    await expectPage(composer).toBeFocused();
    expectPage(page.url()).toBe(`${origin}/${ORB_HASH}`);
    await composer.press("@");
    await dialog.getByRole("searchbox").fill("Frontend");
    await dialog.getByRole("link").first().focus();
    await page.keyboard.press("Escape");
    await expectPage(dialog).toBeHidden();
    await expectPage(composer).toBeFocused();
    await expectPage(composer).toHaveValue(`before ${inserted}@ after`);
    await composer.press("x");
    await expectPage(composer).toHaveValue(`before ${inserted}@x after`);

    await composer.fill("");
    await composer.press("!");
    const shell = page.getByPlaceholder(/Run a shell command/);
    await shell.press("@");
    await expectPage(shell).toHaveValue("@");
    await expectPage(dialog).toBeHidden();
    await shell.fill("");
    await shell.press("!");
    await shell.press("@");
    await expectPage(shell).toHaveValue("@");
    await expectPage(dialog).toBeHidden();
    await page.close();
  });

  it("uses full-cell block cursors and keeps the composer caret aligned during native editing", async () => {
    const page = await browser.newPage({ reducedMotion: "reduce" });
    await page.goto(`${origin}/${ORB_HASH}`);
    const composer = page.getByPlaceholder(/Message the orb/);
    const caret = page.locator(".composer-caret");
    await composer.fill("abc\ndef");
    await expectPage(caret).toBeVisible();
    await expectPage(caret).toHaveCSS("height", "20px");
    const position = () =>
      caret.evaluate((element) => ({
        left: Number.parseFloat(element.style.left),
        top: Number.parseFloat(element.style.top),
      }));
    const end = await position();
    expectPage(end.top).toBe(20);
    await composer.press("Home");
    await expectPage.poll(position).toEqual({ left: 0, top: 20 });
    await composer.press("ArrowUp");
    await expectPage.poll(position).toEqual({ left: 0, top: 0 });
    await composer.press("Shift+ArrowRight");
    await expectPage(caret).toBeHidden();
    await composer.press("ArrowRight");
    await expectPage(caret).toBeVisible();

    await composer.dispatchEvent("compositionstart");
    await expectPage(caret).toBeHidden();
    await expectPage(composer).toHaveAttribute("data-block-caret", "false");
    await composer.dispatchEvent("compositionend");
    await expectPage(caret).toBeVisible();

    await composer.fill("x".repeat(400));
    await composer.evaluate((element) => {
      element.style.width = "160px";
    });
    await expectPage.poll(async () => (await position()).top).toBeGreaterThan(0);
    await composer.evaluate((element) => {
      element.setSelectionRange(0, 0);
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll"));
    });
    await expectPage.poll(position).toEqual({ left: 0, top: 0 });
    await composer.fill(Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n"));
    await expectPage(caret).toBeVisible();
    expectPage((await position()).top).toBeLessThan(80);

    // A stable presentation specimen avoids racing a transient streamed delta.
    await page.locator(".composer-editor").evaluate((element) => {
      const working = element.ownerDocument.createElement("span");
      working.className = "cur";
      working.dataset["testWorking"] = "true";
      element.append(working);
    });
    const working = page.locator('[data-test-working="true"]');
    await expectPage(working).toHaveCSS("height", "20px");
    expectPage(await working.evaluate((el) => el.getBoundingClientRect().width)).toBe(
      await caret.evaluate((el) => el.getBoundingClientRect().width),
    );
    await page.getByRole("button", { name: "terminal", exact: true }).click();
    await expectPage(caret).toBeHidden();
    const terminalCursor = page.locator(".term-cursor").first();
    await expectPage(terminalCursor).toBeAttached();
    const terminal = page.locator(".orb-terminal-emulator.wterm");
    await expectPage(terminal).toHaveCSS("font-size", "13px");
    await expectPage(terminal).toHaveCSS("--term-row-height", "20px");
    await page.close();
  });

  it("shows the ribbon and recovers session, route, and composer draft in the same tab", async () => {
    const page = await browser.newPage();
    await page.goto(`${origin}/${ORB_HASH}`);

    const draft = "Keep this exact draft through IAP sign-in";
    const composer = page.getByPlaceholder(/Message the orb/);
    await composer.fill(draft);

    await page.getByRole("button", { name: "expire session" }).click();
    const ribbon = page.getByRole("alert");
    await expectPage(ribbon).toContainText("session expired");
    await expectPage(composer).toHaveValue(draft);

    const loaded = page.waitForEvent("load");
    await ribbon.getByRole("button", { name: "sign in again" }).click();
    await loaded;

    await expectPage(page).toHaveURL(`${origin}/${ORB_HASH}`);
    await expectPage(page.getByRole("alert")).toHaveCount(0);
    await expectPage(page.getByText("frontend fixture · session active")).toBeVisible();
    await expectPage(page.getByPlaceholder(/Message the orb/)).toHaveValue(draft);

    await page.close();
  });

  it("shows hosted files on an archived orb and preserves a missing orb URL", async () => {
    const page = await browser.newPage();
    await page.goto(`${origin}/#/orbs/frontend-archived-orb`);
    await expectPage(page.getByText("files (1)")).toBeVisible();
    await page.getByText("files (1)").click();
    const file = page.getByRole("link", { name: "index.html" });
    await expectPage(file).toHaveAttribute(
      "href",
      "http://files.localhost:7100/s/frontend-archived-orb/index.html",
    );
    await expectPage(page.getByPlaceholder(/Message the orb/)).toHaveCount(0);

    await page.goto(`${origin}/#/orbs/missing-hosted-files-orb`);
    await expectPage(page).toHaveURL(`${origin}/#/orbs/missing-hosted-files-orb`);
    await expectPage(page.getByRole("heading", { name: "Orb doesn't exist" })).toBeVisible();
    await page.close();
  });
});
