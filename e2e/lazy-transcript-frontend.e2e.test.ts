import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium, expect, webkit } from "@playwright/test";
import { createServer } from "vite";
import { it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";
import { gotoFrontendHistory } from "./testkit/frontend-fixture.ts";

const ORB = "frontend-lazy-details";
const hidden = [
  "LAZY_NATIVE_SECRET",
  "LAZY_ARGUMENT_SECRET",
  "LAZY_RESULT_SECRET",
  "LAZY_REASONING_SECRET",
];

it.each(["chromium", "webkit"] as const)(
  "%s: projected summaries group without reads; individual detail retries and caches",
  async (engine) => {
    const root = join(import.meta.dirname, "../apps/web");
    const cacheDir = await mkdtemp(join(tmpdir(), `pi-orb-lazy-${engine}-`));
    const vite = await createServer({
      root,
      configFile: join(root, "vite.config.ts"),
      cacheDir,
      mode: "frontend",
      server: { host: "127.0.0.1", port: 0 },
    });
    let browser: Browser | undefined;
    try {
      await listenFrontend(vite);
      const address = vite.httpServer?.address();
      if (!address || typeof address === "string") throw new Error("No fixture port");
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
      const page = await browser.newPage({
        viewport: { width: 1280, height: 900 },
      });
      const origin = `http://127.0.0.1:${address.port}`;
      const details: string[] = [];
      const imageUrls: string[] = [];
      const leaks: string[] = [];
      const frames: string[] = [];
      let syncs = 0;
      let historyBytes = 0;
      let historyCalls = 0;
      let selectedDetailPath = "";
      let heldDetailPath = "";
      let heldReads = 0;
      let signalHeld!: () => void;
      let releaseHeld!: () => void;
      const heldRequested = new Promise<void>((resolve) => {
        signalHeld = resolve;
      });
      const heldGate = new Promise<void>((resolve) => {
        releaseHeld = resolve;
      });
      let sessionId = "";
      let failNextDetail = true;
      page.on("websocket", (socket) => {
        if (!socket.url().endsWith(`/orbs/${ORB}/live`)) return;
        socket.on("framereceived", ({ payload }) => {
          if (typeof payload === "string") {
            frames.push(payload);
            if (JSON.parse(payload).type === "sync.completed") syncs++;
          }
        });
      });
      await page.route(`**/api/v1/orbs/${ORB}/history`, async (route) => {
        const response = await route.fetch();
        const body = await response.text();
        historyBytes = Buffer.byteLength(body);
        historyCalls++;
        for (const marker of hidden) if (body.includes(marker)) leaks.push(`history: ${marker}`);
        const view = JSON.parse(body) as {
          session: { id: string };
          records: {
            id: string;
            content?: {
              type: string;
              headline?: string;
              detailKey?: string;
              callId?: string;
            }[];
          }[];
        };
        sessionId = view.session.id;
        const calls = view.records.flatMap((record) =>
          (record.content ?? []).filter((block) => block.type === "tool_call"),
        );
        const firstResultRecord = view.records.find((record) =>
          record.content?.some(
            (block) => block.type === "tool_result" && block.callId === calls[0]?.callId,
          ),
        );
        const firstResult = firstResultRecord?.content?.find(
          (block) => block.type === "tool_result" && block.callId === calls[0]?.callId,
        );
        if (firstResultRecord && firstResult?.detailKey)
          selectedDetailPath = `/api/v1/orbs/${ORB}/details/${encodeURIComponent(firstResultRecord.id)}/${encodeURIComponent(firstResult.detailKey)}`;
        const secondResultRecord = view.records.find((record) =>
          record.content?.some(
            (block) => block.type === "tool_result" && block.callId === calls[1]?.callId,
          ),
        );
        const secondResult = secondResultRecord?.content?.find(
          (block) => block.type === "tool_result" && block.callId === calls[1]?.callId,
        );
        if (secondResultRecord && secondResult?.detailKey)
          heldDetailPath = `/api/v1/orbs/${ORB}/details/${encodeURIComponent(secondResultRecord.id)}/${encodeURIComponent(secondResult.detailKey)}`;
        expect(calls).toHaveLength(30);
        for (const call of calls) {
          expect(Buffer.byteLength(call.headline ?? "")).toBeLessThanOrEqual(1024);
        }
        await route.fulfill({ response, body });
      });
      page.on("request", (request) => {
        const path = new URL(request.url()).pathname;
        if (path.startsWith(`/api/v1/orbs/${ORB}/images/`)) imageUrls.push(path);
      });
      await page.route(`**/api/v1/orbs/${ORB}/details/**`, async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === heldDetailPath) {
          heldReads++;
          const response = await route.fetch();
          signalHeld();
          await heldGate;
          return route.fulfill({ response });
        }
        if (url.pathname !== selectedDetailPath) return route.continue();
        expect(url.searchParams.get("sessionId")).toBe(sessionId);
        details.push(url.pathname);
        if (failNextDetail) {
          failNextDetail = false;
          return route.fulfill({
            status: 503,
            json: {
              error: {
                code: "unavailable",
                message: "detail temporarily unavailable",
                retryable: true,
              },
            },
          });
        }
        return route.continue();
      });
      try {
        await gotoFrontendHistory(page, `${origin}/#/orbs/${ORB}`, ORB);
        await expect.poll(() => syncs).toBeGreaterThanOrEqual(1);
        const history = page.locator(".history");
        const read = history.locator("details.tool-activity-category").filter({
          has: page.locator(":scope > summary", { hasText: "read" }),
        });
        await expect(read).toHaveCount(1);
        expect(details).toHaveLength(0);
        await read.locator(":scope > summary").click();
        const callSummaries = read
          .locator("details.tool-activity-call")
          .filter({ has: page.locator("summary code") });
        await expect(callSummaries).toHaveCount(30);
        const headers = await callSummaries.locator("summary code").evaluateAll((codes) =>
          codes.map((code) => ({
            text: code.textContent ?? "",
            title: code.getAttribute("title"),
          })),
        );
        for (const header of headers) {
          expect(header.title).toBe(header.text);
          expect(Buffer.byteLength(header.text)).toBeLessThanOrEqual(1024);
        }
        expect(details).toHaveLength(0);
        const first = callSummaries.first();
        await first.locator(":scope > summary").click();
        await expect(page.getByText("detail temporarily unavailable")).toBeVisible();
        expect(details).toHaveLength(1);
        await page.getByRole("button", { name: "Retry", exact: true }).click();
        await expect(first.locator(".tool-call-output")).toContainText("LAZY_RESULT_SECRET");
        expect(details).toHaveLength(2);
        await first.locator(":scope > summary").click();
        await first.locator(":scope > summary").click();
        await expect(first.locator(".tool-call-output")).toContainText("LAZY_RESULT_SECRET");
        expect(details).toHaveLength(2);
        const second = callSummaries.nth(1);
        await second.locator(":scope > summary").click();
        await heldRequested;
        await second.locator(":scope > summary").click();
        await second.locator(":scope > summary").click();
        expect(heldReads, "close/reopen shares an in-flight committed read").toBe(1);
        releaseHeld();
        await expect(second.locator(".tool-call-output")).toContainText(
          "LAZY_RESULT_SECRET output 1",
        );
        expect(heldReads).toBe(1);
        // A cache return preserves the immutable detail without a second transfer.
        await page.locator(`.orb-index a[href="#/orbs/frontend-fixture-orb"]`).click();
        await expect(page.locator(".orb-name")).toHaveText("Frontend Playground");
        const previousReads = historyCalls;
        const previousSyncs = syncs;
        await page.locator(`.orb-index a[href="#/orbs/${ORB}"]`).click();
        await expect.poll(() => syncs).toBeGreaterThan(previousSyncs);
        await expect(read).toHaveCount(1);
        expect(historyCalls).toBe(previousReads);
        expect(leaks).toEqual([]);
        for (const frame of frames)
          for (const marker of hidden)
            expect(frame, `WebSocket leaked ${marker}`).not.toContain(marker);
        expect(historyBytes).toBeGreaterThan(0);
        await expect(history.locator("img.msg-image")).toBeVisible();
        expect(imageUrls.length).toBeGreaterThan(0);
        for (const path of imageUrls) expect(path).toMatch(/\/images\/[^/]+\/[^/]+\/\d+$/);
      } finally {
        releaseHeld();
        await page.close();
      }
    } finally {
      await browser?.close();
      await vite.close();
      await rm(cacheDir, { recursive: true, force: true });
    }
  },
);
