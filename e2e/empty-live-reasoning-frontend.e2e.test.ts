import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HistoryRecord, OutputPatchEvent } from "@pi-orb/protocol";
import { type Browser, chromium, expect, webkit } from "@playwright/test";
import { createServer } from "vite";
import { it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";
import { gotoFrontendHistory } from "./testkit/frontend-fixture.ts";
import { projectFixtureHistory } from "./testkit/projected-history.ts";

const ORB = "frontend-fixture-orb";
const OPERATION = "empty-reasoning-operation";
const AT = "2026-10-06T00:00:00Z";
const PRIVATE_TEXT = "Plain reasoning without any heading.";
const FINAL_TEXT = "Final reasoning without any heading.";
const BLOCKS = ["encrypted-only", "whitespace-only", "headingless", "redacted"] as const;
const committed = {
  id: "reasoning-commit",
  parentId: null,
  type: "message",
  role: "assistant",
  timestamp: AT,
  content: [
    { type: "reasoning", text: "", overflow: { encrypted_content: "opaque-fixture-data" } },
    { type: "reasoning", text: " \n\t " },
    { type: "reasoning", text: FINAL_TEXT },
    { type: "reasoning", text: "", redacted: true },
    { type: "text", text: "Reasoning committed." },
  ],
  overflow: {},
} satisfies HistoryRecord;

function reasoning(blockId: "headingless" | "redacted"): OutputPatchEvent {
  return {
    type: "output_patch",
    operationId: OPERATION,
    blockId,
    blockType: "reasoning",
    revision: 1,
    headline: "",
    patch: { type: "replace", text: "" },
  };
}

it.each(["chromium", "webkit"] as const)(
  "%s: published reasoning stays visible through replay and explicit sparse disclosure handoff",
  async (engine) => {
    const root = join(import.meta.dirname, "../apps/web");
    const cacheDir = await mkdtemp(join(tmpdir(), `pi-orb-empty-reasoning-${engine}-`));
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
      const page = await browser.newPage();
      const origin = `http://127.0.0.1:${address.port}`;
      let syncs = 0;
      let send: (frame: object) => void = () => {};
      const emit = (event: object) => send({ type: "runtime.event", event });
      const detailRequests: string[] = [];
      const frames: string[] = [];
      const replayed: string[] = [];
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      page.on("request", (request) => {
        const path = decodeURIComponent(new URL(request.url()).pathname);
        if (path.includes(`/orbs/${ORB}/details/`)) detailRequests.push(path);
      });
      const projected = await projectFixtureHistory(page, ORB, [committed]);
      await page.route(`**/api/v1/orbs/${ORB}/history`, async (route) => {
        const response = await route.fetch();
        await route.fulfill({
          json: { ...(await response.json()), records: [], cursor: null, headId: null },
        });
      });
      await page.route(`**/api/v1/orbs/${ORB}/messages/poll`, (route) =>
        route.fulfill({ json: { items: [], updates: [], cursor: 0 } }),
      );
      await page.route(`**/api/v1/orbs/${ORB}/details/live/**`, (route) => {
        const url = new URL(route.request().url());
        const blockId = url.pathname.split("/").at(-1);
        expect(url.searchParams.get("sessionId")).toBe(`fixture-session-${ORB}`);
        expect(blockId).toBe("headingless");
        return route.fulfill({
          json: {
            v: 1,
            sessionId: `fixture-session-${ORB}`,
            operationId: OPERATION,
            blockId,
            state: "running",
            body: { type: "reasoning", text: PRIVATE_TEXT },
          },
        });
      });
      const progress = (text: string, revision: number) =>
        emit({
          type: "output_patch",
          operationId: OPERATION,
          blockId: "visible-progress",
          blockType: "text",
          revision,
          patch: { type: "replace", text },
        } satisfies OutputPatchEvent);
      await page.routeWebSocket(`**/api/v1/orbs/${ORB}/live`, (socket) => {
        send = (frame) => {
          const payload = JSON.stringify({ v: 1, at: AT, ...frame });
          frames.push(payload);
          socket.send(payload);
        };
        socket.onMessage((message) => {
          const hello = JSON.parse(message.toString());
          if (hello.type !== "client.hello") return;
          send({
            type: "server.welcome",
            connectionId: `empty-reasoning-${syncs}`,
            runtimeInstanceId: "empty-reasoning-runtime",
            orbId: ORB,
            sessionId: `fixture-session-${ORB}`,
            capabilities: [],
            limits: { maxIncomingFrameBytes: 1_000_000, maxPromptBytes: 1_000_000 },
          });
          send({ type: "sync.started", mode: "after", afterRecordId: null });
          emit({ type: "operation_started", operationId: OPERATION });
          if (syncs > 0) {
            const beforeReplay = frames.length;
            emit(reasoning("redacted"));
            emit(reasoning("headingless"));
            progress("Reconnect replay processed.", 2);
            replayed.push(...frames.slice(beforeReplay));
          }
          send({ type: "sync.completed", headId: null });
          syncs++;
        });
      });
      try {
        await gotoFrontendHistory(page, `${origin}/orbs/${ORB}`, ORB);
        await expect.poll(() => syncs).toBe(1);
        const history = page.locator(".history");
        const rows = page.locator("details.activity-rail-row.reasoning");
        progress("Initial visible text is preserved.", 1);
        await expect(history).toContainText("Initial visible text is preserved.");
        await expect(rows).toHaveCount(0);
        expect(detailRequests).toEqual([]);

        // Publication order differs from canonical order; ordinal pairing is wrong.
        emit(reasoning("redacted"));
        emit(reasoning("headingless"));
        await expect(rows).toHaveCount(2);
        await expect(rows.locator("summary .activity-rail-label")).toHaveText([
          "thinking",
          "thinking",
        ]);
        await expect(rows.locator("summary .activity-rail-headline")).toHaveCount(0);
        expect(detailRequests, "collapsed headingless and redacted rows must not fetch").toEqual(
          [],
        );
        await rows.last().locator(":scope > summary").click();
        await expect(rows.last().locator(".reasoning-body")).toHaveText(PRIVATE_TEXT);
        await expect(rows.first()).not.toHaveAttribute("open", "");

        // Connectivity events replace the transport without a retry-timer race.
        await page.evaluate(() =>
          Reflect.get(globalThis, "dispatchEvent").call(globalThis, new Event("offline")),
        );
        await page.evaluate(() =>
          Reflect.get(globalThis, "dispatchEvent").call(globalThis, new Event("online")),
        );
        await expect.poll(() => syncs).toBe(2);
        await expect(history).toContainText("Reconnect replay processed.");
        await expect(rows).toHaveCount(2);
        await expect(rows.last()).toHaveAttribute("open", "");
        await expect(rows.last().locator(".reasoning-body")).toHaveText(PRIVATE_TEXT);
        await expect(rows.first()).not.toHaveAttribute("open", "");
        expect(replayed.map((payload) => JSON.parse(payload).event.blockId)).toEqual([
          "redacted",
          "headingless",
          "visible-progress",
        ]);

        emit({
          type: "output_patch",
          operationId: OPERATION,
          blockId: "next-message",
          blockType: "text",
          revision: 1,
          patch: { type: "replace", text: "Next message survives retirement." },
        } satisfies OutputPatchEvent);
        await expect(history).toContainText("Next message survives retirement.");
        send({
          type: "history.record",
          headId: committed.id,
          record: projected[0],
          retiredBlockIds: [...BLOCKS, "visible-progress"],
          detailAliases: [
            { blockId: "redacted", detailKey: `${committed.id}:3` },
            { blockId: "headingless", detailKey: `${committed.id}:2` },
          ],
        });
        await expect(history).toContainText("Reasoning committed.");
        await expect(history).not.toContainText("Reconnect replay processed.");
        await expect(history).toContainText("Next message survives retirement.");
        await expect(rows).toHaveCount(2);
        await expect(rows.first()).toHaveAttribute("open", "");
        await expect(rows.first().locator(".reasoning-body")).toHaveText(FINAL_TEXT);
        await expect(rows.last()).not.toHaveAttribute("open", "");
        const committedPath = `/api/v1/orbs/${ORB}/details/${committed.id}/${committed.id}`;
        expect(detailRequests).toContain(`${committedPath}:2`);
        expect(detailRequests).not.toContain(`${committedPath}:3`);
        expect(detailRequests).not.toContain(`${committedPath}:0`);
        expect(detailRequests).not.toContain(`${committedPath}:1`);
        await rows.last().locator(":scope > summary").click();
        await expect(rows.last()).toHaveAttribute("open", "");
        await expect.poll(() => detailRequests.includes(`${committedPath}:3`)).toBe(true);
        emit({ type: "operation_finished", operationId: OPERATION, outcome: "completed" });
        await expect(
          history.getByRole("status", { name: "Agent working", exact: true }),
        ).toHaveCount(0);
        await expect(rows).toHaveCount(2);
        await expect(rows.first().locator(".reasoning-body")).toHaveText(FINAL_TEXT);
        const patches = frames
          .map((payload) => JSON.parse(payload))
          .filter((frame) => frame.type === "runtime.event" && frame.event.type === "output_patch")
          .map((frame) => frame.event);
        expect(patches.filter((patch) => patch.blockType === "reasoning")).toEqual([
          reasoning("redacted"),
          reasoning("headingless"),
          reasoning("redacted"),
          reasoning("headingless"),
        ]);
        expect(patches.some((patch) => BLOCKS.slice(0, 2).includes(patch.blockId))).toBe(false);
        expect(patches.every((patch) => !("contentIndex" in patch))).toBe(true);
        expect(patches.every((patch) => !("reasoningVisible" in patch))).toBe(true);
        expect(pageErrors).toEqual([]);
        expect(frames.join("\n")).not.toContain(PRIVATE_TEXT);
        expect(frames.join("\n")).not.toContain(FINAL_TEXT);
        expect(frames.join("\n")).not.toContain("opaque-fixture-data");
      } catch (error) {
        const evidence = join(
          import.meta.dirname,
          `../.context/empty-live-reasoning/simplification/${engine}-first-failure`,
        );
        if (!existsSync(evidence)) {
          await mkdir(evidence, { recursive: true });
          await Promise.all([
            writeFile(join(evidence, "error.txt"), String(error)),
            writeFile(join(evidence, "frames.json"), JSON.stringify(frames, null, 2)),
            writeFile(
              join(evidence, "detail-requests.json"),
              JSON.stringify(detailRequests, null, 2),
            ),
            writeFile(join(evidence, "page-errors.json"), JSON.stringify(pageErrors, null, 2)),
            writeFile(join(evidence, "page.html"), await page.content()),
            page.screenshot({ path: join(evidence, "page.png"), fullPage: true }),
          ]);
        }
        throw error;
      } finally {
        await page.close();
      }
    } finally {
      await browser?.close();
      await vite.close();
      await rm(cacheDir, { recursive: true, force: true });
    }
  },
);
