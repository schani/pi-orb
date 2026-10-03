import { join } from "node:path";
import { projectDisplayRecord } from "@pi-orb/protocol";
import { expect as check, chromium, webkit } from "@playwright/test";
import { createServer } from "vite";
import { it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";

it.each(["chromium", "webkit"] as const)(
  "%s: inbox deltas preserve delivered handoff, retire tracking and surface errors",
  async (engine) => {
    const root = join(import.meta.dirname, "../apps/web");
    const vite = await createServer({
      root,
      configFile: join(root, "vite.config.ts"),
      mode: "frontend",
      server: { host: "127.0.0.1", port: 0 },
    });
    await listenFrontend(vite);
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("No inbox fixture port");
    const browser = await (engine === "chromium" ? chromium : webkit).launch();
    const page = await browser.newPage();
    const orb = "frontend-long-history";
    const id = "00000000-0000-4000-8000-000000000042";
    const row = {
      id,
      orbId: orb,
      content: [
        { type: "text", text: "INBOX_DELTA_PROMPT" },
        { type: "image", mediaType: "image/png", data: "A".repeat(2_320_000) },
      ],
      status: "queued",
      createdAt: "2026-10-03T00:00:00.000Z",
      updatedAt: "2026-10-03T00:00:00.000Z",
    };
    let delivered = false,
      fail = false,
      repairStarted = false;
    const deltas: { tracked: string; bytes: number }[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await page.route(`**/api/v1/orbs/${orb}`, async (route) => {
        const response = await route.fetch();
        await route.fulfill({
          response,
          json: { ...(await response.json()), state: "stopped", activity: "idle" },
        });
      });
      await page.route(`**/api/v1/orbs/${orb}/history`, async (route) => {
        const response = await route.fetch();
        const view = await response.json();
        if (delivered) {
          repairStarted = true;
          await gate;
          view.records.push(
            projectDisplayRecord({
              id: "inbox-native",
              parentId: view.cursor,
              timestamp: row.createdAt,
              type: "message",
              role: "user",
              content: [{ type: "text", text: "INBOX_DELTA_PROMPT" }],
              inboxMessageIds: [id],
              overflow: {},
            }),
          );
          view.cursor = "inbox-native";
          view.headId = "inbox-native";
        }
        await route.fulfill({ response, json: view });
      });
      await page.route(`**/api/v1/orbs/${orb}/messages/poll`, async (route) => {
        const query = route.request().postDataJSON() as { after: number; tracked: string[] };
        if (fail)
          return route.fulfill({
            status: 503,
            json: {
              error: { code: "unavailable", message: "inbox fixture outage", retryable: true },
            },
          });
        const { content: _content, ...update } = row;
        const body =
          query.after === 0
            ? { items: [row], updates: [], cursor: 1 }
            : {
                items: [],
                updates:
                  query.tracked.length > 0
                    ? [
                        {
                          ...update,
                          status: delivered ? "delivered" : "queued",
                          delivery: delivered ? "steer" : "turn",
                          operationId: "late-operation",
                        },
                      ]
                    : [],
                cursor: 1,
              };
        if (query.after !== 0)
          deltas.push({ tracked: query.tracked.join(","), bytes: JSON.stringify(body).length });
        await route.fulfill({ json: body });
      });
      await page.goto(`http://127.0.0.1:${address.port}/orbs/${orb}`);
      await check(page.locator(".history")).toContainText("Review 100");
      await check(page.locator(".rec-q")).toContainText("INBOX_DELTA_PROMPT");
      delivered = true;
      await check.poll(() => repairStarted).toBe(true);
      await check(page.locator(".rec-q .rec-status")).toHaveText("steering");
      release();
      await check(page.locator(".rec-q")).toHaveCount(0);
      await check(page.locator(".history")).toContainText("INBOX_DELTA_PROMPT");
      await check.poll(() => deltas.some((delta) => delta.tracked === "")).toBe(true);
      check(deltas.every((delta) => delta.bytes < 1000)).toBe(true);
      fail = true;
      await check(page.getByText("inbox unavailable:", { exact: false })).toBeVisible();
      fail = false;
      await check(page.getByText("inbox unavailable:", { exact: false })).toHaveCount(0);
    } finally {
      release();
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
      await browser.close();
      await vite.close();
    }
  },
);
