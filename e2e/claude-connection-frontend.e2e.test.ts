import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeAuthView } from "@pi-orb/protocol";
import {
  type Browser,
  type BrowserContext,
  expect as check,
  chromium,
  type Page,
  webkit,
} from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";

const consent = "https://claude.ai/consent?fixture=one-click";
const challenge: ClaudeAuthView = {
  status: "connecting",
  challenge: { url: consent, needsCode: true },
};

describe.each(["chromium", "webkit"] as const)("%s one-click Claude connection", (engine) => {
  let vite: ViteDevServer;
  let browser: Browser;
  let origin: string;
  let cacheDir: string;
  beforeAll(async () => {
    browser = await (engine === "chromium" ? chromium : webkit).launch({ headless: true });
    const root = join(import.meta.dirname, "../apps/web");
    cacheDir = await mkdtemp(join(tmpdir(), "claude-one-click-"));
    vite = await createServer({
      root,
      cacheDir,
      configFile: join(root, "vite.config.ts"),
      mode: "frontend",
      server: { host: "127.0.0.1", port: 0 },
      plugins: [
        {
          name: "claude-one-click-production-component",
          configureServer(server) {
            server.middlewares.use(async (request, response, next) => {
              if (request.url !== "/__claude_click") {
                next();
                return;
              }
              const html = await server.transformIndexHtml(
                request.url,
                `<main id="root"></main><script type="module">
              import React from "react";
              import { createRoot } from "react-dom/client";
              import { ClaudeAuthButton } from "/src/components/ClaudeAuth.tsx";
              import "/src/styles.css";
              const root = createRoot(document.getElementById("root"));
              root.render(React.createElement(React.StrictMode, null, React.createElement(ClaudeAuthButton)));
              window.addEventListener("fixture-unmount", () => root.unmount());
            </script>`,
              );
              response.setHeader("Content-Type", "text/html");
              response.end(html);
            });
          },
        },
      ],
    });
    await listenFrontend(vite);
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("No owned test port");
    origin = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    await browser?.close();
    await vite?.close();
    if (cacheDir) await rm(cacheDir, { recursive: true, force: true });
  });

  async function fixture(
    initial: ClaudeAuthView = { status: "disconnected" },
    dashboard = false,
    width = 1280,
  ) {
    const context: BrowserContext = await browser.newContext({ viewport: { width, height: 844 } });
    const page: Page = await context.newPage();
    let view = initial;
    let connectReply = challenge;
    let codeReply: ClaudeAuthView = { status: "connected", generation: 1 };
    let releaseConnect: (() => void) | null = null;
    let gate: Promise<void> | null = null;
    const actions: string[] = [];
    let navigations = 0;
    let reads = 0;
    let failRead = false;
    await context.route("https://**/*", async (route) => {
      if (route.request().url() !== consent) {
        await route.abort();
        return;
      }
      navigations++;
      await route.fulfill({ contentType: "text/html", body: "<p>Test-owned consent page</p>" });
    });
    await context.route("**/api/v1/claude/auth{,/**}", async (route) => {
      const request = route.request();
      const action = new URL(request.url()).pathname.split("/")[5];
      if (request.method() === "GET") {
        reads++;
        if (failRead) {
          await route.fulfill({
            status: 503,
            json: {
              error: { code: "unavailable", message: "Cannot read connection", retryable: true },
            },
          });
          return;
        }
      }
      if (request.method() === "POST") {
        actions.push(action ?? "unknown");
        if (action === "connect") {
          if (gate) await gate;
          view = connectReply;
        }
        if (action === "code") view = codeReply;
        if (action === "disconnect" || action === "cancel") view = { status: "disconnected" };
      }
      await route.fulfill({ json: view });
    });
    await page.goto(`${origin}/${dashboard ? "" : "__claude_click"}`);
    const dialog = page.getByRole("dialog", {
      name: dashboard ? "Settings" : "Claude subscription",
      exact: true,
    });
    const click = async () => {
      await page
        .getByRole("button", { name: dashboard ? "Settings" : "Connect Claude", exact: true })
        .click();
      if (dashboard) await dialog.getByRole("tab", { name: "Claude", exact: true }).click();
    };
    return {
      context,
      page,
      dialog,
      actions,
      click,
      navigations: () => navigations,
      reads: () => reads,
      failRead(value: boolean) {
        failRead = value;
      },
      setView(value: ClaudeAuthView) {
        view = value;
      },
      setConnectReply(value: ClaudeAuthView) {
        connectReply = value;
      },
      setCodeReply(value: ClaudeAuthView) {
        codeReply = value;
      },
      holdConnect() {
        gate = new Promise<void>((resolve) => {
          releaseConnect = resolve;
        });
      },
      release() {
        releaseConnect?.();
      },
      async close() {
        releaseConnect?.();
        await context.unrouteAll({ behavior: "wait" });
        await context.close();
      },
    };
  }

  it.each([1280, 390, 320])("owner settings use guarded tabs at %ipx", async (width) => {
    const f = await fixture({ status: "connected", generation: 1 }, true, width);
    try {
      const header = f.page.locator(".dashboard-totals");
      await check(header.getByRole("button", { name: "Claude", exact: true })).toHaveCount(0);
      const gear = header.getByRole("button", { name: "Settings", exact: true });
      await gear.click();
      const settings = f.page.getByRole("dialog", { name: "Settings", exact: true });
      const instructions = settings.getByRole("tab", { name: "Instructions", exact: true });
      const claude = settings.getByRole("tab", { name: "Claude", exact: true });
      await check(instructions).toHaveAttribute("aria-selected", "true");
      const text = settings.getByRole("textbox", { name: "Personal AGENTS.md" });
      await check(text).toBeEnabled();
      await text.fill("unsaved owner instructions");
      await instructions.focus();
      await f.page.keyboard.press("ArrowRight");
      await check(claude).toBeFocused();
      await check(claude).toHaveAttribute("aria-selected", "true");
      await check(
        settings.getByRole("button", { name: "Disconnect Claude", exact: true }),
      ).toBeVisible();
      await check(settings.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
      await check(settings.getByRole("textbox", { name: "Personal AGENTS.md" })).toHaveCount(0);
      check(f.actions).toEqual([]);
      check(f.context.pages()).toHaveLength(1);
      check(f.navigations()).toBe(0);
      await claude.focus();
      await f.page.keyboard.press("Home");
      await check(instructions).toBeFocused();
      await check(text).toHaveValue("unsaved owner instructions");
      await f.page.keyboard.press("End");
      await check(claude).toBeFocused();
      if (width <= 600) {
        check((await instructions.boundingBox())?.height).toBeGreaterThanOrEqual(48);
        check((await claude.boundingBox())?.height).toBeGreaterThanOrEqual(48);
      }
      await f.page.keyboard.press("Escape");
      await check(gear).toBeFocused();
      await gear.click();
      await check(instructions).toHaveAttribute("aria-selected", "true");
      await check(text).toHaveValue("unsaved owner instructions");
    } finally {
      await f.close();
    }
  });

  it("owner Claude tab reads status; explicit Connect opens consent once and preserves waiting across tabs", async () => {
    const f = await fixture({ status: "disconnected" }, true, 390);
    try {
      await f.page.getByRole("button", { name: "Settings", exact: true }).click();
      const settings = f.page.getByRole("dialog", { name: "Settings", exact: true });
      await settings.getByRole("tab", { name: "Claude", exact: true }).click();
      await check(
        settings.getByRole("button", { name: "Connect Claude subscription" }),
      ).toBeEnabled();
      check(f.actions).toEqual([]);
      check(f.context.pages()).toHaveLength(1);
      const opened = f.context.waitForEvent("page");
      await settings.getByRole("button", { name: "Connect Claude subscription" }).click();
      const popup = await opened;
      await check(popup).toHaveURL(consent);
      await popup.close();
      await f.page.bringToFront();
      const code = settings.getByLabel("Claude completion code");
      await check(code).toBeFocused();
      await code.fill("synthetic-code");
      await settings.getByRole("tab", { name: "Instructions", exact: true }).click();
      await settings.getByRole("tab", { name: "Claude", exact: true }).click();
      await check(code).toHaveValue("synthetic-code");
      f.setCodeReply({ status: "connecting" });
      await settings.getByRole("button", { name: "Complete connection" }).click();
      await check(settings.getByRole("status")).toHaveText("Completing connection…");
      await settings.getByRole("tab", { name: "Instructions", exact: true }).click();
      await settings.getByRole("tab", { name: "Claude", exact: true }).click();
      await check(settings.getByRole("status")).toHaveText("Completing connection…");
      await check(code).toHaveCount(0);
      check(f.actions).toEqual(["connect", "code"]);
    } finally {
      await f.close();
    }
  });

  it("owner tab status errors retry reads without admitting a connection", async () => {
    const f = await fixture({ status: "disconnected" }, true);
    try {
      f.failRead(true);
      await f.page.getByRole("button", { name: "Settings", exact: true }).click();
      const settings = f.page.getByRole("dialog", { name: "Settings", exact: true });
      await settings.getByRole("tab", { name: "Claude", exact: true }).click();
      await check(settings.getByRole("alert")).toContainText("Cannot read connection");
      await check(
        settings.getByRole("button", { name: "Connect Claude subscription" }),
      ).toHaveCount(0);
      f.failRead(false);
      await settings.getByRole("button", { name: "Retry", exact: true }).click();
      await check(
        settings.getByRole("button", { name: "Connect Claude subscription" }),
      ).toBeEnabled();
      check(f.actions).toEqual([]);
      check(f.context.pages()).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

  it("inactive owner Claude pane fences its poll and Disconnect requires an explicit click", async () => {
    const f = await fixture(challenge, true);
    try {
      await f.page.clock.install();
      await f.page.getByRole("button", { name: "Settings", exact: true }).click();
      const settings = f.page.getByRole("dialog", { name: "Settings", exact: true });
      await settings.getByRole("tab", { name: "Claude", exact: true }).click();
      await check(settings.getByLabel("Claude completion code")).toBeVisible();
      await settings.getByRole("tab", { name: "Instructions", exact: true }).click();
      const reads = f.reads();
      await f.page.clock.runFor(3100);
      check(f.reads()).toBe(reads);
      f.setView({ status: "connected", generation: 1 });
      await settings.getByRole("tab", { name: "Claude", exact: true }).click();
      const disconnect = settings.getByRole("button", { name: "Disconnect Claude", exact: true });
      await check(disconnect).toBeVisible();
      check(f.actions).toEqual([]);
      await disconnect.click();
      await check(
        settings.getByRole("button", { name: "Connect Claude subscription" }),
      ).toBeVisible();
      check(f.actions).toEqual(["disconnect"]);
    } finally {
      await f.close();
    }
  });

  it("one trusted click opens consent with no opener and leaves focused code entry ready", async () => {
    const f = await fixture();
    try {
      const opened = f.context.waitForEvent("page");
      await f.click();
      const popup = await opened;
      await check(popup).toHaveURL(consent);
      check(await popup.evaluate(() => Reflect.get(globalThis, "opener") === null)).toBe(true);
      await check(f.dialog).toBeVisible();
      const code = f.dialog.getByLabel("Claude completion code");
      await popup.close();
      await f.page.bringToFront();
      await check(code).toBeFocused();
      check(f.actions).toEqual(["connect"]);
      await code.fill("synthetic-code");
      await f.dialog.getByRole("button", { name: "Complete connection" }).click();
      await check(f.dialog.getByRole("status")).toHaveText("Claude connected");
      await f.page.getByRole("button", { name: "Close Claude connection" }).click();
      await f.click();
      await check(f.dialog.getByRole("status")).toHaveText("Claude connected");
      check(f.context.pages()).toHaveLength(1);
      check(f.actions).toEqual(["connect", "code"]);
      check(f.navigations()).toBe(1);
    } finally {
      await f.close();
    }
  });

  it("reuses active consent, then respects accepted-code waiting without a new flow", async () => {
    const f = await fixture(challenge);
    try {
      const opened = f.context.waitForEvent("page");
      await f.click();
      await check(await opened).toHaveURL(consent);
      await check(f.dialog.getByLabel("Claude completion code")).toBeVisible();
      check(f.actions).toEqual([]);
      f.setCodeReply({ status: "connecting" });
      await f.dialog.getByLabel("Claude completion code").fill("synthetic-code");
      await f.dialog.getByRole("button", { name: "Complete connection" }).click();
      await check(f.dialog.getByRole("status")).toHaveText("Completing connection…");
      await check(f.dialog.getByLabel("Claude completion code")).toHaveCount(0);
      await f.page.getByRole("button", { name: "Close Claude connection" }).click();
      await f.click();
      await check(f.dialog.getByRole("status")).toHaveText("Connecting…");
      check(f.actions).toEqual(["code"]);
      check(f.navigations()).toBe(1);
    } finally {
      await f.close();
    }
  });

  it("shows blocked-tab failure with a working direct consent link", async () => {
    const f = await fixture();
    try {
      await f.page.evaluate(() => {
        Reflect.set(globalThis, "open", () => null);
      });
      await f.click();
      await check(f.dialog.getByRole("alert")).toContainText("Sign-in tab was blocked");
      await check(f.dialog.getByRole("link", { name: "Sign in with Anthropic" })).toHaveAttribute(
        "href",
        consent,
      );
      await check(f.dialog.getByLabel("Claude completion code")).toBeVisible();
      const opened = f.context.waitForEvent("page");
      await f.dialog.getByRole("link", { name: "Sign in with Anthropic" }).click();
      await check(await opened).toHaveURL(consent);
      check(f.actions).toEqual(["connect"]);
    } finally {
      await f.close();
    }
  });

  it("reports a user-closed reservation with a direct link, without another popup", async () => {
    const f = await fixture();
    try {
      f.holdConnect();
      const opened = f.context.waitForEvent("page");
      await f.click();
      const popup = await opened;
      await check.poll(() => f.actions.length).toBe(1);
      await popup.close();
      f.release();
      await check(f.dialog.getByRole("alert")).toContainText("Sign-in tab was closed");
      await check(f.dialog.getByRole("link", { name: "Sign in with Anthropic" })).toHaveAttribute(
        "href",
        consent,
      );
      check(f.context.pages()).toHaveLength(1);
      check(f.navigations()).toBe(0);
      check(f.actions).toEqual(["connect"]);
    } finally {
      await f.close();
    }
  });

  it("polls a delayed native URL while the reserved tab hides the app", async () => {
    const f = await fixture();
    try {
      f.setConnectReply({ status: "connecting" });
      f.holdConnect();
      const opened = f.context.waitForEvent("page");
      await f.click();
      const popup = await opened;
      await check.poll(() => f.actions.length).toBe(1);
      await popup.bringToFront();
      // Headless engines do not consistently hide background tabs. Deliver the
      // platform visibility edge explicitly while the real reserved tab is open.
      await f.page.evaluate(() => {
        const doc = Reflect.get(globalThis, "document");
        Object.defineProperty(doc, "visibilityState", { configurable: true, get: () => "hidden" });
        Object.defineProperty(doc, "hidden", { configurable: true, get: () => true });
        doc.dispatchEvent(new Event("visibilitychange"));
      });
      check(await f.page.evaluate(() => Reflect.get(globalThis, "document").hidden)).toBe(true);
      await check(popup.getByRole("status")).toHaveText("Connecting…");
      const appFont = await f.page.evaluate(() => {
        const doc = Reflect.get(globalThis, "document");
        return Reflect.get(globalThis, "getComputedStyle")(doc.body).fontFamily;
      });
      await check(popup.getByRole("status")).toHaveCSS("font-family", appFont);
      await check(popup.getByRole("status")).toHaveCSS("font-size", "13px");
      f.release();
      await check(f.dialog.getByRole("status")).toHaveText("Connecting…");
      f.setView(challenge);
      await check(popup).toHaveURL(consent);
      await check(f.dialog.getByLabel("Claude completion code")).toBeVisible();
      check(await f.page.evaluate(() => Reflect.get(globalThis, "document").hidden)).toBe(true);
      check(f.navigations()).toBe(1);
      check(f.actions).toEqual(["connect"]);
    } finally {
      await f.close();
    }
  });

  it("connected opens management, while explicit reconnect opens native consent once", async () => {
    const f = await fixture({ status: "connected", generation: 1 });
    try {
      await f.click();
      await check(f.dialog.getByRole("status")).toHaveText("Claude connected");
      check(f.actions).toEqual([]);
      await check.poll(() => f.context.pages().length).toBe(1);
      const opened = f.context.waitForEvent("page");
      await f.dialog.getByRole("button", { name: "Reconnect Claude" }).click();
      await check(await opened).toHaveURL(consent);
      await check(f.dialog.getByLabel("Claude completion code")).toBeVisible();
      check(f.actions).toEqual(["connect"]);
    } finally {
      await f.close();
    }
  });

  it.each(["close", "unmount"] as const)(
    "%s fences a late native URL without implicit owner cancellation",
    async (how) => {
      const f = await fixture();
      try {
        f.holdConnect();
        const opened = f.context.waitForEvent("page");
        await f.click();
        const popup = await opened;
        await check.poll(() => f.actions.length).toBe(1);
        if (how === "close")
          await f.page.getByRole("button", { name: "Close Claude connection" }).click();
        else
          await f.page.evaluate(() =>
            Reflect.get(globalThis, "dispatchEvent")(new Event("fixture-unmount")),
          );
        await check.poll(() => popup.isClosed()).toBe(true);
        f.release();
        await f.context.unrouteAll({ behavior: "wait" });
        check(f.navigations()).toBe(0);
        check(f.actions).toEqual(["connect"]);
      } finally {
        await f.close();
      }
    },
  );

  it("native failure closes the tab, shows its safe error, and needs an explicit retry", async () => {
    const f = await fixture();
    try {
      f.setConnectReply({ status: "failed", error: "Sign-in expired" });
      await f.click();
      await check(f.dialog.getByRole("alert")).toHaveText("Sign-in expired");
      await check.poll(() => f.context.pages().length).toBe(1);
      check(f.actions).toEqual(["connect"]);
      f.setConnectReply(challenge);
      const opened = f.context.waitForEvent("page");
      await f.dialog.getByRole("button", { name: "Connect Claude subscription" }).click();
      await check(await opened).toHaveURL(consent);
      await check(f.dialog.getByLabel("Claude completion code")).toBeVisible();
      check(f.actions).toEqual(["connect", "connect"]);
    } finally {
      await f.close();
    }
  });
});
