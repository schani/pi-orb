import { join } from "node:path";
import { type HistoryRecord, type OrbMessageView, projectDisplayRecord } from "@pi-orb/protocol";
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
    await expectPage(strips).toHaveCount(3);
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
    await expectPage(picked).toHaveCount(1);
    await expectPage(picked).toBeHidden();
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

    const restarts = strips.nth(2);
    const restartDots = restarts.locator(".activity-strip-dot");
    expect(
      await restartDots.evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("data-step")?.[0]),
      ),
    ).toEqual([..."tstsrtssrtrtssrrts"]);
    // The glyph occupies the success dot's 6px box at the same center as every dot.
    expect(
      await restarts.evaluate((element) => {
        const boxes = [...element.querySelectorAll(".activity-strip-dot")].map((dot) => {
          const button = dot.getBoundingClientRect();
          const glyph = dot.querySelector("svg")?.getBoundingClientRect();
          const before = dot.ownerDocument.defaultView?.getComputedStyle(dot, "::before");
          return {
            width: glyph?.width ?? Number.parseFloat(before?.width ?? ""),
            height: glyph?.height ?? Number.parseFloat(before?.height ?? ""),
            dx:
              glyph === undefined ? 0 : Math.round(glyph.left + glyph.width / 2 - button.left - 6),
            dy:
              glyph === undefined ? 0 : Math.round(glyph.top + glyph.height / 2 - button.top - 10),
          };
        });
        return [...new Set(boxes.map((box) => JSON.stringify(box)))];
      }),
    ).toEqual([
      JSON.stringify({ width: 3, height: 3, dx: 0, dy: 0 }),
      JSON.stringify({ width: 6, height: 6, dx: 0, dy: 0 }),
    ]);
    const restart = restarts.locator('[data-step="restart"]').first();
    await restart.hover();
    await expectPage(page.getByRole("tooltip")).toHaveText("restart · sleep finished");
    await expectPage(page.locator(".activity-strip-tip-label")).toHaveCSS(
      "color",
      "rgb(150, 97, 0)",
    );
    await expectPage(restart.locator(".activity-strip-glyph")).toHaveCSS(
      "color",
      "rgb(150, 97, 0)",
    );
    await restart.click();
    await expectPage(restarts.locator(".activity-strip-body > .record-custom")).toContainText(
      "Scheduled sleep finished.",
    );
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
      // The history arrives before the inbox; the six dots include both sources.
      const dots = strip.locator(".activity-strip-dot");
      await expectPage(dots).toHaveCount(6);
      expect(
        await dots.evaluateAll((nodes) => nodes.map((dot) => dot.getAttribute("data-step"))),
      ).toEqual(["success", "notification", "success", "notification", "failed", "notification"]);
      await expectPage(strip.locator(".peer-notice")).toHaveCount(0);
      const dot = dots.nth(1);
      await dot.hover();
      await expectPage(page.getByRole("tooltip")).toContainText(`notification · ${sender}`);
      await dot.click();
      const body = strip.locator(":scope > .activity-strip-body");
      const receipt = body.locator(".peer-notice").filter({ hasNot: page.locator(".rec-status") });
      await expectPage(receipt).toHaveAttribute("open", "");
      await expectPage(receipt.locator(".peer-body")).toHaveText(literal);
      await expectPage(receipt.locator(".peer-sender")).toHaveAttribute("href", `/orbs/${sender}`);
      await expectPage(receipt.locator("script, img, strong")).toHaveCount(0);
      await dot.click();
      await strip.locator(":scope > summary .activity-rail-label").click();
      await expectPage(body.locator(":scope > .activity-rail-row")).toHaveCount(6);
      await expectPage(receipt).toHaveAttribute("open", "");
      await receipt.locator(":scope > summary .activity-rail-label").click();
      await expectPage(receipt).not.toHaveAttribute("open", "");
      await receipt.locator(":scope > summary .activity-rail-label").click();
      await expectPage(receipt.locator(".peer-body")).toBeVisible();

      const pending = body.locator(".peer-notice").filter({ has: page.locator(".rec-status") });
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

it.each(["arrival", "receipt", "collapsed receipt"] as const)(
  "preserves peer disclosure when a strip changes on %s",
  async (transition) => {
    const arrival = transition === "arrival";
    const collapsed = transition === "collapsed receipt";
    const page = await browser.newPage();
    const orb = "frontend-long-history";
    const at = "2026-11-06T00:00:00.000Z";
    const senderOrbId = "629e53de-a2c9-4f1b-87a6-437fd415e8de";
    const message = (id: string, text: string) =>
      ({
        id,
        orbId: orb,
        status: "queued",
        createdAt: at,
        updatedAt: at,
        system: { kind: "orb_message", senderOrbId },
        content: [{ type: "text", text }],
      }) satisfies OrbMessageView;
    const selected = message("peer-selected", "Selected peer body");
    const sibling = message("peer-sibling", "Sibling peer body");
    const delivered = collapsed ? sibling : selected;
    const failed = {
      id: "failed-inbox",
      orbId: orb,
      status: "failed",
      createdAt: at,
      updatedAt: at,
      content: [{ type: "text", text: "Failed inbox boundary" }],
    } satisfies OrbMessageView;
    const receipt = (id: string, parentId: string | null, text: string, inboxId: string) =>
      projectDisplayRecord({
        id,
        parentId,
        timestamp: at,
        overflow: {},
        type: "event",
        eventType: "orb.message",
        sender: { orbId: senderOrbId },
        content: [{ type: "text", text }],
        inboxMessageIds: [inboxId],
      });
    const initialHistory = arrival
      ? []
      : [
          receipt("earlier-a", null, "Earlier peer A", "peer-a"),
          receipt("earlier-b", "earlier-a", "Earlier peer B", "peer-b"),
        ];
    let advance = false;
    try {
      await page.route(`**/api/v1/orbs/${orb}`, async (route) => {
        const response = await route.fetch();
        await route.fulfill({
          response,
          json: { ...(await response.json()), state: "stopped", activity: "idle" },
        });
      });
      await page.route(`**/api/v1/orbs/${orb}/history`, (route) => {
        const records =
          advance && !arrival
            ? [
                ...initialHistory,
                receipt("canonical", "earlier-b", "Committed peer body", delivered.id),
              ]
            : initialHistory;
        const headId = records.at(-1)?.id ?? null;
        return route.fulfill({
          json: { orbId: orb, session: null, cursor: headId, headId, records },
        });
      });
      await page.route(`**/api/v1/orbs/${orb}/messages/poll`, (route) => {
        const { after } = route.request().postDataJSON() as { after: number };
        return route.fulfill({
          json: {
            cursor: advance && arrival ? 2 : 1,
            items:
              after === 0
                ? arrival
                  ? [selected]
                  : [failed, selected, sibling]
                : advance && arrival && after === 1
                  ? [sibling]
                  : [],
            updates:
              advance && !arrival
                ? [
                    {
                      id: delivered.id,
                      orbId: orb,
                      status: "delivered",
                      createdAt: at,
                      updatedAt: at,
                    },
                  ]
                : [],
          },
        });
      });

      await gotoFrontendHistory(page, `${origin}/orbs/${orb}`, orb);
      const strips = page.locator(".activity-strip");
      const body = page.locator(".peer-body").filter({ hasText: "Selected peer body" });
      if (arrival) {
        await expectPage(strips).toHaveCount(0);
        await page.locator(".peer-notice > summary .activity-rail-label").click();
      } else {
        await expectPage(page.locator(".rec-q")).toContainText("Failed inbox boundary");
        await expectPage(strips).toHaveCount(2);
        await strips.last().locator(".activity-strip-dot").first().click();
      }
      await expectPage(body).toBeVisible();
      if (collapsed) {
        await strips.last().locator(":scope > summary .activity-rail-label").click();
        await expectPage(body).toBeHidden();
      }
      advance = true;

      await expectPage(strips).toHaveCount(1);
      const dotCount = arrival ? 2 : 3;
      await expectPage(strips.locator(".activity-strip-dot")).toHaveCount(dotCount);
      if (collapsed) {
        await expectPage(page.locator(".peer-notice").filter({ has: body })).not.toHaveAttribute(
          "open",
          "",
        );
        return;
      }
      await expectPage(
        strips.locator(".peer-body").filter({
          hasText: arrival ? "Selected peer body" : "Committed peer body",
        }),
      ).toBeVisible();
      await expectPage(
        strips.locator(".peer-body").filter({
          hasText: arrival ? "Sibling peer body" : "Earlier peer A",
        }),
      ).toBeHidden();
    } finally {
      await page.close();
    }
  },
);

it("renders the peer activity demo prompt as a user turn", async () => {
  const page = await browser.newPage();
  try {
    const orb = "frontend-peer-activity";
    await gotoFrontendHistory(page, `${origin}/orbs/${orb}`, orb);
    await expectPage(page.locator('.rec-you[data-history-row="peer-activity-ask"]')).toContainText(
      "Check the weekly token usage report before publishing.",
    );
  } finally {
    await page.close();
  }
});
