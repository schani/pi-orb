import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DisplayRecord, OrbMessageView } from "@pi-orb/protocol";
import { type Browser, expect as check, chromium, type Page, webkit } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";
import { gotoFrontendHistory } from "./testkit/frontend-fixture.ts";

const evidence = join(
  import.meta.dirname,
  "../.context/cross-orb/ui",
  new Date().toISOString().replaceAll(":", "-"),
);
mkdirSync(evidence, { recursive: true });

async function observe(page: Page, label: string) {
  const events: string[] = [];
  page.on("pageerror", (error) => events.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") events.push(`console: ${message.text()}`);
  });
  page.on("response", (response) => {
    if (response.url().includes("/api/"))
      events.push(`${response.status()} ${response.request().method()} ${response.url()}`);
  });
  await page.context().tracing.start({ screenshots: true, snapshots: true });
  return {
    screenshot: (stage: string) =>
      page.screenshot({ path: join(evidence, `${label}-${stage}.png`), fullPage: true }),
    async finish() {
      writeFileSync(join(evidence, `${label}.log`), events.join("\n"));
      await page.context().tracing.stop({ path: join(evidence, `${label}.zip`) });
      await page.close();
    },
  };
}

const orbId = "frontend-fixture-orb";
const senderId = "629e53de-a2c9-4f1b-87a6-437fd415e8de";
const timestamp = "2026-10-14T00:00:00Z";
const body =
  '<script>globalThis.__peerInjected=true</script>\n<img src=x onerror="bad()"> & "quotes"\n**literal**\n' +
  "snapshot-".repeat(90);
const message: OrbMessageView = {
  id: "peer-inbox",
  orbId,
  status: "queued",
  content: [{ type: "text", text: body }],
  system: { kind: "orb_message", senderOrbId: senderId },
  createdAt: timestamp,
  updatedAt: timestamp,
};
const peer: DisplayRecord = {
  id: "peer-record",
  parentId: "human",
  timestamp,
  type: "event",
  eventType: "orb.message",
  content: [{ type: "text", text: body }],
  sender: { orbId: senderId },
  inboxMessageIds: [message.id],
};
const human: DisplayRecord = {
  id: "human",
  parentId: null,
  timestamp,
  type: "message",
  role: "user",
  content: [{ type: "text", text: "Check the layout." }],
};
const reply: DisplayRecord = {
  id: "reply",
  parentId: peer.id,
  timestamp,
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "The receiving reply." }],
};

describe.each(["chromium", "webkit"] as const)("orb correspondence · %s", (engine) => {
  let vite: ViteDevServer;
  let browser: Browser;
  let origin: string;
  beforeAll(async () => {
    const root = join(import.meta.dirname, "../apps/web");
    vite = await createServer({
      root,
      configFile: join(root, "vite.config.ts"),
      cacheDir: join(evidence, `vite-${engine}`, "node_modules/.vite"),
      mode: "frontend",
      server: { host: "127.0.0.1", port: 0 },
    });
    await listenFrontend(vite);
    await vite.environments["client"]?.warmupRequest("/src/main.tsx");
    await vite.waitForRequestsIdle();
    const address = vite.httpServer?.address();
    if (address == null || typeof address === "string") throw new Error("No fixture port");
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

  it.each([320, 390, 1280])(
    "renders literal correspondence without overflow at %ipx",
    async (width) => {
      const page = await browser.newPage({ viewport: { width, height: 844 } });
      const capture = await observe(page, `${engine}-${width}`);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      try {
        await page.route(`**/api/v1/orbs/${orbId}`, async (route) => {
          const response = await route.fetch();
          await route.fulfill({ response, json: { ...(await response.json()), state: "stopped" } });
        });
        await page.route("**/api/v1/projects/frontend-fixture-project/orbs", async (route) => {
          const response = await route.fetch();
          const view = await response.json();
          await route.fulfill({
            response,
            json: {
              ...view,
              items: [
                ...view.items,
                { ...view.items[0], id: senderId, name: "sender-".repeat(80) },
              ],
            },
          });
        });
        await page.route(`**/api/v1/orbs/${orbId}/history`, (route) =>
          route.fulfill({
            json: {
              orbId,
              session: { id: "session" },
              cursor: reply.id,
              headId: reply.id,
              records: [human, peer, reply],
            },
          }),
        );
        await gotoFrontendHistory(
          page,
          `${origin}/orbs/${orbId}`,
          orbId,
          page.locator(".rec-peer"),
        );
        const band = page.locator(".rec-peer");
        await check(band.locator(".peer-sender")).toHaveText("sender-".repeat(80));
        await check(band.locator(".peer-sender")).toHaveAttribute("href", `/orbs/${senderId}`);
        await check(band.locator(".peer-body")).toHaveText(body);
        await check(band.locator("script, img, strong, details")).toHaveCount(0);
        await page.evaluate(() => Reflect.get(globalThis, "document").fonts.ready);
        check(
          await band.evaluate((element) => {
            const view = element.ownerDocument.defaultView;
            if (view === null) return null;
            const style = view.getComputedStyle(element);
            const bodyElement = element.querySelector(".peer-body");
            const sender = element.querySelector(".peer-sender");
            if (bodyElement === null || sender === null) return null;
            const rect = element.getBoundingClientRect();
            return {
              background: style.backgroundColor,
              color: style.color,
              whiteSpace: view.getComputedStyle(bodyElement).whiteSpace,
              wrap: view.getComputedStyle(bodyElement).overflowWrap,
              fits:
                element.scrollWidth <= element.clientWidth &&
                bodyElement.scrollWidth <= bodyElement.clientWidth &&
                sender.getBoundingClientRect().right <= rect.right &&
                rect.left >= 0 &&
                rect.right <= view.innerWidth &&
                element.ownerDocument.documentElement.scrollWidth <= view.innerWidth,
              injected: Reflect.get(globalThis, "__peerInjected") === true,
            };
          }),
        ).toEqual({
          background: "rgb(242, 242, 242)",
          color: "rgb(0, 0, 0)",
          whiteSpace: "pre-wrap",
          wrap: "anywhere",
          fits: true,
          injected: false,
        });
        check(
          await page
            .locator('[data-history-row="human"]')
            .evaluate(
              (element) =>
                element.ownerDocument.defaultView?.getComputedStyle(element).backgroundColor,
            ),
        ).toBe("rgb(0, 0, 0)");
        check(
          await page
            .locator(".rec-orb")
            .evaluate(
              (element) =>
                element.ownerDocument.defaultView?.getComputedStyle(element.ownerDocument.body)
                  .backgroundColor,
            ),
        ).toBe("rgb(255, 255, 255)");
        check(errors).toEqual([]);
        await capture.screenshot("correspondence");
      } catch (cause) {
        await capture.screenshot("failure");
        throw cause;
      } finally {
        await capture.finish();
      }
    },
  );

  it.each([320, 390])(
    "retains provenance through blocked/failure/delivered handoff and reload; refreshes names and links missing sender at %ipx",
    async (width) => {
      const page = await browser.newPage({ viewport: { width, height: 844 } });
      const capture = await observe(page, `${engine}-handoff-${width}`);
      let row = message;
      let senderName: string | null = "runtime handshake";
      let committed = false;
      let failPoll = false;
      let sawFailedPoll!: () => void;
      const failedPoll = new Promise<void>((resolve) => {
        sawFailedPoll = resolve;
      });
      try {
        await page.route(`**/api/v1/orbs/${orbId}`, async (route) => {
          const response = await route.fetch();
          await route.fulfill({
            response,
            json: { ...(await response.json()), state: "failed", lastError: "Fixture blocked" },
          });
        });
        await page.route("**/api/v1/projects/frontend-fixture-project/orbs", async (route) => {
          const response = await route.fetch();
          const view = await response.json();
          await route.fulfill({
            response,
            json: {
              ...view,
              items:
                senderName === null
                  ? view.items
                  : [...view.items, { ...view.items[0], id: senderId, name: senderName }],
            },
          });
        });
        await page.route(`**/api/v1/orbs/${orbId}/history`, (route) =>
          route.fulfill({
            json: {
              orbId,
              session: { id: "session" },
              cursor: committed ? peer.id : human.id,
              headId: committed ? peer.id : human.id,
              records: committed ? [human, peer] : [human],
            },
          }),
        );
        await page.route(`**/api/v1/orbs/${orbId}/messages/poll`, async (route) => {
          if (failPoll) {
            await route.fulfill({
              status: 503,
              json: { error: { code: "unavailable", message: "Fixture offline", retryable: true } },
            });
            sawFailedPoll();
            return;
          }
          const request = route.request().postDataJSON();
          const { content: _content, system: _system, ...update } = row;
          await route.fulfill({
            json:
              request.after === 0
                ? { cursor: 1, items: [row], updates: [] }
                : {
                    cursor: 1,
                    items: [],
                    updates: request.tracked.includes(row.id) ? [update] : [],
                  },
          });
        });
        await gotoFrontendHistory(
          page,
          `${origin}/orbs/${orbId}`,
          orbId,
          page.locator(".rec-peer"),
        );
        const band = page.locator(".rec-peer");
        await check(band.locator(".rec-status")).toHaveText("blocked");
        await check(band.locator(".peer-sender")).toHaveText("runtime handshake");
        await capture.screenshot("blocked");
        failPoll = true;
        await failedPoll;
        await check(band.locator(".peer-body")).toHaveText(body);
        await check(band.locator(".rec-status")).toHaveText("blocked");
        failPoll = false;
        const failure = `Delivery rejected <${"token".repeat(120)}>`;
        row = { ...row, status: "failed", error: failure };
        await check(band.locator(".rec-status")).toHaveText("failed");
        await check(band.locator(".error-text")).toHaveText(failure);
        check(
          await band.evaluate(
            (element) =>
              element.scrollWidth <= element.clientWidth &&
              element.ownerDocument.documentElement.scrollWidth <=
                (element.ownerDocument.defaultView?.innerWidth ?? 0),
          ),
        ).toBe(true);
        await check(band.locator(".peer-sender")).toHaveText("runtime handshake");
        await capture.screenshot("failed");
        senderName = "renamed sender";
        await check(band.locator(".peer-sender")).toHaveText(senderName);
        row = { ...message, status: "delivered" };
        await check(band.locator(".rec-status")).toHaveText("delivered");
        await capture.screenshot("delivered");
        committed = true;
        await check(band.locator(".rec-status")).toHaveCount(0);
        await check(band).toHaveCount(1);
        await check(band.locator(".peer-body")).toHaveText(body);
        await capture.screenshot("committed");
        await page.reload();
        await check(band).toHaveCount(1);
        await check(band.locator(".rec-status")).toHaveCount(0);
        await check(band.locator(".peer-sender")).toHaveText(senderName);
        senderName = null;
        await check(band.locator(".peer-sender")).toHaveText(senderId);
        await check(band.locator(".peer-sender")).toHaveAttribute("href", `/orbs/${senderId}`);
        await capture.screenshot("fallback");
        await band.locator(".peer-sender").focus();
        await page.keyboard.press("Enter");
        await check(page).toHaveURL(`${origin}/orbs/${senderId}`);
        await check(
          page.getByRole("heading", { name: "Orb doesn't exist", exact: true }),
        ).toBeVisible();
        await check(
          page.getByRole("link", { name: "Back to dashboard", exact: true }),
        ).toBeVisible();
        await capture.screenshot("missing-sender");
      } catch (cause) {
        await capture.screenshot("failure");
        throw cause;
      } finally {
        await capture.finish();
      }
    },
  );
});
