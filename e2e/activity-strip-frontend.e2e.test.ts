import { join } from "node:path";
import type { HistoryRecord } from "@pi-orb/protocol";
import { type Browser, chromium, expect as expectPage } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";
import { gotoFrontendHistory } from "./testkit/frontend-fixture.ts";
import { projectFixtureHistory } from "./testkit/projected-history.ts";

const root = join(import.meta.dirname, "../apps/web");
let vite: ViteDevServer;
let browser: Browser;
let origin: string;

beforeAll(async () => {
  vite = await createServer({
    root,
    configFile: join(root, "vite.config.ts"),
    mode: "frontend",
  });
  await listenFrontend(vite);
  const address = vite.httpServer?.address();
  if (address === null || address === undefined || typeof address === "string") {
    throw new Error("frontend fixture did not own a TCP port");
  }
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await vite?.close();
});

it("folds interleaved activity into dots that preview, open and overflow", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await gotoFrontendHistory(page, `${origin}/orbs/frontend-activity`, "frontend-activity");
    const strips = page.locator(".activity-strip");
    await expectPage(strips).toHaveCount(2);
    const first = strips.first();
    const dots = first.locator(".activity-strip-dot");
    await expectPage(dots).toHaveCount(35);
    await expectPage(first.locator(".activity-rail-metric")).toHaveText("35");
    await expectPage(page.locator(".rec-orb .reasoning")).toHaveCount(0);

    const failed = first.locator('[data-step="failed"]');
    await expectPage(failed).toHaveCount(1);
    const box = await failed.boundingBox();
    expect(box?.width).toBe(12);
    expect(box?.height).toBe(20);

    await failed.hover();
    await expectPage(page.getByRole("tooltip")).toContainText("codemode · text(await tools.bash");
    await failed.click();
    const body = first.locator(":scope > .activity-strip-body");
    const picked = body.locator(":scope > .activity-rail-row-failed");
    await expectPage(first).toHaveAttribute("open", "");
    await expectPage(body.locator(":scope > .activity-rail-row")).toHaveCount(1);
    await expectPage(picked).toHaveAttribute("open", "");
    await expectPage(picked.locator(".tool-call-output-error")).toBeVisible();
    await failed.click();
    await expectPage(picked).toHaveCount(0);
    await expectPage(first).not.toHaveAttribute("open", "");

    await first.locator(":scope > summary .activity-rail-label").click();
    await expectPage(first).toHaveAttribute("open", "");
    await expectPage(page.locator(".rec-orb .reasoning")).toHaveCount(20);

    const overflow = strips.nth(1);
    await expectPage(overflow.locator(".activity-rail-metric")).toHaveText("300");
    const more = Number((await overflow.locator(".activity-strip-more").textContent())?.slice(1));
    const shown = await overflow.locator(".activity-strip-dot").count();
    expect(more + shown).toBe(300);
    expect(more).toBeGreaterThan(0);
  } finally {
    await page.close();
  }
});

it.each([1280, 320])(
  "folds orb messages with tools and preserves pending failures at %ipx",
  async (width) => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const orb = "frontend-long-history";
    const sender = "629e53de-a2c9-4f1b-87a6-437fd415e8de";
    const namedSender = "729e53de-a2c9-4f1b-87a6-437fd415e8de";
    const longName = "Long sender ".repeat(30);
    const diagnostic = "Rejected <token> " + "diagnostic-".repeat(90);
    const literal =
      '<script>globalThis.__peerInjected = true</script>\n<img src=x onerror="bad()"> **literal** & ' +
      "snapshot-".repeat(90);
    const base = { parentId: null, timestamp: "2026-11-06T00:00:00.000Z", overflow: {} };
    const call = (id: string): HistoryRecord => ({
      ...base,
      id,
      type: "message",
      role: "assistant",
      content: [{ type: "tool_call", callId: id, name: "bash", arguments: { command: "pwd" } }],
    });
    const result = (id: string): HistoryRecord => ({
      ...base,
      id: `${id}-result`,
      type: "message",
      role: "tool",
      content: [{ type: "tool_result", callId: id, content: [{ type: "text", text: "/repo" }] }],
    });
    const records: HistoryRecord[] = [
      call("before"),
      result("before"),
      {
        ...base,
        id: "peer",
        type: "event",
        eventType: "orb.message",
        sender: { orbId: sender },
        content: [{ type: "text", text: literal }],
        inboxMessageIds: ["consumed"],
      },
      call("after"),
      result("after"),
    ];
    try {
      await page.route("**/api/v1/projects/*/orbs", async (route) => {
        const response = await route.fetch();
        const view = await response.json();
        await route.fulfill({
          response,
          json: {
            ...view,
            items: [...view.items, { ...view.items[0], id: namedSender, name: longName }],
          },
        });
      });
      const projected = await projectFixtureHistory(
        page,
        orb,
        records.map((record, index) => ({ ...record, parentId: records[index - 1]?.id ?? null })),
      );
      await page.route(`**/api/v1/orbs/${orb}`, async (route) => {
        const response = await route.fetch();
        await route.fulfill({
          response,
          json: { ...(await response.json()), state: "stopped", activity: "idle" },
        });
      });
      await page.route(`**/api/v1/orbs/${orb}/history`, (route) =>
        route.fulfill({
          json: {
            orbId: orb,
            session: null,
            cursor: "after-result",
            headId: "after-result",
            records: projected,
          },
        }),
      );
      await page.route(`**/api/v1/orbs/${orb}/messages/poll`, (route) =>
        route.fulfill({
          json: {
            cursor: 1,
            updates: [],
            items: ["consumed", "queued", "failed", "named"].map((id) => ({
              id,
              orbId: orb,
              status: id === "failed" ? "failed" : "queued",
              system: { kind: "orb_message", senderOrbId: id === "named" ? namedSender : sender },
              content: [{ type: "text", text: id === "consumed" ? literal : `${id} message` }],
              ...(id === "failed" ? { error: diagnostic } : {}),
              createdAt: base.timestamp,
              updatedAt: base.timestamp,
            })),
          },
        }),
      );
      await gotoFrontendHistory(page, `${origin}/orbs/${orb}`, orb);
      const strip = page.locator(".activity-strip");
      await expectPage(strip).toHaveCount(1);
      await expectPage(strip.locator(".activity-strip-dot")).toHaveCount(3);
      expect(
        await strip
          .locator(".activity-strip-dot")
          .evaluateAll((dots) => dots.map((dot) => dot.getAttribute("data-step"))),
      ).toEqual(["success", "notification", "success"]);
      await expectPage(strip.locator(".peer-notice")).toHaveCount(0);
      const dot = strip.locator('[data-step="notification"]');
      await dot.hover();
      await expectPage(page.getByRole("tooltip")).toContainText(`notification · ${sender}`);
      await dot.click();
      const notice = strip.locator(".peer-notice");
      await expectPage(notice).toHaveAttribute("open", "");
      await expectPage(notice.locator(".peer-body")).toHaveText(literal);
      await expectPage(notice.locator(".peer-sender")).toHaveAttribute("href", `/orbs/${sender}`);
      await expectPage(notice.locator("script, img, strong")).toHaveCount(0);
      await dot.click();
      await strip.locator(":scope > summary .activity-rail-label").click();
      await expectPage(strip.locator(".activity-strip-body > .activity-rail-row")).toHaveCount(3);
      await expectPage(notice).toHaveAttribute("open", "");
      await notice.locator(":scope > summary .activity-rail-label").click();
      await expectPage(notice).not.toHaveAttribute("open", "");
      await notice.locator(":scope > summary .activity-rail-label").click();
      await expectPage(notice.locator(".peer-body")).toBeVisible();

      const pending = page.locator(".peer-notice").filter({ has: page.locator(".rec-status") });
      await expectPage(pending).toHaveCount(3);
      await expectPage(pending.nth(0).locator(".rec-status")).toHaveText("paused");
      await expectPage(pending.nth(1).locator(".rec-status")).toHaveText("failed");
      await expectPage(pending.nth(1)).toHaveClass(/activity-rail-row-failed/);
      await expectPage(pending.nth(1).locator(".activity-rail-label")).toHaveCSS(
        "color",
        "rgb(180, 35, 24)",
      );
      await expectPage(pending.nth(1).locator("summary")).toContainText(diagnostic);
      await expectPage(pending.nth(2).locator(".peer-sender")).toHaveText(longName);
      for (const [index, row] of (await pending.all()).entries()) {
        await expectPage(row.locator(".activity-rail-label")).toHaveText("notification");
        await expectPage(row.locator(".peer-sender")).toHaveAttribute(
          "href",
          `/orbs/${index === 2 ? namedSender : sender}`,
        );
        expect(
          await row.evaluate((element) => {
            const label = element.querySelector(".activity-rail-label");
            const summary = label?.parentElement;
            const metric = element.querySelector(".activity-rail-metric");
            if (!label || !summary || !metric) return false;
            return (
              label.getBoundingClientRect().width <= summary.clientWidth &&
              summary.getBoundingClientRect().right <= metric.getBoundingClientRect().left &&
              metric.scrollWidth <= metric.clientWidth
            );
          }),
        ).toBe(true);
        await row.locator(":scope > summary .activity-rail-label").click();
        await expectPage(row.locator(".peer-body")).toBeVisible();
      }
      await expectPage(pending.nth(1).locator("summary")).not.toContainText(diagnostic);
      const error = pending.nth(1).locator(".error-text");
      await expectPage(error).toBeVisible();
      await expectPage(error).toHaveText(diagnostic);
      expect(
        await error.evaluate(
          (element) =>
            element.scrollWidth <= element.clientWidth &&
            element.getBoundingClientRect().height > 20,
        ),
      ).toBe(true);
      expect(
        await page.locator("html").evaluate((element) => ({
          injected: Reflect.get(globalThis, "__peerInjected") === true,
          overflow: element.scrollWidth > (element.ownerDocument.defaultView?.innerWidth ?? 0),
        })),
      ).toEqual({ injected: false, overflow: false });
    } finally {
      await page.close();
    }
  },
);
