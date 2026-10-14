import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DisplayHistoryView, DisplayRecord, OrbView } from "@pi-orb/protocol";
import { type Browser, expect as check, chromium, webkit } from "@playwright/test";
import { createServer } from "vite";
import { it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";
import { closeRoutedPage } from "./testkit/close-routed-page.ts";
import { gotoFrontendHistory } from "./testkit/frontend-fixture.ts";

const runId = randomUUID();
const root = join(import.meta.dirname, "../apps/web");
const evidence = join(import.meta.dirname, "../.context/cross-orb/reduction/browser", runId);
mkdirSync(evidence, { recursive: true });
const orbId = "frontend-fixture-orb";
const senderId = "629e53de-a2c9-4f1b-87a6-437fd415e8de";
const senderName = "sender-".repeat(80);
const body =
  '<script>globalThis.__peerInjected=true</script>\n<img src=x onerror="bad()"> & "quotes"\n**literal**\n' +
  "snapshot-".repeat(90);
const peer: DisplayRecord = {
  id: "peer-record",
  parentId: null,
  timestamp: "2026-10-14T00:00:00Z",
  type: "event",
  eventType: "orb.message",
  content: [{ type: "text", text: body }],
  sender: { orbId: senderId },
  inboxMessageIds: ["peer-inbox"],
};

it.each(["chromium", "webkit"] as const)("%s: correspondence at 320px", async (engine) => {
  const cacheDir = join(root, "node_modules/.vite/correspondence", runId, engine);
  let browser: Browser | undefined;
  const vite = await createServer({
    root,
    configFile: join(root, "vite.config.ts"),
    cacheDir,
    mode: "frontend",
    server: { host: "127.0.0.1", port: 0 },
  });
  try {
    await listenFrontend(vite);
    await vite.environments["client"]?.warmupRequest("/src/main.tsx");
    await vite.waitForRequestsIdle();
    const address = vite.httpServer?.address();
    if (address == null || typeof address === "string") throw new Error("No fixture port");
    const origin = `http://127.0.0.1:${address.port}`;
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

    const page = await browser.newPage({ viewport: { width: 320, height: 844 } });
    const events: string[] = [];
    const errors: string[] = [];
    let senderPresent = true;
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") events.push(`console: ${message.text()}`);
    });
    page.on("response", (response) => {
      if (response.url().includes("/api/"))
        events.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    });
    await page.context().tracing.start({ screenshots: true, snapshots: true });
    try {
      await page.route(`**/api/v1/orbs/${orbId}`, async (route) => {
        const response = await route.fetch();
        const view: OrbView = await response.json();
        await route.fulfill({ response, json: { ...view, state: "stopped" } satisfies OrbView });
      });
      await page.route("**/api/v1/projects/frontend-fixture-project/orbs", async (route) => {
        const response = await route.fetch();
        const view: { items: OrbView[] } = await response.json();
        const template = view.items.find((orb) => orb.id === orbId);
        if (template === undefined) throw new Error("Missing fixture orb");
        await route.fulfill({
          response,
          json: {
            ...view,
            items: senderPresent
              ? [...view.items, { ...template, id: senderId, name: senderName }]
              : view.items,
          },
        });
      });
      await page.route(`**/api/v1/orbs/${orbId}/history`, (route) =>
        route.fulfill({
          json: {
            orbId,
            session: { id: "session" },
            cursor: peer.id,
            headId: peer.id,
            records: [peer],
          } satisfies DisplayHistoryView,
        }),
      );
      const band = page.locator(".rec-peer");
      const url = `${origin}/orbs/${orbId}`;
      await gotoFrontendHistory(page, url, orbId, band);
      await check(band).toHaveCount(1);
      await check(band.locator(".peer-sender")).toHaveText(senderName);
      await check(band.locator(".peer-sender")).toHaveAttribute("href", `/orbs/${senderId}`);
      await check.poll(() => band.locator(".peer-body").textContent()).toBe(body);
      await check(band.locator("script, img, strong, details")).toHaveCount(0);
      await check(band).toHaveCSS("background-color", "rgb(242, 242, 242)");
      await page.evaluate(() => Reflect.get(globalThis, "document").fonts.ready);
      check(
        await band.evaluate((element) => {
          const view = element.ownerDocument.defaultView;
          if (view === null) return false;
          const rect = element.getBoundingClientRect();
          const parts = [element, ...element.querySelectorAll(".peer-body, .peer-heading")];
          return (
            parts.every((part) => part.scrollWidth <= part.clientWidth) &&
            rect.left >= 0 &&
            rect.right <= view.innerWidth &&
            element.ownerDocument.documentElement.scrollWidth <= view.innerWidth &&
            Reflect.get(globalThis, "__peerInjected") !== true
          );
        }),
      ).toBe(true);
      senderPresent = false;
      await gotoFrontendHistory(page, url, orbId, band);
      await check(band.locator(".peer-sender")).toHaveText(senderId);
      await check(band.locator(".peer-sender")).toHaveAttribute("href", `/orbs/${senderId}`);
      await band.locator(".peer-sender").click();
      await check(page).toHaveURL(`${origin}/orbs/${senderId}`);
      await check(page.getByRole("heading")).toHaveText("Orb doesn't exist");
      await check(page.getByRole("link", { name: "Back to dashboard" })).toBeVisible();
      check(errors).toEqual([]);
    } catch (cause) {
      writeFileSync(join(evidence, `${engine}-failure.txt`), String(cause));
      await page.screenshot({ path: join(evidence, `${engine}-failure.png`), fullPage: true });
      throw cause;
    } finally {
      try {
        writeFileSync(join(evidence, `${engine}.log`), [...events, ...errors].join("\n"));
        await page.context().tracing.stop({ path: join(evidence, `${engine}.zip`) });
      } finally {
        await closeRoutedPage(page);
      }
    }
  } finally {
    await browser?.close();
    await vite.close();
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
