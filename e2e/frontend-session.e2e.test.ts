import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Browser, chromium, expect as expectPage, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";

const WEB_ROOT = join(import.meta.dirname, "../apps/web");
const ORB_HASH = "#/orbs/frontend-fixture-orb";
let vite: ViteDevServer;
let browser: Browser;
let origin: string;

async function removeFixtureOrb(page: Page, orbId: string) {
  const response = await page.request.delete(`${origin}/api/v1/orbs/${orbId}`);
  if (response.status() === 404) return;
  expectPage(response.status()).toBe(202);
  // Deletion is asynchronous. A 202 does not release this test's fixture ownership.
  await expectPage
    .poll(async () => (await page.request.get(`${origin}/api/v1/orbs/${orbId}`)).status())
    .toBe(404);
}

async function expectTextFieldContrast(page: Page, scope = page.locator("body")) {
  const fields = scope.locator(
    'input:not([type="file"]):not(:disabled):visible, textarea:not(:disabled):visible',
  );
  await expectPage(fields.first()).toBeVisible();
  const count = await fields.count();
  expectPage(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index++) {
    const field = fields.nth(index);
    await expectPage(field).not.toHaveAttribute("placeholder");
    await field.evaluate((element) => element.blur());
    expectPage(
      await field.evaluate((element) => {
        const style = element.ownerDocument.defaultView?.getComputedStyle(element);
        return {
          background: style?.backgroundColor,
          caret: style?.caretColor,
          color: style?.color,
        };
      }),
    ).toEqual({ background: "rgb(255, 255, 255)", caret: "rgb(0, 0, 0)", color: "rgb(0, 0, 0)" });
    await field.focus();
    const focused = await field.evaluate((element) => {
      const style = element.ownerDocument.defaultView?.getComputedStyle(element);
      return {
        background: style?.backgroundColor,
        caret: style?.caretColor,
        color: style?.color,
        customCaret: element.classList.contains("composer-input"),
      };
    });
    expectPage(focused).toEqual({
      background: "rgb(0, 0, 0)",
      caret: focused.customCaret ? "rgba(0, 0, 0, 0)" : "rgb(255, 255, 255)",
      color: "rgb(255, 255, 255)",
      customCaret: focused.customCaret,
    });
  }
}

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
      plugins: [
        {
          name: "test-app-search-registration-order",
          resolveId(id) {
            return id === "virtual:app-search-registration-order" ? `\0${id}` : null;
          },
          configureServer(server) {
            server.middlewares.use(async (request, response, next) => {
              if (request.url !== "/__app-search-registration-order") {
                next();
                return;
              }
              const html = await server.transformIndexHtml(
                request.url,
                `<main id="root"></main><script type="module">import "virtual:app-search-registration-order";</script>`,
              );
              response.setHeader("Content-Type", "text/html");
              response.end(html);
            });
          },
          load(id) {
            if (id !== "\0virtual:app-search-registration-order") return null;
            return `
              import React, { useEffect, useState } from "react";
              import { createRoot } from "react-dom/client";
              import {
                AppSearchProvider,
                useAppSearchSource,
              } from "/src/components/AppSearch.tsx";

              const source = (id) => ({
                id,
                label: \`Find \${id}\`,
                status: { type: "complete" },
                items: [],
              });

              function Route() {
                const [id, setId] = useState("working");
                useAppSearchSource(source(id));
                useEffect(() => {
                  const route = document.querySelector("[data-route-id]");
                  const observer = new MutationObserver(() => {
                    if (route?.getAttribute("data-route-id") !== "archived") return;
                    observer.disconnect();
                    window.dispatchEvent(
                      new KeyboardEvent("keydown", { key: "k", metaKey: true }),
                    );
                  });
                  if (route !== null) observer.observe(route, { attributes: true });
                  return () => observer.disconnect();
                }, []);
                return React.createElement(
                  "button",
                  {
                    "data-route-id": id,
                    onClick: () => window.setTimeout(() => setId("archived"), 0),
                  },
                  "switch route",
                );
              }

              createRoot(document.getElementById("root")).render(
                React.createElement(
                  AppSearchProvider,
                  null,
                  React.createElement(Route),
                ),
              );
            `;
          },
        },
        {
          name: "test-history-render-count",
          enforce: "pre",
          transform(code, id) {
            if (id.endsWith("/components/OrbTerminal.tsx")) {
              // Test-only checkpoint: identify StrictMode emulator ownership
              // and hold its final connection until the scenario releases it.
              return code
                .replace(
                  "(wt: WTerm) => {",
                  'async (wt: WTerm) => { const gate = Reflect.get(globalThis, "__terminalReadyGate")?.(); if (gate?.pause) await gate.pause;',
                )
                .replace(
                  "new WebSocket(terminalUrl(orbId), TERMINAL_SUBPROTOCOL)",
                  'new WebSocket(terminalUrl(orbId) + (gate ? "?ready=" + gate.ordinal : ""), TERMINAL_SUBPROTOCOL)',
                );
            }
            if (!id.endsWith("/components/HistoryView.tsx")) return;
            // Count function executions, not DOM mutations: React can reparse the
            // entire transcript without changing a single DOM node.
            return code.replace(
              "const rows = presentTranscript(",
              'Reflect.set(globalThis, "__historyRenders", (Reflect.get(globalThis, "__historyRenders") ?? 0) + 1); const rows = presentTranscript(',
            );
          },
        },
      ],
      server: { host: "127.0.0.1", port: 0 },
    });
    await listenFrontend(vite);
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

  it.each([1280, 600, 390, 320])(
    "renders gutter-free soft-inversion turns without overflow at %ipx",
    async (width) => {
      const page = await browser.newPage({ viewport: { width, height: 740 } });
      try {
        await page.goto(`${origin}/${ORB_HASH}`);
        const user = page.locator(".history .rec-you").first();
        const orb = page.locator(".history .rec-orb").first();
        await expectPage(user).toBeVisible();
        await expectPage(orb).toBeVisible();
        await expectPage(user.locator(".visually-hidden")).toHaveText("You:");
        await expectPage(orb.locator(".visually-hidden")).toHaveText("Orb:");
        expectPage(
          await user.locator(".visually-hidden").evaluate((element) => {
            const style = element.ownerDocument.defaultView?.getComputedStyle(element);
            const box = element.getBoundingClientRect();
            return { width: box.width, height: box.height, clip: style?.clipPath };
          }),
        ).toEqual({ width: 1, height: 1, clip: "inset(50%)" });
        expectPage(
          await user.evaluate((element) => {
            const style = element.ownerDocument.defaultView?.getComputedStyle(element);
            if (style === undefined) return null;
            return {
              display: style.display,
              color: style.color,
              background: style.backgroundColor,
              weight: style.fontWeight,
            };
          }),
        ).toEqual({
          display: "block",
          color: "rgb(255, 255, 255)",
          background: "rgb(0, 0, 0)",
          weight: "400",
        });
        expectPage(
          await orb.evaluate(
            (element) => element.ownerDocument.defaultView?.getComputedStyle(element).display,
          ),
        ).toBe("block");
        const inlineCode = user.locator("code").first();
        expectPage(
          await inlineCode.evaluate((element) => {
            const style = element.ownerDocument.defaultView?.getComputedStyle(element);
            return { color: style?.color, background: style?.backgroundColor };
          }),
        ).toEqual({ color: "rgb(0, 0, 0)", background: "rgb(255, 255, 255)" });
        await expectPage(user.locator("blockquote")).toBeVisible();
        await expectPage(user.locator(".markdown-code-block")).toBeVisible();
        await expectPage(user.locator("table")).toBeVisible();
        await expectPage(user.locator("img")).toBeVisible();
        const responseCopy = orb.getByRole("button", { name: "Copy response Markdown" }).first();
        const responseBlock = responseCopy.locator("..");
        await expectPage(responseCopy).toBeVisible();
        if (width > 600) {
          const opacity = () =>
            responseCopy.evaluate(
              (button) => button.ownerDocument.defaultView?.getComputedStyle(button).opacity,
            );
          expectPage(await opacity()).toBe("0");
          await page.locator(".history .rec-orb").nth(1).hover();
          expectPage(await opacity()).toBe("0");
          await responseBlock.hover();
          expectPage(await opacity()).toBe("1");
          await page.mouse.move(0, 0);
          await responseCopy.focus();
          expectPage(await opacity()).toBe("1");
        } else {
          expectPage(
            await responseCopy.evaluate((button) => ({
              width: button.getBoundingClientRect().width,
              height: button.getBoundingClientRect().height,
              opacity: button.ownerDocument.defaultView?.getComputedStyle(button).opacity,
            })),
          ).toEqual({ width: 44, height: 44, opacity: "1" });
          expectPage(
            await page.locator(".response-markdown").evaluateAll((responses) =>
              responses.every((response) => {
                const wrapper = response.getBoundingClientRect();
                const button = response.querySelector(".response-copy")?.getBoundingClientRect();
                return (
                  button !== undefined &&
                  button.top >= wrapper.top &&
                  button.bottom <= wrapper.bottom
                );
              }),
            ),
          ).toBe(true);
          if (width === 320) {
            expectPage(
              await responseBlock.evaluate((response) => {
                const content = response.querySelector(".chat-markdown")?.getBoundingClientRect();
                const button = response.querySelector(".response-copy")?.getBoundingClientRect();
                const box = response.getBoundingClientRect();
                if (content === undefined || button === undefined) return null;
                return {
                  top: button.top - box.top,
                  right: box.right - button.right,
                  gap: button.left - content.right,
                };
              }),
            ).toEqual({ top: 0, right: 0, gap: 0 });
          }
        }
        await expectPage(page.locator(".rec-status", { hasText: "steering" })).toBeVisible();
        const failedTurn = page.locator(".rec-q", { hasText: "This oversized follow-up" });
        await expectPage(failedTurn.locator(".rec-status", { hasText: "failed" })).toBeVisible();
        expectPage(
          await failedTurn.locator(".error-text").evaluate((element) => {
            const style = element.ownerDocument.defaultView?.getComputedStyle(element);
            return { color: style?.color, background: style?.backgroundColor };
          }),
        ).toEqual({ color: "rgb(180, 35, 24)", background: "rgb(255, 255, 255)" });
        expectPage(
          await page
            .locator("body")
            .evaluate(
              (body) =>
                body.ownerDocument.documentElement.scrollWidth <=
                (body.ownerDocument.defaultView?.innerWidth ?? 0),
            ),
        ).toBe(true);
      } finally {
        await page.close();
      }
    },
  );

  it("copies response Markdown independently from code and reports success", async () => {
    const context = await browser.newContext({
      permissions: ["clipboard-read", "clipboard-write"],
      viewport: { width: 1280, height: 740 },
    });
    const page = await context.newPage();
    try {
      await page.goto(`${origin}/${ORB_HASH}`);
      const response = page.locator(".rec-orb").first();
      const responseCopy = response.locator("button.response-copy");
      const codeCopy = response.getByRole("button", { name: "Copy code to clipboard" });
      await expectPage(responseCopy).toBeVisible();
      await expectPage(responseCopy).toHaveAccessibleName("Copy response Markdown");
      await expectPage(codeCopy).toBeVisible();

      await codeCopy.click();
      expectPage(
        await page.evaluate(() =>
          (
            navigator as Navigator & { clipboard: { readText(): Promise<string> } }
          ).clipboard.readText(),
        ),
      ).toBe('const orb = await connectOrb("frontend-playground");');

      await page.clock.install();
      await responseCopy.click();
      await expectPage(responseCopy).toHaveAccessibleName("Copied response Markdown");
      const copiedStatus = response.locator(".response-copy-status");
      await expectPage(copiedStatus).toHaveText("copied");
      await expectPage(copiedStatus).toHaveClass("response-copy-status visually-hidden");
      expectPage(
        await copiedStatus.evaluate((status) => {
          const style = status.ownerDocument.defaultView?.getComputedStyle(status);
          return { clipPath: style?.clipPath, position: style?.position };
        }),
      ).toEqual({ clipPath: "inset(50%)", position: "absolute" });
      expectPage(
        await page.evaluate(() =>
          (
            navigator as Navigator & { clipboard: { readText(): Promise<string> } }
          ).clipboard.readText(),
        ),
      ).toBe(
        '# Frontend playground\n\nThis conversation is supplied by the in-process fixture backend. Send a message and I will echo it with simulated streaming. Fenced code includes the top-right copy action:\n\n```ts\nconst orb = await connectOrb("frontend-playground");\n```',
      );
    } finally {
      await context.close();
    }
  });

  it("contains a short phone response action", async () => {
    const context = await browser.newContext({
      permissions: ["clipboard-read", "clipboard-write"],
      viewport: { width: 600, height: 740 },
    });
    const page = await context.newPage();
    try {
      await page.goto(`${origin}/${ORB_HASH}`);
      const response = page
        .locator(".response-markdown")
        .filter({ hasText: "The activity rail is implemented and verified." });
      expectPage(
        await response.evaluate((wrapper) => {
          const box = wrapper.getBoundingClientRect();
          const paragraph = wrapper.querySelector("p")?.getBoundingClientRect();
          const button = wrapper.querySelector(".response-copy")?.getBoundingClientRect();
          if (paragraph === undefined || button === undefined) return null;
          return {
            paragraphHeight: paragraph.height,
            wrapperHeight: box.height,
            buttonContained: button.top >= box.top && button.bottom <= box.bottom,
          };
        }),
      ).toEqual({ paragraphHeight: 20, wrapperHeight: 44, buttonContained: true });
    } finally {
      await context.close();
    }
  });

  it("keeps corner response actions visible on touch-only desktops", async () => {
    const context = await browser.newContext({
      hasTouch: true,
      viewport: { width: 1280, height: 740 },
    });
    const page = await context.newPage();
    try {
      await page.goto(`${origin}/${ORB_HASH}`);
      const copy = page.getByRole("button", { name: "Copy response Markdown" }).first();
      expectPage(
        await copy.evaluate(
          (button) => button.ownerDocument.defaultView?.getComputedStyle(button).opacity,
        ),
      ).toBe("1");
    } finally {
      await context.close();
    }
  });

  it("keeps failed corner-copy feedback visible", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 740 } });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async () => Promise.reject(new Error("blocked")) },
      });
      const documentConstructor = (globalThis as unknown as { Document: { prototype: object } })
        .Document;
      Object.defineProperty(documentConstructor.prototype, "execCommand", {
        configurable: true,
        value: () => false,
      });
    });
    const page = await context.newPage();
    try {
      await page.goto(`${origin}/${ORB_HASH}`);
      const copy = page.getByRole("button", { name: "Copy response Markdown" }).first();
      await copy.focus();
      await page.keyboard.press("Enter");
      await expectPage(copy).toHaveAccessibleName("Copy response Markdown failed");
      await expectPage(page.getByText("copy failed", { exact: true }).first()).toBeVisible();
      await page.mouse.move(0, 0);
      await page.waitForTimeout(1700);
      expectPage(
        await copy.evaluate(
          (button) => button.ownerDocument.defaultView?.getComputedStyle(button).opacity,
        ),
      ).toBe("1");
      await expectPage(copy).toHaveAccessibleName("Copy response Markdown failed");
    } finally {
      await context.close();
    }
  });

  it.each([1280, 390, 320])(
    "keeps the active-only subagent rail above the terminal at %ipx",
    async (width) => {
      const page = await browser.newPage({ viewport: { width, height: 740 } });
      const id = "frontend-fixture-orb";
      const children = [
        { id: "child-a", description: "Check deployment", phase: "running" },
        { id: "child-b", description: "Check services", phase: "queued" },
        { id: "child-c", description: "Clean up", phase: "finishing" },
      ];
      let emit: (event: object) => void = () => {};
      let disconnect: () => void = () => {};
      let snapshots = 0;
      let holdReconnect = false;
      let terminalSockets = 0;
      let terminalStage = "initial mount";
      const terminalEdges: string[] = [];
      page.on("websocket", (socket) => {
        if (socket.url().endsWith("/terminal")) {
          terminalSockets++;
          terminalEdges.push(`open: ${terminalStage}`);
          socket.on("close", () => terminalEdges.push(`close: ${terminalStage}`));
        }
      });
      await page.route(`**/api/v1/orbs/${id}`, async (route) => {
        const response = await route.fetch();
        await route.fulfill({
          json: {
            ...(await response.json()),
            state: "running",
            activity: "busy",
            actionRequired: undefined,
          },
        });
      });
      await page.route(`**/api/v1/orbs/${id}/history`, async (route) => {
        const response = await route.fetch();
        await route.fulfill({
          json: {
            ...(await response.json()),
            records: [
              {
                id: "notice",
                parentId: null,
                type: "event",
                eventType: "pi.custom_message",
                timestamp: "2026-09-14T22:04:07Z",
                content: [
                  {
                    type: "text",
                    text: "<task-notification>machine instructions /private/tasks/session.jsonl</task-notification>",
                  },
                ],
                custom: { customType: "subagent-notification", display: true },
                subagent: {
                  kind: "notification",
                  id: "old-child",
                  description: "Count service lines",
                  status: "error",
                  error: "Unsupported model",
                  resultPreview: "No output.",
                },
                overflow: {},
              },
            ],
            headId: "notice",
          },
        });
      });
      await page.routeWebSocket(`**/api/v1/orbs/${id}/live`, (socket) => {
        const server = socket.connectToServer();
        emit = (event) =>
          socket.send(
            JSON.stringify({ v: 1, type: "runtime.event", at: new Date().toISOString(), event }),
          );
        disconnect = () => socket.close();
        server.onMessage((message) => {
          const frame = JSON.parse(message.toString());
          // Keep the test's history independent of the fixture's stored transcript.
          if (frame.type === "history.record") return;
          if (frame.type === "sync.started") {
            socket.send(JSON.stringify({ ...frame, mode: "after", afterRecordId: "notice" }));
            return;
          }
          if (frame.type === "runtime.event" && frame.event.type === "status") {
            snapshots++;
            if (!holdReconnect) {
              emit({ type: "operation_started", operationId: "children-op" });
              emit({ type: "subagents", operationId: "children-op", children });
              emit({ type: "status", operationId: "children-op", activity: "busy" });
            }
            return;
          }
          socket.send(message);
        });
      });
      try {
        await page.goto(`${origin}/#/orbs/${id}`);
        const rail = page.locator(".subagent-live-rail");
        await expectPage(rail).toContainText("1 running");
        await expectPage(rail).toContainText("1 queued");
        await expectPage(rail).toContainText("1 finishing");
        const receipt = page.locator(".subagent-notice");
        await receipt.locator(":scope > summary").click();
        await expectPage(receipt).toContainText("Unsupported model");
        await expectPage(page.locator(".history")).not.toContainText("machine instructions");
        if (width < 600) {
          await expectPage(
            page.getByRole("button", { name: "Open terminal", exact: true }),
          ).toBeHidden();
          await page.getByRole("button", { name: "Orb actions", exact: true }).click();
        }
        await page.getByRole("button", { name: "Open terminal", exact: true }).click();
        const terminal = page.getByRole("complementary", { name: "Interactive terminal" });
        await expectPage(terminal.locator(".term-grid")).toBeVisible();
        if (width < 600)
          await page.getByRole("button", { name: "Orb actions", exact: true }).click();
        await expectPage(terminal).toBeVisible();
        await expectPage(terminal).toContainText("frontend fixture terminal");
        await expectPage(terminal.locator(".orb-terminal-loading")).toHaveCount(0);
        // StrictMode's initial ref replay precedes readiness; from here on,
        // changing child work or the agent socket must never replace the PTY.
        const terminalConnectionsReady = terminalSockets;
        terminalStage = "rail and reconnect changes";
        await terminal.locator(".wterm").evaluate((e) => {
          e.setAttribute("data-test-session", "retained");
        });
        const topBefore = (await terminal.boundingBox())?.y ?? Number.NaN;
        await rail.locator(":scope > summary").click();
        await expectPage(rail.locator(".subagent-roster")).toBeVisible();
        await expectPage(rail.locator(".subagent-roster > li")).toHaveCount(3);
        await expectPage(
          rail.locator(".subagent-roster details, .subagent-roster summary"),
        ).toHaveCount(0);
        await expectPage(rail.locator(".subagent-roster")).not.toContainText("child-a");
        await expectPage(rail.locator(".subagent-roster > li").first()).toHaveText(
          "Check deploymentrunning",
        );
        await expectPage
          .poll(async () => (await terminal.boundingBox())?.y ?? Number.NaN)
          .toBeGreaterThan(topBefore);
        await expectPage
          .poll(async () => {
            const t = await terminal.boundingBox(),
              r = await rail.boundingBox(),
              c = await page.locator(".composer").boundingBox();
            return (
              t !== null &&
              r !== null &&
              c !== null &&
              t.y >= r.y + r.height - 1 &&
              t.y + t.height <= c.y + 1
            );
          })
          .toBe(true);
        if (width < 600) await page.getByRole("button", { name: "Write message" }).click();
        await page.getByRole("textbox", { name: "Message the orb" }).fill("keep my draft");
        if (width < 600) {
          await page.setViewportSize({ width, height: 360 });
          await expectPage
            .poll(async () => {
              const t = await terminal.boundingBox(),
                c = await page.locator(".composer").boundingBox();
              return t !== null && c !== null && t.y + t.height <= c.y + 1;
            })
            .toBe(true);
          await page.setViewportSize({ width, height: 740 });
          await page.getByRole("button", { name: "Fold editor" }).click();
        }
        holdReconnect = true;
        disconnect();
        await expectPage(rail).toHaveCount(0);
        await expectPage.poll(() => snapshots).toBe(2);
        await expectPage(rail).toHaveCount(0);
        emit({ type: "operation_started", operationId: "children-op" });
        emit({ type: "subagents", operationId: "children-op", children });
        await expectPage(rail).toBeVisible();
        emit({ type: "subagents", operationId: "children-op", children: [] });
        await expectPage(rail).toHaveCount(0);
        await expectPage(terminal.locator('[data-test-session="retained"]')).toBeVisible();
        expectPage(terminalSockets, terminalEdges.join("; ")).toBe(terminalConnectionsReady);
        if (width < 600) await page.getByRole("button", { name: "Write message" }).click();
        await expectPage(page.getByRole("textbox", { name: "Message the orb" })).toHaveValue(
          "keep my draft",
        );
        expectPage(
          await page
            .locator("body")
            .evaluate(
              (body) =>
                body.ownerDocument.documentElement.scrollWidth <=
                (body.ownerDocument.defaultView?.innerWidth ?? 0),
            ),
        ).toBe(true);
      } finally {
        await page.close();
      }
    },
  );

  it.each([1280, 390, 320])(
    "keeps one transcript bit register only while connected and busy at %ipx",
    async (width) => {
      const page = await browser.newPage({
        viewport: { width, height: 740 },
        reducedMotion: "no-preference",
      });
      const id = "frontend-fixture-orb";
      let send: (frame: object) => void = () => {};
      let disconnect = () => {};
      let snapshots = 0;
      const emit = (event: object) => send({ type: "runtime.event", event });
      await page.route(`**/api/v1/orbs/${id}`, async (route) => {
        const response = await route.fetch();
        await route.fulfill({
          json: { ...(await response.json()), state: "running", activity: "busy" },
        });
      });
      await page.route(`**/api/v1/orbs/${id}/messages`, (route) =>
        route.fulfill({ json: { items: [] } }),
      );
      await page.route(`**/api/v1/orbs/${id}/history`, async (route) => {
        const response = await route.fetch();
        await route.fulfill({
          json: { ...(await response.json()), records: [], headId: null },
        });
      });
      await page.routeWebSocket(`**/api/v1/orbs/${id}/live`, (socket) => {
        const server = socket.connectToServer();
        send = (frame) =>
          socket.send(JSON.stringify({ v: 1, at: new Date().toISOString(), ...frame }));
        disconnect = () => socket.close();
        server.onMessage((message) => {
          const frame = JSON.parse(message.toString());
          if (frame.type === "history.record") return;
          if (frame.type === "sync.started") {
            socket.send(JSON.stringify({ ...frame, mode: "after", afterRecordId: null }));
            return;
          }
          if (frame.type === "runtime.event") {
            if (frame.event.type === "status") {
              snapshots++;
              // Reconnection deliberately receives no busy snapshot.
              if (snapshots === 1) emit({ type: "operation_started", operationId: "bits-op" });
            }
            return;
          }
          socket.send(message);
        });
      });
      try {
        await page.goto(`${origin}/#/orbs/${id}`);
        const history = page.locator(".history");
        const marker = history.getByRole("status", { name: "Agent working", exact: true });
        const singleMarker = async () => {
          await expectPage(marker).toBeVisible();
          await expectPage(page.locator(".bit-register")).toHaveCount(1);
          await expectPage(history.locator(".cur")).toHaveCount(0);
        };
        await singleMarker();
        await expectPage(history.locator(".rec-orb")).toHaveCount(0);
        const strip = marker.locator(".bit-register-frames");
        const frames = ["001", "011", "010", "110", "111", "101", "100", "000"];
        await expectPage(strip).toHaveAttribute("aria-hidden", "true");
        await expectPage(strip.locator(":scope > span")).toHaveText(frames);
        await expectPage(marker).toHaveCSS("background-color", "rgb(0, 0, 0)");
        await expectPage(marker).toHaveCSS("color", "rgb(255, 255, 255)");
        await expectPage(marker).toHaveCSS("font-size", "13px");
        await expectPage(marker).toHaveCSS("overflow", "hidden");
        await expectPage(strip).toHaveCSS("animation-duration", "3.2s");
        await expectPage(strip).toHaveCSS("animation-timing-function", "steps(8)");
        // Seek into each step rather than racing the browser's animation clock.
        for (const [index, text] of [...frames, frames[0]].entries()) {
          const geometry = await strip.evaluate((element, index) => {
            const animation = element.getAnimations()[0];
            const marker = element.parentElement;
            if (animation === undefined || marker === null) return null;
            animation.pause();
            animation.currentTime = index * 400 + 200;
            const box = marker.getBoundingClientRect();
            const spans = [...element.querySelectorAll("span")];
            const visible = spans.filter((span) => {
              const frame = span.getBoundingClientRect();
              return frame.top < box.bottom - 0.5 && frame.bottom > box.top + 0.5;
            });
            const probe = marker.ownerDocument.createElement("span");
            probe.style.cssText = "position:absolute;width:calc(3ch + 6px)";
            marker.append(probe);
            const expectedWidth = probe.getBoundingClientRect().width;
            probe.remove();
            return {
              visible: visible.map((span) => span.textContent),
              height: box.height,
              width: box.width,
              expectedWidth,
              frameHeights: spans.map((span) => span.getBoundingClientRect().height),
            };
          }, index);
          expectPage(geometry?.visible).toEqual([text]);
          expectPage(geometry?.height).toBe(16);
          expectPage(geometry?.width).toBeCloseTo(geometry?.expectedWidth ?? Number.NaN, 1);
          expectPage(geometry?.frameHeights).toEqual(Array(8).fill(16));
        }
        await page.emulateMedia({ reducedMotion: "reduce" });
        await expectPage(strip).toHaveCSS("animation-name", "none");
        await expectPage(strip).toHaveCSS("transform", "none");
        expectPage(await strip.evaluate((element) => element.getAnimations().length)).toBe(0);
        expectPage(
          await strip
            .locator("span")
            .first()
            .evaluate(
              (element) =>
                element.getBoundingClientRect().top -
                (element.parentElement?.parentElement?.getBoundingClientRect().top ?? Number.NaN),
            ),
        ).toBe(0);

        emit({
          type: "output_patch",
          operationId: "bits-op",
          blockId: "live-text",
          blockType: "text",
          revision: 1,
          patch: { type: "append", text: "Live register output" },
        });
        await expectPage(history).toContainText("Live register output");
        await singleMarker();
        emit({
          type: "tool_state",
          operationId: "bits-op",
          callId: "bits-tool",
          name: "bash",
          revision: 1,
          state: "running",
        });
        await expectPage(history.locator(".tool-activity-category")).toContainText("bash");
        await singleMarker();
        send({
          type: "history.record",
          headId: "bits-record",
          retiredBlockIds: [],
          record: {
            id: "bits-record",
            parentId: null,
            timestamp: "2026-09-14T00:00:00Z",
            type: "message",
            role: "assistant",
            overflow: {},
            content: [{ type: "text", text: "Persisted register output" }],
          },
        });
        await expectPage(history).toContainText("Persisted register output");
        await expectPage(history.locator(".rec-orb")).toHaveCount(1);
        await expectPage(history.locator(".rec-orb")).toContainText("Live register output");
        await singleMarker();
        emit({ type: "status", operationId: "bits-op", activity: "idle" });
        await expectPage(marker).toHaveCount(0);
        await expectPage(history).toContainText("Live register output");
        emit({ type: "operation_started", operationId: "bits-op" });
        await singleMarker();
        disconnect();
        await expectPage(marker).toHaveCount(0);
        await expectPage.poll(() => snapshots).toBe(2);
        await expectPage(marker).toHaveCount(0);
      } finally {
        await page.close();
      }
    },
  );

  it("reveals generic tool inputs and outputs with a single disclosure", async () => {
    const page = await browser.newPage();
    const id = "frontend-auth-copy-test";
    const tools = [
      {
        name: "subagent",
        input: { prompt: "Inspect project purpose" },
        output: "Agent started in background",
      },
      {
        name: "get_subagent_result",
        input: { agent_id: "local-child-one" },
        output: "Four services found",
      },
    ];
    await page.route(`**/api/v1/orbs/${id}`, async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        json: { ...(await response.json()), state: "stopped", activity: "idle" },
      });
    });
    await page.route(`**/api/v1/orbs/${id}/history`, async (route) => {
      const response = await route.fetch();
      const base = { timestamp: "2026-09-14T00:00:00Z", overflow: {} };
      const records = tools.flatMap((tool, index) => [
        {
          ...base,
          id: `call-${index}`,
          parentId: index === 0 ? null : `result-${index - 1}`,
          type: "message",
          role: "assistant",
          content: [
            { type: "tool_call", callId: `tool-${index}`, name: tool.name, arguments: tool.input },
          ],
        },
        {
          ...base,
          id: `result-${index}`,
          parentId: `call-${index}`,
          type: "message",
          role: "tool",
          content: [
            {
              type: "tool_result",
              callId: `tool-${index}`,
              content: [{ type: "text", text: tool.output }],
            },
          ],
        },
      ]);
      await route.fulfill({ json: { ...(await response.json()), records, headId: "result-1" } });
    });
    try {
      await page.goto(`${origin}/#/orbs/${id}`);
      for (const tool of tools) {
        const category = page.locator(".tool-activity-category").filter({
          has: page.locator(".activity-rail-label", { hasText: new RegExp(`^${tool.name}$`) }),
        });
        await category.locator(":scope > summary").click();
        const output = category.locator(".tool-call-output");
        await expectPage(output).toBeVisible();
        await expectPage(output).toContainText(Object.values(tool.input)[0] as string);
        await expectPage(output).toContainText(tool.output);
      }
    } finally {
      await page.close();
    }
  });

  it("opens the OAuth return dialog over the loaded dashboard and preserves it on close", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/#/projects/frontend-fixture-project/mcp`);
      const dialog = page.getByRole("dialog");
      await expectPage(dialog.getByRole("tab", { name: "MCPs", exact: true })).toBeFocused();
      const dashboard = page.locator(".dashboard");
      await expectPage(
        dashboard.getByRole("link", { name: "Frontend Playground", exact: true }),
      ).toBeVisible();
      await dashboard.evaluate((element) => {
        element.setAttribute("data-continuity", "retained");
      });
      await dialog.getByRole("button", { name: "Close project config" }).click();
      await expectPage(page).toHaveURL(`${origin}/#/projects/frontend-fixture-project`);
      await expectPage(dialog).toHaveCount(0);
      await expectPage(dashboard).toHaveAttribute("data-continuity", "retained");
      await page.goBack();
      await expectPage(dialog.getByRole("tab", { name: "MCPs", exact: true })).toBeFocused();
      await expectPage(dashboard).toHaveAttribute("data-continuity", "retained");
      await page.goto(`${origin}/#/projects/missing-project/mcp`);
      await expectPage(page.getByText("Project doesn't exist", { exact: true })).toBeVisible();
      await expectPage(page).toHaveURL(`${origin}/#/projects/missing-project/mcp`);
      await expectPage(dialog).toHaveCount(0);
      await expectPage(
        page.getByRole("link", { name: "Back to dashboard", exact: true }),
      ).toBeVisible();
    } finally {
      await page.close();
    }
  });

  it.each(["MCPs", "Secrets"])("keeps %s field focus across dashboard refreshes", async (modal) => {
    const page = await browser.newPage();
    await page.clock.install();
    let refreshed = false;
    await page.route("**/api/v1/projects", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      if (refreshed) body.items[0].name = "Refreshed project";
      await route.fulfill({ response, json: body });
    });
    await page.route("**/api/v1/projects/*/mcp", (route) =>
      route.fulfill({ json: { revision: 0, servers: [] } }),
    );
    try {
      await page.goto(`${origin}/`);
      await page
        .getByRole("button", { name: /^Configure / })
        .first()
        .click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("tab", { name: modal, exact: true }).click();
      if (modal === "MCPs")
        await dialog.getByRole("button", { name: "add server", exact: true }).click();
      const endpoint = dialog.getByLabel(modal === "MCPs" ? "Endpoint" : "secret value", {
        exact: true,
      });
      await endpoint.fill("https://example.com/mcp");
      refreshed = true;
      await page.clock.runFor(2000);
      await expectPage(
        page.getByRole("heading", { name: "Refreshed project", exact: true }),
      ).toBeVisible();
      await expectPage(endpoint).toBeFocused();
      await expectPage(endpoint).toHaveValue("https://example.com/mcp");
      if (modal === "MCPs") {
        const name = dialog
          .getByRole("tabpanel", { name: "MCPs", exact: true })
          .getByLabel("Name", { exact: true });
        await name.fill("analytics");
        await page.clock.runFor(2000);
        await expectPage(name).toBeFocused();
      }
      await page.keyboard.press("Escape");
      await expectPage(dialog).toHaveCount(0);
    } finally {
      await page.close();
    }
  });

  it.each(["", ORB_HASH])(
    "preserves MCP drafts while adding a secret from config at %s",
    async (hash) => {
      const page = await browser.newPage();
      let saved: unknown;
      let tokenSaved = false;
      let releaseSecrets = () => {};
      let releaseSave = () => {};
      const saveAllowed = new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
      const secretsLoaded = new Promise<void>((resolve) => {
        releaseSecrets = resolve;
      });
      await page.route("**/api/v1/projects/*/secrets", async (route) => {
        const response = await route.fetch();
        await secretsLoaded;
        const body = await response.json();
        await route.fulfill({
          response,
          json: tokenSaved
            ? {
                ...body,
                items: [...body.items, { name: "TOKEN", updatedAt: new Date(0).toISOString() }],
              }
            : body,
        });
      });
      await page.route("**/api/v1/projects/*/mcp", async (route) => {
        if (route.request().method() === "PUT") {
          saved = route.request().postDataJSON();
          await route.fulfill({ json: { ...route.request().postDataJSON(), revision: 1 } });
        } else await route.fulfill({ json: { revision: 0, servers: [] } });
      });
      await page.route("**/api/v1/projects/*/mcp/describe", (route) =>
        route.fulfill({ json: { description: "Analytics" } }),
      );
      await page.route("**/api/v1/projects/*/secrets/TOKEN", async (route) => {
        expectPage(route.request().postDataJSON()).toEqual({ value: "test-value" });
        await saveAllowed;
        tokenSaved = true;
        await route.fulfill({
          json: { revision: 1, items: [{ name: "TOKEN", updatedAt: new Date(0).toISOString() }] },
        });
      });
      try {
        await page.goto(`${origin}/${hash}`);
        const gear = page.getByRole("button", { name: /^Configure / }).first();
        await expectPage(gear).toBeVisible();
        expectPage(
          await gear.evaluate((element) => {
            const heading = element
              .closest(".project-head-line")
              ?.querySelector(".project-name, .trunc")
              ?.getBoundingClientRect();
            const button = element.getBoundingClientRect();
            return heading
              ? Math.abs(heading.y + heading.height / 2 - button.y - button.height / 2)
              : Infinity;
          }),
        ).toBeLessThanOrEqual(1);
        await gear.click();
        const dialog = page.getByRole("dialog");
        const mcp = dialog.getByRole("tabpanel", { name: "MCPs", exact: true });
        await expectPage(dialog.getByRole("tab", { name: "General", exact: true })).toBeFocused();
        await dialog.getByRole("tab", { name: "MCPs", exact: true }).click();
        await mcp.getByRole("button", { name: "add server", exact: true }).click();
        await mcp.getByRole("button", { name: "preset", exact: true }).click();
        await mcp.getByRole("button", { name: "PostHog", exact: true }).click();
        await expectPage(mcp.getByLabel("Token secret", { exact: true })).toHaveValue(
          "POSTHOG_KEY",
        );
        await mcp.getByLabel("Name", { exact: true }).fill("custom");
        await mcp.getByLabel("Endpoint", { exact: true }).fill("https://example.com/mcp");
        await expectPage(mcp.getByLabel("Token secret", { exact: true })).toHaveValue(
          "POSTHOG_KEY",
        );
        await dialog.getByRole("tab", { name: "Secrets", exact: true }).click();
        const secrets = dialog.getByRole("tabpanel", { name: "Secrets", exact: true });
        await secrets.getByLabel("name", { exact: true }).fill("TOKEN");
        await secrets.getByLabel("secret value", { exact: true }).fill("test-value");
        const saveSecret = secrets.getByRole("button", { name: "save secret", exact: true });
        await expectPage(saveSecret).toBeDisabled();
        releaseSecrets();
        await expectPage(saveSecret).toBeEnabled();
        await saveSecret.click();
        await expectPage(dialog).toBeFocused();
        await expectPage(dialog.getByRole("tab", { name: "MCPs", exact: true })).toBeDisabled();
        await expectPage(
          dialog.getByRole("button", { name: "Close project config" }),
        ).toBeDisabled();
        await page.keyboard.press("Tab");
        await expectPage(dialog).toBeFocused();
        await page.keyboard.press("Escape");
        await expectPage(dialog).toBeVisible();
        releaseSave();
        await expectPage(
          secrets.locator(".project-secret-name").filter({ hasText: /^TOKEN$/ }),
        ).toBeVisible();
        await dialog.getByRole("tab", { name: "MCPs", exact: true }).click();
        await expectPage(mcp.getByLabel("Name", { exact: true })).toHaveValue("custom");
        await expectPage(mcp.getByLabel("Endpoint", { exact: true })).toHaveValue(
          "https://example.com/mcp",
        );
        await expectPage(mcp.getByLabel("Token secret", { exact: true })).toHaveValue(
          "POSTHOG_KEY",
        );
        const headers = { Authorization: { secret: "TOKEN", prefix: "Bearer " } };
        await mcp.getByLabel("Token secret", { exact: true }).selectOption("TOKEN");
        await mcp.getByRole("button", { name: "add server", exact: true }).click();
        await expectPage(mcp.locator("summary").filter({ hasText: "custom" })).toBeVisible();
        await expectPage(mcp.getByLabel("Token secret", { exact: true })).toHaveValue("TOKEN");
        expectPage(saved).toEqual({
          revision: 0,
          servers: [
            { name: "custom", url: "https://example.com/mcp", description: "Analytics", headers },
          ],
        });
        const summary = mcp.locator("summary").filter({ hasText: "custom" });
        await expectPage(summary).toBeFocused();
        await page.keyboard.press("Enter");
        await expectPage(mcp.getByLabel("Description", { exact: true })).toBeHidden();
        await page.keyboard.press("Enter");
        await mcp.getByLabel("Description", { exact: true }).fill("Edited draft");
        const mcpTab = dialog.getByRole("tab", { name: "MCPs", exact: true });
        await mcpTab.focus();
        await page.keyboard.press("ArrowRight");
        await expectPage(dialog.getByRole("tab", { name: "Secrets", exact: true })).toBeFocused();
        await expectPage(secrets).toBeVisible();
        await page.keyboard.press("Home");
        await expectPage(dialog.getByRole("tab", { name: "General", exact: true })).toBeFocused();
        await page.keyboard.press("ArrowRight");
        await expectPage(
          dialog.getByRole("tab", { name: "Instructions", exact: true }),
        ).toBeFocused();
        await expectPage(
          dialog.getByRole("tabpanel", { name: "Instructions", exact: true }),
        ).toBeVisible();
        await page.keyboard.press("ArrowRight");
        await expectPage(mcpTab).toBeFocused();
        await expectPage(mcp.getByLabel("Name", { exact: true })).toHaveAttribute("readonly", "");
        await expectPage(mcp.getByLabel("Description", { exact: true })).toHaveValue(
          "Edited draft",
        );
        await page.keyboard.press("Escape");
        await expectPage(dialog).toHaveCount(0);
        await expectPage(gear).toBeFocused();
        await expectPage(page.locator(".project-repo")).toHaveCount(0);
      } finally {
        releaseSecrets();
        releaseSave();
        await page.close();
      }
    },
  );

  it("exercises the real ledger UI, fixture OAuth, disclosure ownership and consistent tab spacing", async () => {
    const page = await browser.newPage();
    const projectId = randomUUID();
    const connectionId = randomUUID();
    try {
      const created = await page.request.post(`${origin}/api/v1/projects`, {
        data: {
          id: projectId,
          name: "MCP ledger test",
          repositoryUrl: "https://github.com/example/ledger",
        },
      });
      expectPage(created.status()).toBe(201);
      const secretCreated = await page.request.put(
        `${origin}/api/v1/projects/${projectId}/secrets/TOKEN`,
        { data: { value: "fixture-token" } },
      );
      expectPage(secretCreated.status()).toBe(200);
      expectPage(
        (
          await page.request.put(`${origin}/api/v1/projects/${projectId}/secrets/EXTRA`, {
            data: { value: "extra-fixture" },
          })
        ).status(),
      ).toBe(200);
      const seeded = await page.request.put(`${origin}/api/v1/projects/${projectId}/mcp`, {
        data: {
          revision: 0,
          servers: [
            {
              name: "alpha",
              url: "https://example.com/mcp",
              description: "Alpha",
              headers: {},
              oauth: { id: connectionId },
            },
            {
              name: "beta",
              url: "https://example.org/mcp",
              description: "Beta",
              headers: { Authorization: { secret: "TOKEN", prefix: "Bearer " } },
            },
          ],
        },
      });
      expectPage(seeded.status()).toBe(200);
      const blocked = await page.request.delete(
        `${origin}/api/v1/projects/${projectId}/secrets/TOKEN`,
      );
      expectPage(blocked.status()).toBe(409);
      expectPage((await blocked.json()).error.message).toContain("beta");
      await page.goto(`${origin}/#/projects/${projectId}/mcp`);
      const dialog = page.getByRole("dialog");
      const mcp = dialog.getByRole("tabpanel", { name: "MCPs", exact: true });
      const alpha = mcp
        .locator("details")
        .filter({ has: page.locator("summary", { hasText: "alpha" }) });
      const beta = mcp
        .locator("details")
        .filter({ has: page.locator("summary", { hasText: "beta" }) });
      await expectPage(alpha.locator("summary")).toContainText("authorization required");
      await expectPage(mcp.locator(".mcp-add-heading")).toHaveCount(0);
      await alpha.locator("summary").focus();
      await page.keyboard.press("Enter");
      await alpha.getByLabel("Description", { exact: true }).fill("Kept while collapsed");
      await beta.locator("summary").click();
      await expectPage(mcp.locator("details[open]")).toHaveCount(1);
      await alpha.locator("summary").click();
      await expectPage(alpha.getByLabel("Description", { exact: true })).toHaveValue(
        "Kept while collapsed",
      );
      await alpha.getByRole("button", { name: "connect", exact: true }).click();
      await expectPage(page).toHaveURL(/mcp-preview-consent=/);
      await expectPage(alpha.locator("summary")).toContainText("connected");
      await alpha.locator("summary").click();
      await alpha.getByRole("button", { name: "disconnect", exact: true }).click();
      await expectPage(alpha.locator("summary")).toContainText("authorization required");
      await mcp
        .locator(".mcp-add-area")
        .getByRole("button", { name: "add server", exact: true })
        .click();
      const add = mcp.locator(".mcp-add-area");
      await add.getByLabel("Name", { exact: true }).fill("new-service");
      await add.getByLabel("Endpoint", { exact: true }).fill("https://example.net/mcp");
      await add.getByRole("button", { name: "add & connect", exact: true }).click();
      await expectPage(mcp.locator("summary").filter({ hasText: "new-service" })).toContainText(
        "connected",
      );
      await dialog.getByRole("tab", { name: "Secrets", exact: true }).click();
      const secretRow = dialog
        .getByRole("tabpanel", { name: "Secrets", exact: true })
        .locator(".project-secret-row")
        .filter({ hasText: "TOKEN" });
      await expectPage(secretRow).toContainText("used by beta");
      await expectPage(
        secretRow.getByRole("button", { name: "remove", exact: true }),
      ).toBeDisabled();
      await expectPage(
        secretRow.getByRole("button", { name: "replace", exact: true }),
      ).toBeEnabled();
      await dialog.getByRole("tab", { name: "MCPs", exact: true }).click();
      await beta.locator("summary").click();
      const tokenSelect = beta.getByLabel("Token secret", { exact: true });
      await expectPage(tokenSelect).toHaveJSProperty("tagName", "SELECT");
      await expectPage(tokenSelect.locator('option[value="TOKEN"]')).toBeEnabled();
      await expectPage(tokenSelect.locator("option")).toHaveText([
        "Select a secret",
        "EXTRA",
        "TOKEN",
      ]);
      const spacing = [];
      for (const tab of ["MCPs", "Secrets", "General"]) {
        await dialog.getByRole("tab", { name: tab, exact: true }).click();
        const body = dialog
          .getByRole("tabpanel", { name: tab, exact: true })
          .locator(".project-secrets-body");
        spacing.push(
          await body.evaluate((el) => {
            const css = el.ownerDocument.defaultView?.getComputedStyle(el);
            return [css?.paddingTop, css?.paddingRight, css?.paddingBottom, css?.paddingLeft];
          }),
        );
      }
      expectPage(spacing).toEqual(Array(3).fill(["8px", "10px", "10px", "10px"]));
      const current = await (
        await page.request.get(`${origin}/api/v1/projects/${projectId}/mcp`)
      ).json();
      expectPage(
        (
          await page.request.put(`${origin}/api/v1/projects/${projectId}/mcp`, {
            data: {
              ...current,
              servers: current.servers.filter((s: { name: string }) => s.name !== "beta"),
            },
          })
        ).status(),
      ).toBe(200);
      await dialog.getByRole("tab", { name: "Secrets", exact: true }).click();
      await expectPage(
        secretRow.getByRole("button", { name: "remove", exact: true }),
      ).toBeEnabled();
      page.once("dialog", (dialog) => dialog.accept());
      await secretRow.getByRole("button", { name: "remove", exact: true }).click();
      await expectPage(secretRow).toHaveCount(0);
      expectPage(
        (
          await page.request.put(`${origin}/api/v1/projects/${projectId}/mcp`, {
            data: { ...current, revision: current.revision + 1 },
          })
        ).status(),
      ).toBe(409);
      await dialog.getByRole("tab", { name: "MCPs", exact: true }).click();
      await page.setViewportSize({ width: 390, height: 844 });
      expectPage(
        await dialog.evaluate((el) => el.getBoundingClientRect().width),
      ).toBeLessThanOrEqual(366);
    } finally {
      await page.request.delete(`${origin}/api/v1/projects/${projectId}`);
      await page.close();
    }
  });

  it("ends every desktop index header at the trashcan cell without an extra gutter", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/${ORB_HASH}`);
      const headers = page.locator(".orb-index .project-head");
      await expectPage(headers).toHaveCount(4);
      for (const header of await headers.all()) {
        const actions = header.locator(".project-head-actions");
        await expectPage(actions.getByRole("button", { name: /^Delete / })).toBeVisible();
        const geometry = await header.evaluate((node) => {
          const cells = [
            ...node.querySelectorAll(".project-head-actions > button, .project-head-actions > a"),
          ];
          return {
            rightGutter:
              node.getBoundingClientRect().right -
              cells[cells.length - 1]!.getBoundingClientRect().right,
            widths: cells.map((cell) => cell.getBoundingClientRect().width),
          };
        });
        expectPage(geometry.rightGutter).toBe(0);
        expectPage(geometry.widths).toEqual([28, 28, 28]);
      }
    } finally {
      await page.close();
    }
  });

  it.each(["", ORB_HASH])(
    "shares project header and validates General settings at %s",
    async (hash) => {
      const page = await browser.newPage();
      const response = await page.request.get(`${origin}/api/v1/projects`);
      let project = (await response.json()).items[0];
      const requests: unknown[] = [];
      await page.route("**/api/v1/projects", (route) =>
        route.fulfill({ json: { items: [project] } }),
      );
      await page.route(`**/api/v1/projects/${project.id}`, async (route) => {
        if (route.request().method() === "PATCH") {
          const update = route.request().postDataJSON();
          requests.push(update);
          if (requests.length === 1) {
            await route.fulfill({
              status: 503,
              json: {
                error: { code: "unavailable", message: "Could not save project", retryable: true },
              },
            });
            return;
          }
          project = { ...project, ...update };
        }
        await route.fulfill({ json: project });
      });
      try {
        await page.goto(`${origin}/${hash}`);
        const header = page.locator(".project-head").first();
        await expectPage(header.getByRole("button", { name: /^Configure / })).toBeVisible();
        await expectPage(header.locator(".project-name")).toHaveCSS("font-size", "18px");
        await expectPage(header.getByRole("button")).toHaveCount(2);
        expectPage(
          await header
            .locator("use")
            .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href"))),
        ).toEqual(hash === ORB_HASH ? ["#i-plus", "#i-gear", "#i-bin"] : ["#i-gear", "#i-bin"]);
        expectPage(
          await header.evaluate((node) =>
            node.parentElement?.lastElementChild?.classList.contains("project-new-orb-row"),
          ),
        ).toBe(hash !== ORB_HASH);
        await header.getByRole("button", { name: /^Configure / }).click();
        const dialog = page.getByRole("dialog");
        const general = dialog.getByRole("tabpanel", { name: "General", exact: true });
        await general.getByLabel("Name", { exact: true }).fill("Updated project");
        await general
          .getByLabel("Repository URL", { exact: true })
          .fill("https://github.com/acme/repo/tree/main");
        await expectPage(general.getByRole("button", { name: "save", exact: true })).toBeDisabled();
        await expectPage(general.getByRole("alert")).toBeVisible();
        expectPage(requests).toHaveLength(0);
        await dialog.getByRole("tab", { name: "Secrets", exact: true }).click();
        await dialog.getByRole("tab", { name: "General", exact: true }).click();
        await expectPage(general.getByLabel("Name", { exact: true })).toHaveValue(
          "Updated project",
        );
        await expectPage(general.getByLabel("Repository URL", { exact: true })).toHaveValue(
          "https://github.com/acme/repo/tree/main",
        );
        await general
          .getByLabel("Repository URL", { exact: true })
          .fill("git@github.com:acme/new.git");
        await expectPage(general.getByRole("button", { name: "save", exact: true })).toBeEnabled();
        await general.getByRole("button", { name: "save", exact: true }).click();
        await expectPage(general.getByRole("alert")).toBeVisible();
        await expectPage(general.getByLabel("Name", { exact: true })).toHaveValue(
          "Updated project",
        );
        await expectPage(general.getByLabel("Repository URL", { exact: true })).toHaveValue(
          "git@github.com:acme/new.git",
        );
        await dialog.getByRole("tab", { name: "Secrets", exact: true }).click();
        await dialog.getByRole("tab", { name: "General", exact: true }).click();
        await expectPage(general.getByRole("alert")).toBeVisible();
        await general.getByRole("button", { name: "save", exact: true }).click();
        await expectPage(
          header.getByRole("heading", { name: "Updated project", exact: true }),
        ).toBeVisible();
        expectPage(requests).toEqual([
          { name: "Updated project", repositoryUrl: "https://github.com/acme/new.git" },
          { name: "Updated project", repositoryUrl: "https://github.com/acme/new.git" },
        ]);
        await expectPage(general.getByLabel("Repository URL", { exact: true })).toHaveValue(
          "https://github.com/acme/new.git",
        );
        if (hash) await expectPage(page).toHaveTitle(/Updated project/);
        await dialog.getByRole("button", { name: "Close project config" }).click();
        await header.getByRole("button", { name: /^Configure / }).click();
        await expectPage(
          page
            .getByRole("tabpanel", { name: "General", exact: true })
            .getByLabel("Name", { exact: true }),
        ).toHaveValue("Updated project");
      } finally {
        await page.close();
      }
    },
  );

  it("centers dashboard status icons with single-line orb names at desktop, phone, and zoom", async () => {
    const page = await browser.newPage();
    try {
      for (const scenario of [
        { width: 1280, height: 900, zoom: 1 },
        { width: 390, height: 844, zoom: 1 },
        { width: 1280, height: 900, zoom: 1.5 },
      ]) {
        await page.setViewportSize({ width: scenario.width, height: scenario.height });
        await page.goto(`${origin}/`);
        await page.locator(".orb-entry-title").first().waitFor();
        await page.locator("html").evaluate((element, zoom) => {
          element.setAttribute("style", zoom === 1 ? "" : `zoom: ${zoom}`);
        }, scenario.zoom);
        const rows = await page.locator(".orb-entry-title").evaluateAll((titles) =>
          titles.map((title) => {
            const icon = title.querySelector(".glyph");
            const link = title.querySelector(".orb-entry-link");
            if (icon === null || link === null) return null;
            const iconBox = icon.getBoundingClientRect();
            const linkBox = link.getBoundingClientRect();
            return {
              centerDelta: Math.abs(
                iconBox.top + iconBox.height / 2 - (linkBox.top + linkBox.height / 2),
              ),
              whiteSpace: title.ownerDocument.defaultView?.getComputedStyle(link).whiteSpace,
            };
          }),
        );
        expectPage(rows.length).toBeGreaterThan(0);
        expectPage(rows.every((row) => row !== null && row.centerDelta <= 0.5)).toBe(true);
        expectPage(rows.every((row) => row?.whiteSpace === "nowrap")).toBe(true);
      }
    } finally {
      await page.close();
    }
  });

  it("inverts every production text-field surface on focus and restores it on blur", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await page.goto(`${origin}/`);
      await expectPage(
        page.getByRole("heading", { name: "New project", exact: true }),
      ).toBeVisible();
      await expectTextFieldContrast(page, page.locator(".new-project"));

      await page.keyboard.press("Meta+k");
      const search = page.getByRole("dialog", { name: "Find projects and orbs" });
      await expectTextFieldContrast(page, search);
      await page.keyboard.press("Escape");

      await page.getByRole("button", { name: "Personal instructions" }).click();
      const personal = page.getByRole("dialog", { name: "~/AGENTS.md" });
      await expectTextFieldContrast(page, personal);
      await personal.getByRole("button", { name: "Close personal instructions" }).click();

      await page
        .getByRole("button", { name: /^Configure / })
        .first()
        .click();
      const config = page.getByRole("dialog");
      await expectTextFieldContrast(page, config.getByRole("tabpanel", { name: "General" }));
      await config.getByRole("tab", { name: "Instructions" }).click();
      await expectTextFieldContrast(page, config.getByRole("tabpanel", { name: "Instructions" }));
      await config.getByRole("tab", { name: "MCPs" }).click();
      await config.getByRole("button", { name: "add server", exact: true }).click();
      await expectTextFieldContrast(page, config.getByRole("tabpanel", { name: "MCPs" }));
      await config.getByRole("tab", { name: "Secrets" }).click();
      await expectTextFieldContrast(page, config.getByRole("tabpanel", { name: "Secrets" }));
      await config.getByRole("button", { name: "Close project config" }).click();

      await page.goto(`${origin}/${ORB_HASH}`);
      const composer = page.getByRole("textbox", { name: "Message the orb", exact: true });
      await expectPage(composer).toBeVisible();
      await expectTextFieldContrast(page, page.locator(".composer"));
      const blockCaret = page.locator(".composer-caret");
      await composer.focus();
      await expectPage(composer).toHaveAttribute("data-block-caret", "true");
      await expectPage(blockCaret).toBeVisible();
      await expectPage(blockCaret).toHaveCSS("background-color", "rgb(255, 255, 255)");
      await expectPage(blockCaret).toHaveCSS("mix-blend-mode", "difference");
      await page.getByRole("button", { name: "Rename orb" }).click();
      await expectTextFieldContrast(page, page.locator(".orb-rename-form"));
    } finally {
      await page.close();
    }
  });

  it("keeps native selection visible on normal and inverted surfaces", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/`);
      await expectPage(
        page.getByRole("heading", { name: "New project", exact: true }),
      ).toBeVisible();
      const styles = await page.locator("body").evaluate((body) => {
        const document = body.ownerDocument;
        const window = document.defaultView;
        if (window === null) return [];
        const surfaces: (typeof body)[] = [];
        for (const tag of ["input", "textarea"] as const) {
          const control = document.createElement(tag);
          control.value = "Selected text";
          document.body.append(control);
          control.focus();
          control.setSelectionRange(0, 8);
          surfaces.push(control);
        }
        const dark = document.createElement("span");
        dark.className = "user-code";
        dark.textContent = "Selected code";
        document.body.append(dark);
        const range = document.createRange();
        range.selectNodeContents(dark);
        document.getSelection()?.removeAllRanges();
        document.getSelection()?.addRange(range);
        surfaces.push(dark, document.body);
        const results = surfaces.map((element) => {
          if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") element.focus();
          const selected = window.getComputedStyle(element, "::selection");
          return { background: selected.backgroundColor, color: selected.color };
        });
        for (const element of surfaces) if (element !== document.body) element.remove();
        return results;
      });
      expectPage(styles).toEqual(
        Array.from({ length: 4 }, () => ({
          background: "rgb(153, 153, 153)",
          color: "rgb(0, 0, 0)",
        })),
      );
    } finally {
      await page.close();
    }
  });

  it("uploads arbitrary files in chunks without touching the draft and hides upload when stopped", async () => {
    const page = await browser.newPage();
    await page.goto(`${origin}/${ORB_HASH}`);
    const draft = page.getByRole("textbox", { name: "Message the orb", exact: true });
    await draft.fill("Keep this draft");
    const chunks: Promise<number>[] = [];
    page.on("response", (response) => {
      const request = response.request();
      if (request.method() === "PUT" && request.url().includes("/chunk?")) {
        const offset = Number(new URL(request.url()).searchParams.get("offset"));
        // Routing the finish request omits browser-added Content-Length from
        // Playwright's request view. Measure bytes counted by the server instead.
        chunks.push(response.json().then((row: { offset: number }) => row.offset - offset));
      }
    });
    let release = () => {};
    let arrived = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finishing = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    await page.route("**/uploads/*/finish", async (route) => {
      arrived();
      await gate;
      await route.continue();
    });
    try {
      const choosing = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: "Upload files", exact: true }).click();
      await (await choosing).setFiles({
        name: "fixture.bin",
        mimeType: "application/octet-stream",
        buffer: Buffer.alloc(4 * 1024 * 1024 + 13, 0xff),
      });
      await finishing;
      await expectPage(page.getByRole("dialog")).toHaveCount(0);
      await expectPage(page.getByRole("region", { name: "File transfers" })).toContainText(
        "finalizing",
      );
      expectPage(await Promise.all(chunks)).toEqual([4 * 1024 * 1024, 13]);
    } finally {
      release();
    }
    await expectPage(page.getByRole("region", { name: "File transfers" })).toHaveCount(0);
    await expectPage(draft).toHaveValue("Keep this draft");
    await expectPage(page.locator(".history")).toContainText("The user uploaded a file");
    await page.getByRole("button", { name: "Stop orb", exact: true }).click();
    await expectPage(page.getByRole("button", { name: "Start orb", exact: true })).toBeVisible();
    await expectPage(page.getByRole("button", { name: "Upload files", exact: true })).toHaveCount(
      0,
    );
    await page.getByRole("button", { name: "Start orb", exact: true }).click();
    await expectPage(page.getByRole("button", { name: "Upload files", exact: true })).toBeVisible();
    await page.close();
  });

  it("sends one message for a multi-file selection, including after one file needs retry", async () => {
    const page = await browser.newPage();
    let batchId = "";
    let secondId = "";
    let registrations = 0;
    let failSecond = true;
    await page.route("**/uploads", async (route) => {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON() as {
          id: string;
          files: { id: string; name: string }[];
        };
        batchId = body.id;
        secondId = body.files.find((file) => file.name === "batch-second.bin")?.id ?? "";
        registrations++;
      }
      await route.continue();
    });
    await page.route("**/uploads/*/chunk?*", async (route) => {
      if (failSecond && route.request().url().includes(secondId)) {
        failSecond = false;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "unavailable", message: "second file interrupted", retryable: true },
          }),
        });
      } else await route.continue();
    });
    const messages = async () => {
      const response = await page.request.get(
        `${origin}/api/v1/orbs/${ORB_HASH.split("/").at(-1)}/messages`,
      );
      return (
        (await response.json()) as { items: { id: string; content: unknown }[] }
      ).items.filter((row) => row.id === batchId);
    };
    try {
      await page.goto(`${origin}/${ORB_HASH}`);
      const choosing = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: "Upload files", exact: true }).click();
      await (await choosing).setFiles(
        ["batch-first.bin", "batch-second.bin"].map((name) => ({
          name,
          mimeType: "application/octet-stream",
          buffer: Buffer.from([0, 255, 1]),
        })),
      );
      const transfers = page.getByRole("region", { name: "File transfers" });
      await expectPage(transfers).toContainText("stored · notification pending");
      await expectPage(transfers).toContainText("second file interrupted");
      expectPage(await messages()).toHaveLength(0);
      await transfers
        .locator(".workspace-upload-row")
        .filter({ hasText: "batch-second.bin" })
        .getByRole("button", { name: "retry", exact: true })
        .click();
      await expectPage(transfers).toHaveCount(0);
      const accepted = await messages();
      expectPage(accepted).toHaveLength(1);
      expectPage(JSON.stringify(accepted[0]?.content)).toContain("batch-first.bin");
      expectPage(JSON.stringify(accepted[0]?.content)).toContain("batch-second.bin");
      expectPage(registrations).toBe(1);
    } finally {
      await page.close();
    }
  });

  it("starts another selection while an earlier upload is still sending", async () => {
    const page = await browser.newPage();
    let release = () => {};
    let arrived = () => {};
    let holdFirst = true;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sending = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    await page.route("**/uploads/*/chunk?*", async (route) => {
      if (holdFirst) {
        holdFirst = false;
        arrived();
        await gate;
      }
      await route.continue();
    });
    const choose = async (name: string) => {
      const choosing = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: "Upload files", exact: true }).click();
      await (await choosing).setFiles({
        name,
        mimeType: "application/octet-stream",
        buffer: Buffer.from([1, 0, 255]),
      });
    };
    try {
      await page.goto(`${origin}/${ORB_HASH}`);
      await choose("held-first.bin");
      await sending;
      await choose("independent-second.bin");
      await expectPage(page.locator(".history")).toContainText("independent-second.bin");
      await expectPage(page.getByRole("region", { name: "File transfers" })).toContainText(
        "held-first.bin",
      );
      release();
      await expectPage(page.getByRole("region", { name: "File transfers" })).toHaveCount(0);
      await expectPage(page.locator(".history")).toContainText("held-first.bin");
    } finally {
      release();
      await page.close();
    }
  });

  it("keeps automatic-upload failures inline and retries the same file identity", async () => {
    const page = await browser.newPage();
    let failChunk = true;
    const ids = new Set<string>();
    await page.route("**/uploads/*/chunk?*", async (route) => {
      ids.add(new URL(route.request().url()).pathname.split("/").at(-2) ?? "");
      if (failChunk) {
        failChunk = false;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "unavailable", message: "test upload interruption", retryable: true },
          }),
        });
      } else await route.continue();
    });
    try {
      await page.goto(`${origin}/${ORB_HASH}`);
      const choosing = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: "Upload files", exact: true }).click();
      await (await choosing).setFiles({
        name: "retry-direct.bin",
        mimeType: "application/octet-stream",
        buffer: Buffer.from([0, 255, 1]),
      });
      const transfers = page.getByRole("region", { name: "File transfers" });
      await expectPage(transfers).toContainText("test upload interruption");
      await expectPage(page.getByRole("dialog")).toHaveCount(0);
      await transfers.getByRole("button", { name: "retry", exact: true }).click();
      await expectPage(transfers).toHaveCount(0);
      await expectPage(page.locator(".history")).toContainText("retry-direct.bin");
      expectPage(ids.size).toBe(1);
    } finally {
      await page.close();
    }
  });

  it("toggles a headerless terminal shade without moving history or replacing its session", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const controls: { type: string; cols: number; rows: number }[] = [];
    const inputs: Buffer[] = [];
    let connections = 0;
    let closedConnections = 0;
    page.on("websocket", (socket) => {
      if (!socket.url().endsWith("/frontend-long-history/terminal")) return;
      connections += 1;
      socket.on("close", () => {
        closedConnections += 1;
      });
      socket.on("framesent", ({ payload }) => {
        if (typeof payload === "string") controls.push(JSON.parse(payload));
        else inputs.push(payload);
      });
    });
    // Keep unrelated initial live replay/inbox commits out of the geometry
    // assertion. The terminal still uses the fixture's real socket adapter.
    await page.routeWebSocket("**/orbs/frontend-long-history/live", (socket) => {
      socket.connectToServer().onMessage(() => {});
    });
    await page.route("**/orbs/frontend-long-history/messages", (route) =>
      route.fulfill({ json: { items: [] } }),
    );
    const geometry = () =>
      page.locator("body").evaluate((body) => {
        const document = body.ownerDocument;
        const history = document.querySelector(".history")?.getBoundingClientRect();
        const composer = document.querySelector(".composer")?.getBoundingClientRect();
        return {
          scroll: document.defaultView?.scrollY,
          history: history && { top: history.top, width: history.width, height: history.height },
          composer: composer && { top: composer.top, height: composer.height },
        };
      });
    try {
      await page.goto(`${origin}/#/orbs/frontend-long-history`);
      await expectPage(page.locator(".history .rec-you")).toHaveCount(100);
      const composer = page.getByRole("textbox", { name: "Message the orb", exact: true });
      await composer.fill("draft survives terminal toggles");
      await page.locator("body").evaluate(async (body) => {
        const window = body.ownerDocument.defaultView;
        if (window === null) return;
        await new Promise<void>((resolve) => {
          window.addEventListener("scroll", () => window.requestAnimationFrame(() => resolve()), {
            once: true,
          });
          window.scrollTo(0, 1200);
        });
      });
      const before = await geometry();
      const header = page.locator(".orb-header");
      const actionBoxes = await header
        .locator(
          '.orb-header-actions > button:not([aria-label="Stop orb"]):not([aria-label="Start orb"])',
        )
        .evaluateAll((buttons) =>
          buttons.map((button) => {
            const box = button.getBoundingClientRect();
            return { x: box.x, width: box.width };
          }),
        );
      // Lifecycle cluster moves Stop beside status; the four utility controls retain 20px hits / 28px pitch.
      expectPage(actionBoxes).toHaveLength(4);
      actionBoxes.forEach((box, index) => {
        expectPage(box.width).toBe(20);
        if (index > 0) expectPage(box.x - (actionBoxes[index - 1]?.x ?? 0)).toBe(28);
      });
      await page.keyboard.press("Meta+j");
      const panel = page.getByRole("complementary", { name: "Interactive terminal" });
      await expectPage(panel).toContainText("frontend fixture terminal");
      await expectPage(panel.locator("header")).toHaveCount(0);
      await expectPage(panel.locator("button")).toHaveCount(0);
      await expectPage(panel).toHaveCSS("animation-name", "none");
      await expectPage(panel).toHaveCSS("transition-duration", "0s");
      await expectPage(panel).toHaveCSS("border-top-width", "1px");
      await expectPage(panel).toHaveCSS("border-left-width", "1px");
      await expectPage(panel).toHaveCSS("border-right-width", "1px");
      await expectPage(panel).toHaveCSS("border-bottom-width", "1px");
      await expectPage(panel.locator(".wterm")).toHaveCSS("box-shadow", "none");
      await expectPage(panel.locator(".orb-terminal-loading")).toHaveCount(0);
      const headerBox = await header.boundingBox();
      const panelBox = await panel.boundingBox();
      // Overlay the existing header/index rules, rather than drawing an
      // adjacent second pixel. The right edge still ends at the header edge.
      expectPage(panelBox?.x).toBe((headerBox?.x ?? 0) - 1);
      expectPage(panelBox?.width).toBe((headerBox?.width ?? 0) + 1);
      expectPage(panelBox?.y).toBe((headerBox?.y ?? 0) + (headerBox?.height ?? 0) - 1);
      expectPage(await geometry()).toEqual(before);
      // StrictMode can legitimately mount, dispose, and mount again before
      // the first greeting. The invariant is no replacement AFTER readiness.
      const connectionsBeforeHide = connections;
      const closedBeforeHide = closedConnections;
      const opensBeforeHide = controls.filter((control) => control.type === "terminal.open").length;
      expectPage(opensBeforeHide).toBeGreaterThan(0);
      await page.keyboard.type("SESSION_KEPT");
      await expectPage(panel).toContainText("SESSION_KEPT");
      // Escape is terminal input, not a window-manager shortcut (vim needs it).
      await page.keyboard.press("Escape");
      await expectPage(panel).toBeVisible();
      await expectPage.poll(() => inputs.some((input) => input.includes(27))).toBe(true);
      const inputCount = inputs.length;
      const emulator = await panel.locator(".wterm").elementHandle();
      await page.keyboard.press("Meta+j");
      await expectPage(page.locator(".orb-terminal-window")).toBeHidden();
      expectPage(await geometry()).toEqual(before);
      await expectPage(composer).toHaveValue("draft survives terminal toggles");
      await expectPage(composer).toBeFocused();
      await composer.dispatchEvent("keydown", { key: "j", metaKey: true, repeat: true });
      await expectPage(page.locator(".orb-terminal-window")).toBeHidden();
      await page.keyboard.press("Meta+j");
      await expectPage(panel).toContainText("SESSION_KEPT");
      expectPage(inputs).toHaveLength(inputCount);
      expectPage(
        await emulator?.evaluate((node) => node === node.ownerDocument.querySelector(".wterm")),
      ).toBe(true);
      expectPage(connections).toBe(connectionsBeforeHide);
      expectPage(closedConnections).toBe(closedBeforeHide);
      expectPage(controls.filter((control) => control.type === "terminal.open")).toHaveLength(
        opensBeforeHide,
      );
      expectPage(await geometry()).toEqual(before);
      // Fill scrollback: scrollTop being a multiple of 20 alone is not
      // sufficient if padding scrolls with the grid (the old first row was -7px).
      for (let line = 0; line < 30; line += 1) await page.keyboard.press("Enter");
      await page.keyboard.type("SCROLLBACK_READY");
      await expectPage(panel).toContainText("SCROLLBACK_READY");
      const rowEdges = () =>
        panel.locator(".wterm").evaluate((node) => {
          const viewport = node.getBoundingClientRect();
          const visible = [...node.querySelectorAll(".term-row")]
            .map((row) => row.getBoundingClientRect())
            .filter((row) => row.bottom > viewport.top && row.top < viewport.bottom);
          return {
            first: visible[0]?.top === viewport.top,
            last: visible.at(-1)?.bottom === viewport.bottom,
          };
        });
      await expectPage.poll(rowEdges).toEqual({ first: true, last: true });
      const scrollStart = await panel.locator(".wterm").evaluate((node) => {
        node.setAttribute("data-scroll-ended", "false");
        node.addEventListener("scrollend", () => node.setAttribute("data-scroll-ended", "true"), {
          once: true,
        });
        return node.scrollTop;
      });
      await panel.locator(".wterm").hover();
      await page.mouse.wheel(0, -53);
      await expectPage(panel.locator(".wterm")).toHaveAttribute("data-scroll-ended", "true");
      expectPage(await panel.locator(".wterm").evaluate((node) => node.scrollTop)).toBeLessThan(
        scrollStart,
      );
      expectPage(await rowEdges()).toEqual({ first: true, last: true });
      const focusBeforeDrag = await page.locator(":focus").elementHandle();
      const edge = panel.getByRole("separator", { name: "Resize terminal" });
      const startHeight = panelBox?.height ?? 0;
      const startEmulatorHeight = await panel
        .locator(".wterm")
        .evaluate((node) => node.clientHeight);
      const resizeCount = () =>
        controls.filter((control) => control.type === "terminal.resize").length;
      const beforeDrag = resizeCount();
      const edgeBox = await edge.boundingBox();
      const x = (edgeBox?.x ?? 0) + (edgeBox?.width ?? 0) / 2;
      const y = (edgeBox?.y ?? 0) + 4;
      await page.mouse.move(x, y);
      await page.mouse.down();
      expectPage(
        await focusBeforeDrag?.evaluate((node) => node === node.ownerDocument.activeElement),
      ).toBe(true);
      await expectPage(edge).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expectPage(panel).toHaveCSS("border-bottom-width", "1px");
      await page.mouse.move(x, y + 8);
      await expectPage(panel).toHaveCSS("height", `${startHeight}px`);
      await page.mouse.move(x, y + 49);
      await expectPage(panel).toHaveCSS("height", `${startHeight + 40}px`);
      await page.mouse.move(x, y + 51);
      await expectPage(panel).toHaveCSS("height", `${startHeight + 60}px`);
      await edge.dispatchEvent("pointercancel", { pointerId: 2 });
      await expectPage(panel).toHaveCSS("height", `${startHeight + 60}px`);
      await expectPage(panel.locator(".wterm")).toHaveCSS("height", `${startEmulatorHeight}px`);
      expectPage(resizeCount()).toBe(beforeDrag);
      expectPage((await panel.boundingBox())?.y).toBe(panelBox?.y);
      expectPage((await panel.boundingBox())?.width).toBe(panelBox?.width);
      expectPage(await geometry()).toEqual(before);
      await page.mouse.up();
      expectPage(
        await focusBeforeDrag?.evaluate((node) => node === node.ownerDocument.activeElement),
      ).toBe(true);
      await expectPage.poll(rowEdges).toEqual({ first: true, last: true });
      await expectPage.poll(resizeCount).toBe(beforeDrag + 1);
      await expectPage(panel.locator(".wterm")).toHaveCSS(
        "height",
        `${startEmulatorHeight + 60}px`,
      );
      await edge.press("ArrowUp");
      await expectPage(panel).toHaveCSS("height", `${startHeight + 40}px`);
      await expectPage.poll(resizeCount).toBe(beforeDrag + 2);
      await expectPage(edge).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expectPage(edge).toHaveCSS("outline-width", "0px");
      await composer.focus();
      const cancelBox = await edge.boundingBox();
      const cancelY = (cancelBox?.y ?? 0) + 4;
      await page.mouse.move(x, cancelY);
      await page.mouse.down();
      await page.mouse.move(x, cancelY - 61);
      await expectPage(panel).toHaveCSS("height", `${startHeight - 20}px`);
      await edge.dispatchEvent("pointercancel", { pointerId: 1 });
      await page.mouse.up();
      await expectPage(panel).toHaveCSS("height", `${startHeight + 40}px`);
      expectPage(resizeCount()).toBe(beforeDrag + 2);
      await expectPage(composer).toBeFocused();
      await expectPage(panel).toHaveCSS("border-bottom-width", "1px");
      await page.keyboard.press("Meta+j");
      await expectPage(page.locator(".orb-terminal-window")).toBeHidden();
      await page.keyboard.press("Meta+j");
      await expectPage(panel).toHaveCSS("height", `${startHeight + 40}px`);
      await expectPage(panel).toContainText("SESSION_KEPT");
      expectPage(connections).toBe(connectionsBeforeHide);
      const firstCols = controls[0]?.cols;
      await page.setViewportSize({ width: 1000, height: 600 });
      await expectPage
        .poll(() =>
          controls.some(
            (control) => control.type === "terminal.resize" && control.cols !== firstCols,
          ),
        )
        .toBe(true);
      const resizedHeader = await header.boundingBox();
      await expectPage
        .poll(async () => (await panel.boundingBox())?.width)
        .toBe((resizedHeader?.width ?? 0) + 1);
      const resizedPanel = await panel.boundingBox();
      const composerBox = await page.locator(".composer").boundingBox();
      expectPage((resizedPanel?.y ?? 0) + (resizedPanel?.height ?? 0)).toBeLessThanOrEqual(
        composerBox?.y ?? 0,
      );
      const emulatorHeight = await panel.locator(".wterm").evaluate((node) => node.clientHeight);
      expectPage(emulatorHeight % 20).toBe(0);
      await expectPage.poll(rowEdges).toEqual({ first: true, last: true });
      // Deliberately stop only this page's admission view; no shared fixture
      // lifecycle mutation can interfere with later cases.
      await page.route("**/api/v1/orbs/frontend-long-history", async (route) => {
        const response = await route.fetch();
        const orb = await response.json();
        await route.fulfill({ response, json: { ...orb, state: "stopped" } });
      });
      await expectPage(header.getByRole("button", { name: "Start orb" })).toBeVisible();
      await expectPage(page.locator(".orb-terminal-window")).toHaveCount(0);
      await expectPage(header.getByRole("button", { name: /^(Open|Hide) terminal$/ })).toHaveCount(
        0,
      );
    } finally {
      await page.close();
    }
  });

  it("keeps delayed terminal readiness hidden and exposes an explicit retry after exit", async () => {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      let readyCalls = 0;
      Reflect.set(globalThis, "__terminalReadyGate", () => {
        Reflect.set(globalThis, "__terminalReadyCalls", ++readyCalls);
        return {
          ordinal: readyCalls,
          pause:
            readyCalls % 2 === 0
              ? new Promise<void>((resolve) =>
                  Reflect.set(globalThis, "__releaseTerminalReady", resolve),
                )
              : undefined,
        };
      });
    });
    let accept = () => {};
    let exit = () => {};
    let opens = 0;
    const active = new Set<number>();
    await page.routeWebSocket("**/orbs/frontend-fixture-orb/terminal*", (socket) => {
      const ordinal = Number(new URL(socket.url()).searchParams.get("ready"));
      socket.onClose(() => active.delete(ordinal));
      socket.onMessage((data) => {
        if (typeof data !== "string") return;
        const control = JSON.parse(data);
        if (control.type !== "terminal.open") return;
        opens += 1;
        active.add(ordinal);
        accept = () => {
          socket.send(
            JSON.stringify({
              v: 1,
              type: "terminal.ready",
              cols: control.cols,
              rows: control.rows,
            }),
          );
          socket.send(Buffer.from("READY_AFTER_HIDE\r\n# "));
        };
        exit = () =>
          socket.send(JSON.stringify({ v: 1, type: "terminal.exit", exitCode: 7, signal: 0 }));
      });
    });
    try {
      await page.goto(`${origin}/${ORB_HASH}`);
      const header = page.locator(".orb-header");
      await header.getByRole("button", { name: "Open terminal", exact: true }).click();
      // StrictMode may retire its first emulator before OR after its socket
      // opens. Synchronize on the final emulator's identity, not a cumulative
      // count of pre-ready connections; all superseded peers must close.
      await page.waitForFunction(() => Reflect.get(globalThis, "__terminalReadyCalls") === 2);
      await page.evaluate(() => Reflect.get(globalThis, "__releaseTerminalReady")());
      await expectPage.poll(() => [...active]).toEqual([2]);
      const firstGenerationOpens = opens;
      await header.getByRole("button", { name: "Hide terminal", exact: true }).click();
      const composer = page.getByRole("textbox", { name: "Message the orb", exact: true });
      await composer.fill("keep focus here");
      accept();
      await expectPage(page.locator(".orb-terminal-window")).toContainText("READY_AFTER_HIDE");
      await expectPage(composer).toBeFocused();
      await expectPage(page.locator(".orb-terminal-window")).toBeHidden();
      await header.getByRole("button", { name: "Open terminal", exact: true }).click();
      exit();
      await expectPage(page.locator(".orb-terminal-window").getByRole("alert")).toContainText(
        "Terminal exited with code 7.",
      );
      await page.getByRole("button", { name: "New terminal", exact: true }).click();
      await page.waitForFunction(() => Reflect.get(globalThis, "__terminalReadyCalls") === 4);
      await page.evaluate(() => Reflect.get(globalThis, "__releaseTerminalReady")());
      await expectPage.poll(() => [...active]).toEqual([4]);
      expectPage(opens).toBeGreaterThan(firstGenerationOpens);
      const recoveredOpens = opens;
      accept();
      await expectPage(page.locator(".orb-terminal-window")).toContainText("READY_AFTER_HIDE");
      await expectPage(page.getByRole("button", { name: "New terminal", exact: true })).toHaveCount(
        0,
      );
      await expectPage(composer).toHaveValue("keep focus here");
      expectPage(opens).toBe(recoveredOpens);
      expectPage([...active]).toEqual([4]);
    } finally {
      await page.close();
    }
  });

  it("skips unchanged long history while typing and still renders sent/live messages", async () => {
    const page = await browser.newPage();
    try {
      // Hold live replay and inbox responses before navigation: an initial
      // sync can otherwise race the typing assertion and legitimately render.
      let releaseLive = () => {};
      await page.routeWebSocket("**/orbs/frontend-long-history/live", (socket) => {
        const server = socket.connectToServer();
        const buffered: (string | Buffer)[] = [];
        let released = false;
        server.onMessage((message) => {
          if (released) socket.send(message);
          else buffered.push(message);
        });
        releaseLive = () => {
          released = true;
          for (const message of buffered) socket.send(message);
          buffered.length = 0;
        };
      });
      await page.route("**/api/v1/orbs/frontend-long-history/messages", (route) => route.abort());
      await page.goto(`${origin}/#/orbs/frontend-long-history`);
      const composer = page.getByRole("textbox", { name: "Message the orb", exact: true });
      await expectPage(page.locator(".history .rec-you")).toHaveCount(100);
      await expectPage(page.locator(".history")).toContainText("Review 100");
      // The fixture is idle. Gate background history/inbox refreshes so this
      // assertion measures only draft updates, not unrelated polling commits.
      await page.route("**/api/v1/orbs/frontend-long-history/history", (route) => route.abort());
      const before = await page.evaluate(
        () => Reflect.get(globalThis, "__historyRenders") as number,
      );
      expectPage(before).toBeGreaterThan(0);
      await composer.pressSequentially("typing must not reparse history");
      await expectPage(composer).toHaveValue("typing must not reparse history");
      expectPage(await page.evaluate(() => Reflect.get(globalThis, "__historyRenders"))).toBe(
        before,
      );
      await page.unroute("**/api/v1/orbs/frontend-long-history/history");
      await page.unroute("**/api/v1/orbs/frontend-long-history/messages");
      releaseLive();
      await composer.press("Control+Enter");
      await expectPage(composer).toHaveValue("");
      await expectPage(page.locator(".history .rec-you").last()).toContainText(
        "typing must not reparse history",
      );
      await expectPage(page.locator(".history .rec-orb").last()).toContainText(
        "typing must not reparse history",
      );
      expectPage(
        await page.evaluate(() => Reflect.get(globalThis, "__historyRenders")),
      ).toBeGreaterThan(before);
    } finally {
      await page.close();
    }
  });

  it("creates from + without unmounting the workspace or clearing the draft", async () => {
    const page = await browser.newPage();
    await page.clock.install();
    let createdId: string | undefined;
    let releaseCreate = () => {};
    let releaseHistory = () => {};
    let releaseList = () => {};
    let createArrived = () => {};
    let historyArrived = () => {};
    let listArrived = () => {};
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const historyGate = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    const listGate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    const createRequested = new Promise<void>((resolve) => {
      createArrived = resolve;
    });
    const historyRequested = new Promise<void>((resolve) => {
      historyArrived = resolve;
    });
    const listRequested = new Promise<void>((resolve) => {
      listArrived = resolve;
    });
    try {
      await page.goto(`${origin}/${ORB_HASH}`);
      const index = page.getByRole("navigation", { name: "All project orbs" });
      const composer = page.getByRole("textbox", { name: "Message the orb", exact: true });
      await composer.fill("keep this draft while creating");
      await expectPage(
        index.getByRole("link", { name: "New orb in scratchpad", exact: true }),
      ).toBeVisible();
      const indexNode = await index.elementHandle();
      const historyNode = await page.locator(".history").elementHandle();
      const composerNode = await composer.elementHandle();
      const transcript = await page.locator(".history").innerText();
      await page.route("**/api/v1/projects/frontend-scratchpad-project/orbs", async (route) => {
        if (route.request().method() === "POST") {
          createdId = route.request().postDataJSON().id;
          createArrived();
          await createGate;
          await route.continue();
        } else {
          const response = await route.fetch();
          listArrived();
          await listGate;
          await route.fulfill({ response });
        }
      });
      await page.route("**/api/v1/orbs/*/history", async (route) => {
        if (createdId !== undefined && route.request().url().includes(`/orbs/${createdId}/`)) {
          const response = await route.fetch();
          historyArrived();
          await historyGate;
          await route.fulfill({ response });
        } else await route.continue();
      });
      await index.getByRole("link", { name: "New orb in scratchpad", exact: true }).click();
      await createRequested;
      await expectPage(page).toHaveURL(`${origin}/${ORB_HASH}`);
      await expectPage(
        index.getByRole("button", { name: "Creating orb in scratchpad", exact: true }),
      ).toBeDisabled();
      await expectPage(index.getByRole("status")).toContainText("creating orb…");
      expectPage(await indexNode?.evaluate((node) => node.isConnected)).toBe(true);
      expectPage(await historyNode?.evaluate((node) => node.isConnected)).toBe(true);
      expectPage(await composerNode?.evaluate((node) => node.isConnected)).toBe(true);
      await expectPage(composer).toHaveValue("keep this draft while creating");
      expectPage(await page.locator(".history").innerText()).toBe(transcript);
      // Snapshot an empty list before acceptance; it must not erase the accepted row later.
      await page.clock.runFor(2000);
      await listRequested;
      releaseCreate();
      await historyRequested;
      const newRow = index.locator(`a[href="#/orbs/${createdId}"]`);
      await expectPage(newRow).toHaveAttribute("aria-current", "page");
      await expectPage(index).toHaveAttribute("aria-busy", "true");
      await expectPage(page.locator(".orb-main")).toHaveAttribute("inert", "");
      expectPage(await historyNode?.evaluate((node) => node.isConnected)).toBe(true);
      await expectPage(composer).toHaveValue("keep this draft while creating");
      const staleResponse = page.waitForResponse(
        (response) =>
          response.url().endsWith("/projects/frontend-scratchpad-project/orbs") &&
          response.request().method() === "GET",
      );
      releaseList();
      await (await staleResponse).finished();
      await page.clock.runFor(32);
      await expectPage(newRow).toHaveAttribute("aria-current", "page");
      releaseHistory();
      await expectPage(index).toHaveAttribute("aria-busy", "false");
      await expectPage(page.locator(".orb-name")).toHaveText("untitled orb");
      expectPage(await indexNode?.evaluate((node) => node.isConnected)).toBe(true);
      await expectPage(composer).toHaveValue("");
      await page.goBack();
      await expectPage(page.locator(".orb-name")).toHaveText("Frontend Playground");
      await expectPage(composer).toHaveValue("keep this draft while creating");
    } finally {
      releaseCreate();
      releaseHistory();
      releaseList();
      if (createdId !== undefined) await removeFixtureOrb(page, createdId);
      await page.close();
    }
  });

  it("retries creation with the same ID and never overrides a later orb selection", async () => {
    const page = await browser.newPage();
    const attempts: string[] = [];
    let release = () => {};
    let arrived = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requested = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    await page.route("**/api/v1/projects/frontend-scratchpad-project/orbs", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      attempts.push(route.request().postDataJSON().id);
      if (attempts.length === 1) {
        await route.fulfill({
          status: 503,
          json: {
            error: { code: "unavailable", message: "Creation unavailable", retryable: true },
          },
        });
      } else {
        arrived();
        await gate;
        await route.continue();
      }
    });
    try {
      await page.goto(`${origin}/${ORB_HASH}`);
      const index = page.getByRole("navigation", { name: "All project orbs" });
      const composer = page.getByRole("textbox", { name: "Message the orb", exact: true });
      await composer.fill("draft survives failure");
      await index.getByRole("link", { name: "New orb in scratchpad", exact: true }).click();
      await expectPage(index.getByRole("alert")).toContainText("Failed to create orb");
      await expectPage(page).toHaveURL(`${origin}/${ORB_HASH}`);
      await expectPage(composer).toHaveValue("draft survives failure");
      await index.getByRole("button", { name: "retry", exact: true }).click();
      await requested;
      expectPage(attempts).toHaveLength(2);
      expectPage(attempts[1]).toBe(attempts[0]);
      await index.locator('a[href="#/orbs/frontend-offline-sync"]').click();
      await expectPage(page.locator(".orb-name")).toHaveText("Offline sync");
      release();
      await expectPage(index.locator(`a[href="#/orbs/${attempts[0]}"]`)).toBeVisible();
      await expectPage(page).toHaveURL(`${origin}/#/orbs/frontend-offline-sync`);
      await expectPage(index.getByRole("alert")).toHaveCount(0);
      await expectPage(
        index.getByRole("button", { name: "Creating orb in scratchpad", exact: true }),
      ).toHaveCount(0);
    } finally {
      release();
      if (attempts[0] !== undefined) await removeFixtureOrb(page, attempts[0]);
      await page.close();
    }
  });

  it("keeps modified + clicks native without navigating the source workspace", async () => {
    const page = await browser.newPage();
    let popup: typeof page | undefined;
    let createdId: string | undefined;
    try {
      await page.goto(`${origin}/${ORB_HASH}`);
      const index = page.getByRole("navigation", { name: "All project orbs" });
      const node = await index.elementHandle();
      // Native modified-link tabs have no opener: observe the context, not window.open/popups.
      const opened = page.context().waitForEvent("page");
      await index
        .getByRole("link", { name: "New orb in scratchpad", exact: true })
        .click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] });
      popup = await opened;
      await expectPage(popup).toHaveURL(/#\/orbs\/[0-9a-f-]+$/);
      createdId = popup.url().split("/orbs/")[1];
      await expectPage(page).toHaveURL(`${origin}/${ORB_HASH}`);
      expectPage(await node?.evaluate((element) => element.isConnected)).toBe(true);
    } finally {
      if (createdId !== undefined) await removeFixtureOrb(page, createdId);
      await popup?.close();
      await page.close();
    }
  });

  it("keeps the fleet mounted across projects, opens archives, and creates from the title plus", async () => {
    const page = await browser.newPage();
    let release = () => {};
    let createdId: string | undefined;
    try {
      await page.goto(`${origin}/${ORB_HASH}`);
      const index = page.getByRole("navigation", { name: "All project orbs" });
      await expectPage(index.locator(".ix-project")).toHaveCount(4);
      await expectPage(index.locator(".project-new-orb-row")).toHaveCount(0);
      await expectPage(index.getByRole("link", { name: /^New orb in / })).toHaveCount(4);
      const geometry = await index.locator(".project-head-name").evaluateAll((heads) =>
        heads.map((head) => {
          const actions = head.querySelector(".project-head-actions");
          return actions === null
            ? -1
            : head.getBoundingClientRect().right - actions.getBoundingClientRect().right;
        }),
      );
      expectPage(geometry).toEqual([0, 0, 0, 0]);
      const composer = page.getByRole("textbox", { name: "Message the orb", exact: true });
      await composer.fill("original project draft");
      const indexNode = await index.elementHandle();
      const destination = index.locator('a[href="#/orbs/frontend-offline-sync"]');
      const destinationNode = await destination.elementHandle();
      let arrived = () => {};
      const requested = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route("**/api/v1/orbs/frontend-offline-sync/history", async (route) => {
        const response = await route.fetch();
        arrived();
        await gate;
        await route.fulfill({ response });
      });
      await index.evaluate((node) => {
        node.style.maxHeight = "240px";
      });
      await destination.click();
      await requested;
      const scrollTop = await index.evaluate((node) => node.scrollTop);
      await expectPage(destination).toHaveAttribute("aria-current", "page");
      await expectPage(page.locator(".orb-main")).toHaveAttribute("inert", "");
      await expectPage(composer).toHaveValue("original project draft");
      release();
      await expectPage(index).toHaveAttribute("aria-busy", "false");
      await expectPage(page.locator(".orb-name")).toHaveText("Offline sync");
      await expectPage(page).toHaveTitle("fieldnotes · Offline sync");
      expectPage(
        await indexNode?.evaluate(
          (node) => node === node.ownerDocument.querySelector(".orb-index"),
        ),
      ).toBe(true);
      expectPage(await destinationNode?.evaluate((node) => node.isConnected)).toBe(true);
      expectPage(await index.evaluate((node) => node.scrollTop)).toBe(scrollTop);
      await composer.fill("fieldnotes draft");
      await page.goBack();
      await expectPage(composer).toHaveValue("original project draft");
      await destination.click();
      await expectPage(composer).toHaveValue("fieldnotes draft");
      await index.getByRole("button", { name: "Configure homelab", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await expectPage(dialog).toHaveAccessibleName("Config for homelab");
      await dialog.getByRole("button", { name: "Close project config" }).click();
      await index
        .getByRole("region", { name: "Frontend playground", exact: true })
        .locator(".project-archive > summary")
        .click();
      await index.locator('a[href="#/orbs/frontend-archived-orb"]').click();
      await expectPage(page.locator(".orb-name")).toHaveText("Finished design exploration");
      await expectPage(page.locator(".composer")).toHaveCount(0);
      await expectPage(index.locator('[aria-current="page"]')).toHaveAttribute(
        "href",
        "#/orbs/frontend-archived-orb",
      );
      await index.getByRole("link", { name: "New orb in scratchpad", exact: true }).click();
      await expectPage(page).toHaveURL(/#\/orbs\/[0-9a-f-]+$/);
      createdId = page.url().split("/orbs/")[1];
      await expectPage(page.locator(".orb-name")).toHaveText("untitled orb");
      const created = await page.request.get(`${origin}/api/v1/orbs/${createdId}`);
      expectPage((await created.json()).projectId).toBe("frontend-scratchpad-project");
    } finally {
      release();
      if (createdId !== undefined) await removeFixtureOrb(page, createdId);
      await page.close();
    }
  });

  it("retains stale fleet rows, recovers partial failures, and fences old polls after config saves", async () => {
    const page = await browser.newPage();
    await page.clock.install();
    let failOrbs = false;
    let failProjects = false;
    let holdProjects = false;
    let renamed = false;
    let calls = 0;
    let release = () => {};
    let arrived = () => {};
    const requested = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/v1/projects/frontend-fieldnotes-project/orbs", async (route) => {
      if (failOrbs) await route.fulfill({ status: 503, json: {} });
      else await route.continue();
    });
    await page.route("**/api/v1/projects", async (route) => {
      calls += 1;
      if (failProjects) {
        await route.fulfill({ status: 503, json: {} });
        return;
      }
      const response = await route.fetch();
      const body = await response.json();
      if (renamed)
        body.items.find((p: { id: string }) => p.id === "frontend-fieldnotes-project").name =
          "Fieldnotes renamed";
      if (holdProjects) {
        arrived();
        await gate;
      }
      await route.fulfill({ response, json: body });
    });
    await page.route("**/api/v1/projects/frontend-fieldnotes-project", async (route) => {
      if (route.request().method() !== "PATCH") {
        await route.continue();
        return;
      }
      const response = await page.request.get(
        `${origin}/api/v1/projects/frontend-fieldnotes-project`,
      );
      renamed = true;
      await route.fulfill({ json: { ...(await response.json()), name: "Fieldnotes renamed" } });
    });
    try {
      await page.goto(`${origin}/${ORB_HASH}`);
      const index = page.getByRole("navigation", { name: "All project orbs" });
      const destination = index.locator('a[href="#/orbs/frontend-offline-sync"]');
      await expectPage(destination).toBeVisible();
      failOrbs = true;
      await page.clock.runFor(2000);
      await expectPage(index.getByRole("alert")).toContainText("Orb list is stale");
      await expectPage(destination).toBeVisible();
      failOrbs = false;
      await page.clock.runFor(2000);
      await expectPage(index.getByRole("alert")).toHaveCount(0);
      failProjects = true;
      await page.clock.runFor(2000);
      await expectPage(index.getByRole("alert")).toContainText("Project list is stale");
      await expectPage(destination).toBeVisible();
      failProjects = false;
      holdProjects = true;
      await page.clock.runFor(2000);
      await requested;
      const heldCalls = calls;
      await page.clock.runFor(6000);
      expectPage(calls).toBe(heldCalls);
      await index.getByRole("button", { name: "Configure fieldnotes", exact: true }).click();
      const dialog = page.getByRole("dialog");
      const general = dialog.getByRole("tabpanel", { name: "General", exact: true });
      await general.getByLabel("Name", { exact: true }).fill("Fieldnotes renamed");
      await general.getByRole("button", { name: "save", exact: true }).click();
      await expectPage(
        index.getByRole("heading", { name: "Fieldnotes renamed", exact: true }),
      ).toBeVisible();
      const oldResponse = page.waitForResponse("**/api/v1/projects");
      holdProjects = false;
      release();
      await (await oldResponse).finished();
      await page.clock.runFor(32);
      await expectPage(
        index.getByRole("heading", { name: "Fieldnotes renamed", exact: true }),
      ).toBeVisible();
      await page.clock.runFor(2000);
      await expectPage(index.getByRole("alert")).toHaveCount(0);
      await expectPage(
        index.getByRole("heading", { name: "Fieldnotes renamed", exact: true }),
      ).toBeVisible();
      await dialog.getByRole("button", { name: "Close project config" }).click();
    } finally {
      release();
      await page.close();
    }
  });

  it("keeps the index and conversation visible until an orb switch is ready", async () => {
    const page = await browser.newPage();
    await page.goto(`${origin}/${ORB_HASH}`);
    const composer = page.getByRole("textbox", { name: "Message the orb", exact: true });
    await composer.fill("draft for the first orb");
    const index = page.getByRole("navigation", { name: "All project orbs" });
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
    const index = page.getByRole("navigation", { name: "All project orbs" });
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

  it("registers a changed Find source before the changed route is interactive", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/__app-search-registration-order`);
      await page.getByRole("button", { name: "switch route" }).click();
      await expectPage(page.getByRole("dialog", { name: "Find archived" })).toBeVisible();
    } finally {
      await page.close();
    }
  });

  it("opens fleet Find with Cmd-K, leaves Ctrl-K native, and navigates with native links", async () => {
    const page = await browser.newPage();
    let holdDashboardOrbs = false;
    let releaseDashboardOrbs = () => {};
    const dashboardOrbsGate = new Promise<void>((resolve) => {
      releaseDashboardOrbs = resolve;
    });
    await page.route("**/api/v1/projects/frontend-fixture-project/orbs", async (route) => {
      const response = await route.fetch();
      if (holdDashboardOrbs) await dashboardOrbsGate;
      await route.fulfill({ response });
    });
    try {
      await page.goto(`${origin}/${ORB_HASH}`);
      const composer = page.getByRole("textbox", { name: "Message the orb", exact: true });
      await composer.fill("keep this draft");
      await composer.press("Meta+k");
      const dialog = page.getByRole("dialog", { name: "Find projects and orbs" });
      const query = dialog.getByRole("searchbox");
      await expectPage(query).toBeFocused();
      await query.fill("Finished design");
      const archived = dialog.getByRole("link");
      await expectPage(archived).toHaveCount(1);
      await expectPage(archived).toHaveAttribute("href", "#/orbs/frontend-archived-orb");
      await query.press("Escape");
      await expectPage(dialog).toBeHidden();
      await expectPage(composer).toBeFocused();
      await expectPage(composer).toHaveValue("keep this draft");

      await composer.evaluate((element) => {
        const target = element.ownerDocument.defaultView;
        const onKeyDown = (event: { key: string; defaultPrevented: boolean }) => {
          if (event.key.toLowerCase() !== "k") return;
          element.setAttribute("data-ctrl-k-default-prevented", String(event.defaultPrevented));
          target?.removeEventListener("keydown", onKeyDown);
        };
        target?.addEventListener("keydown", onKeyDown);
      });
      await composer.press("Control+k");
      await expectPage(dialog).toBeHidden();
      await expectPage(composer).toBeFocused();
      await expectPage(composer).toHaveAttribute("data-ctrl-k-default-prevented", "false");

      await composer.press("Meta+k");
      await query.fill("Frontend Playground");
      await expectPage(dialog.getByRole("link", { name: /^orb:/ })).toHaveAttribute(
        "href",
        ORB_HASH,
      );
      await query.fill("github.com/example/frontend-playground");
      await expectPage(dialog.getByRole("link")).toHaveAttribute(
        "href",
        "#/projects/frontend-fixture-project",
      );
      holdDashboardOrbs = true;
      await query.press("Enter");
      await expectPage(page).toHaveURL(`${origin}/#/projects/frontend-fixture-project`);
      await expectPage(dialog).toBeHidden();
      await expectPage(page.locator(".dashboard")).toBeVisible();
      await page.keyboard.press("Meta+k");
      await expectPage(query).toHaveValue("");
      await query.fill("Frontend Playground");
      await expectPage(dialog.getByRole("link")).toHaveCount(1);
      await expectPage(dialog.getByRole("link")).toHaveAttribute(
        "href",
        "#/projects/frontend-fixture-project",
      );
      await expectPage(
        dialog.getByText("Searching loaded items · some orbs still loading"),
      ).toBeVisible();
      // With only a project loaded, ArrowDown wraps to that same project; it cannot select
      // an orb that has not arrived. Preserve this schedule instead of relying on fast IO.
      await query.press("ArrowDown");
      await expectPage(dialog.locator("a.active")).toHaveAttribute(
        "href",
        "#/projects/frontend-fixture-project",
      );
      releaseDashboardOrbs();
      await expectPage(dialog.getByRole("link", { name: /^orb:/ })).toHaveAttribute(
        "href",
        ORB_HASH,
      );
      await expectPage(dialog.locator("a.active")).toHaveAttribute(
        "href",
        "#/projects/frontend-fixture-project",
      );
      await query.press("ArrowDown");
      await expectPage(dialog.locator("a.active")).toHaveAttribute("href", ORB_HASH);
      await query.press("Enter");
      await expectPage(page).toHaveURL(`${origin}/${ORB_HASH}`);
      await expectPage(composer).toHaveValue("keep this draft");
      await composer.press("Meta+k");
      await expectPage(query).toHaveValue("");
      await query.fill("Finished design");
      await expectPage(dialog.locator("a.active")).toHaveAttribute(
        "href",
        "#/orbs/frontend-archived-orb",
      );
      await query.press("Enter");
      await expectPage(page).toHaveURL(`${origin}/#/orbs/frontend-archived-orb`);
      await expectPage(dialog).toBeHidden();
      const archivedMain = page.getByRole("main");
      await expectPage(
        archivedMain.getByText("Finished design exploration", { exact: true }),
      ).toBeVisible();
      await expectPage(archivedMain.getByText("archived", { exact: true })).toBeVisible();
      await expectPage(page.locator(".orb-index")).toHaveAttribute("aria-busy", "false");
      await page.keyboard.press("Meta+k");
      await expectPage(query).toHaveValue("");
    } finally {
      releaseDashboardOrbs();
      await page.close();
    }
  });

  it("reports incomplete orb-view Find results while lists load or fail", async () => {
    const page = await browser.newPage();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/v1/projects/frontend-fixture-project/orbs", async (route) => {
      await gate;
      await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
    });
    try {
      await page.goto(`${origin}/${ORB_HASH}`);
      await page.getByRole("textbox", { name: "Message the orb", exact: true }).press("Meta+k");
      const dialog = page.getByRole("dialog", { name: "Find projects and orbs" });
      await dialog.getByRole("searchbox").fill("Finished design");
      await expectPage(
        dialog.getByText("Searching loaded items · some orbs still loading"),
      ).toBeVisible();
      release();
      await expectPage(dialog.getByText(/Some orbs could not be searched/)).toBeVisible();
      await expectPage(dialog.getByRole("searchbox")).toHaveValue("Finished design");
      await dialog.getByRole("searchbox").fill("github.com/example/frontend-playground");
      await expectPage(dialog.getByRole("link")).toHaveAttribute(
        "href",
        "#/projects/frontend-fixture-project",
      );
    } finally {
      release();
      await page.close();
    }
  });

  it("inserts orb URLs at typed @ and preserves cancelled mentions and shell input", async () => {
    const page = await browser.newPage();
    await page.goto(`${origin}/${ORB_HASH}`);
    const composer = page.getByRole("textbox", { name: "Message the orb", exact: true });
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
    const shell = page.getByRole("textbox", { name: "Run a shell command", exact: true });
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

  it("keeps full-cell composer and terminal carets aligned during native editing", async () => {
    const page = await browser.newPage({ reducedMotion: "reduce" });
    await page.goto(`${origin}/${ORB_HASH}`);
    const composer = page.getByRole("textbox", { name: "Message the orb", exact: true });
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

    await page.getByRole("button", { name: "Open terminal", exact: true }).click();
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
    const composer = page.getByRole("textbox", { name: "Message the orb", exact: true });
    const historyAlerts = page.locator(".history").getByRole("alert");
    await expectPage(historyAlerts).toHaveCount(3);
    await composer.fill(draft);

    await page.getByRole("button", { name: "expire session" }).click();
    const ribbon = page.locator(".session-ribbon");
    await expectPage(ribbon).toContainText("session expired");
    await expectPage(composer).toHaveValue(draft);

    const loaded = page.waitForEvent("load");
    await ribbon.getByRole("button", { name: "sign in again" }).click();
    await loaded;

    await expectPage(page).toHaveURL(`${origin}/${ORB_HASH}`);
    await expectPage(page.locator(".session-ribbon")).toHaveCount(0);
    await expectPage(historyAlerts).toHaveCount(3);
    await expectPage(page.getByText("frontend fixture · session active")).toBeVisible();
    await expectPage(
      page.getByRole("textbox", { name: "Message the orb", exact: true }),
    ).toHaveValue(draft);

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
    await expectPage(
      page.getByRole("textbox", { name: "Message the orb", exact: true }),
    ).toHaveCount(0);

    await page.goto(`${origin}/#/orbs/missing-hosted-files-orb`);
    await expectPage(page).toHaveURL(`${origin}/#/orbs/missing-hosted-files-orb`);
    await expectPage(page.getByRole("heading", { name: "Orb doesn't exist" })).toBeVisible();
    await page.close();
  });
});
