import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HistoryRecord } from "@pi-orb/protocol";
import { type Browser, chromium, expect as expectPage, type Page, webkit } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";
import { gotoFrontendHistory } from "./testkit/frontend-fixture.ts";
import { projectFixtureHistory } from "./testkit/projected-history.ts";

const WEB_ROOT = join(import.meta.dirname, "../apps/web");
const ORB_ID = "frontend-fixture-orb";

function imageActivity(page: Page, text: string) {
  return page.locator("details.tool-image-activity").filter({ hasText: text });
}

async function seedUnavailableImages(page: Page, origin: string): Promise<void> {
  await page.route(`**/api/v1/orbs/${ORB_ID}/history`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const timestamp = new Date().toISOString();
    const parentId = body.headId;
    const records = [
      {
        id: "fixture-unavailable-image-calls",
        parentId,
        timestamp,
        type: "message",
        role: "assistant",
        content: [
          {
            type: "tool_call",
            callId: "fixture-missing-source",
            name: "missing_source",
            arguments: {},
          },
          {
            type: "tool_call",
            callId: "fixture-broken-source",
            name: "broken_source",
            arguments: {},
          },
        ],
        overflow: {},
      },
      {
        id: "fixture-missing-source-result",
        parentId: "fixture-unavailable-image-calls",
        timestamp,
        type: "message",
        role: "tool",
        content: [
          {
            type: "tool_result",
            callId: "fixture-missing-source",
            content: [{ type: "image", mediaType: "image/png" }],
          },
        ],
        overflow: {},
      },
      {
        id: "fixture-broken-source-result",
        parentId: "fixture-missing-source-result",
        timestamp,
        type: "message",
        role: "tool",
        content: [
          {
            type: "tool_result",
            callId: "fixture-broken-source",
            content: [
              {
                type: "image",
                mediaType: "image/png",
                url: `${origin}/fixture-broken-image.png`,
              },
            ],
          },
        ],
        overflow: {},
      },
    ];
    body.records.push(...(await projectFixtureHistory(page, ORB_ID, records as HistoryRecord[])));
    body.headId = records.at(-1)?.id;
    body.cursor = body.headId;
    await route.fulfill({ response, json: body });
  });
}

describe.each(["chromium", "webkit"] as const)("tool-returned image previews · %s", (engine) => {
  let vite: ViteDevServer;
  let browser: Browser;
  let cacheDir: string;
  let origin: string;
  let url: string;

  beforeAll(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), `pi-orb-tool-images-${engine}-`));
    vite = await createServer({
      root: WEB_ROOT,
      configFile: join(WEB_ROOT, "vite.config.ts"),
      cacheDir,
      mode: "frontend",
      server: { host: "127.0.0.1", port: 0 },
    });
    await listenFrontend(vite);
    const address = vite.httpServer?.address();
    if (address === null || address === undefined || typeof address === "string") {
      throw new Error("tool image E2E Vite server did not own a TCP port");
    }
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
    origin = `http://127.0.0.1:${address.port}`;
    url = `${origin}/orbs/${ORB_ID}`;
  });

  afterAll(async () => {
    await browser?.close();
    await vite?.close();
    if (cacheDir !== undefined) await rm(cacheDir, { force: true, recursive: true });
  });

  it("keeps matched read, generic, ordered, and failed images inside open drawers", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await gotoFrontendHistory(page, url, ORB_ID);
      const read = imageActivity(page, "artifacts/dashboard-preview.svg");
      const generic = imageActivity(page, "browser_snapshot");
      const failed = imageActivity(page, "visual_diff");
      const textOnly = page
        .locator("details.tool-activity-category:not(.tool-image-activity)")
        .first();

      await expectPage(read).toHaveCount(1);
      await expectPage(generic).toHaveCount(1);
      await expectPage(failed).toHaveCount(1);
      await expectPage(read).toHaveAttribute("open", "");
      await expectPage(generic).toHaveAttribute("open", "");
      await expectPage(failed).toHaveAttribute("open", "");
      await expectPage(textOnly).not.toHaveAttribute("open", "");
      await expectPage(
        read.getByRole("img", { name: "Image returned by read", exact: true }),
      ).toBeVisible();
      await expectPage(
        generic.getByRole("img", { name: "Image returned by browser_snapshot", exact: true }),
      ).toHaveCount(3);
      await expectPage(
        failed.getByRole("img", { name: "Image returned by visual_diff", exact: true }),
      ).toBeVisible();
      await expectPage(failed).toHaveClass(/activity-rail-row-failed/);

      const provenance = await page
        .getByRole("button", { name: /^Enlarge image returned by / })
        .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")));
      expectPage(provenance).toEqual([
        "Enlarge image returned by read",
        "Enlarge image returned by browser_snapshot",
        "Enlarge image returned by browser_snapshot",
        "Enlarge image returned by browser_snapshot",
        "Enlarge image returned by visual_diff",
      ]);
      const expectedDimensions = [
        { width: 960, height: 540 },
        { width: 420, height: 720 },
        { width: 800, height: 420 },
      ];
      await expectPage
        .poll(() =>
          generic.locator(".tool-image-trigger img").evaluateAll((images) =>
            images.map((image) => ({
              width: Reflect.get(image, "naturalWidth"),
              height: Reflect.get(image, "naturalHeight"),
            })),
          ),
        )
        .toEqual(expectedDimensions);
    } finally {
      await page.close();
    }
  });

  it("closing an image drawer hides its previews and output, and reopening restores both", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await gotoFrontendHistory(page, url, ORB_ID);
      const read = imageActivity(page, "artifacts/dashboard-preview.svg");
      const image = read.getByRole("img", { name: "Image returned by read", exact: true });
      const output = read.getByText("Dashboard preview (960 × 540)", { exact: true });
      const previews = read.locator(".tool-image-preview");
      await expectPage(image).toHaveCount(1);
      await expectPage(previews).toHaveCount(1);
      await expectPage(output).toBeVisible();

      await read.locator(":scope > summary").click();
      await expectPage(read).not.toHaveAttribute("open", "");
      await expectPage(image).toBeHidden();
      await expectPage(output).toBeHidden();

      await read.locator(":scope > summary").click();
      await expectPage(read).toHaveAttribute("open", "");
      await expectPage(image).toBeVisible();
      await expectPage(output).toBeVisible();
      await expectPage(image).toHaveCount(1);
      await expectPage(previews).toHaveCount(1);
    } finally {
      await page.close();
    }
  });

  it("preserves an image drawer collapse across an unrelated metadata poll", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.clock.install();
    // Own collapse/poll semantics, not unrelated media admission or tail scrolling.
    await page.addInitScript(`(() => {
      const events = [];
      Reflect.set(globalThis, "__imageCollapseEvents", events);
      for (const type of ["pointerdown", "pointerup", "click", "toggle"])
        document.addEventListener(
          type,
          (event) => {
            if (!(event.target instanceof Element)) return;
            const drawer = event.target.closest("details.tool-image-activity");
            if (drawer instanceof HTMLDetailsElement) events.push({ type, open: drawer.open });
          },
          true,
        );
    })();`);
    const timestamp = "2026-10-08T12:00:00.000Z";
    const records: HistoryRecord[] = [
      {
        id: "image-collapse-root",
        parentId: null,
        timestamp,
        type: "message",
        role: "user",
        content: [{ type: "text", text: "Image collapse." }],
        overflow: {},
      },
      {
        id: "image-collapse-call",
        parentId: "image-collapse-root",
        timestamp,
        type: "message",
        role: "assistant",
        content: [
          {
            type: "tool_call",
            callId: "image-collapse",
            name: "read",
            arguments: { path: "artifacts/dashboard-preview.svg" },
          },
        ],
        overflow: {},
      },
      {
        id: "image-collapse-result",
        parentId: "image-collapse-call",
        timestamp,
        type: "message",
        role: "tool",
        content: [
          {
            type: "tool_result",
            callId: "image-collapse",
            content: [
              { type: "text", text: "Dashboard preview (960 × 540)" },
              {
                type: "image",
                mediaType: "image/png",
                data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=",
              },
            ],
          },
        ],
        overflow: {},
      },
    ];
    const projected = await projectFixtureHistory(page, ORB_ID, records);
    await page.route(`**/api/v1/orbs/${ORB_ID}/history`, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.records = projected;
      body.headId = records.at(-1)?.id;
      body.cursor = body.headId;
      await route.fulfill({ response, json: body });
    });
    let releaseImage!: () => void;
    const imageGate = new Promise<void>((resolve) => {
      releaseImage = resolve;
    });
    const imageRequested = page.waitForRequest((request) =>
      new URL(request.url()).pathname.includes(`/orbs/${ORB_ID}/images/`),
    );
    await page.route(`**/api/v1/orbs/${ORB_ID}/images/**`, async (route) => {
      await imageGate;
      await route.fallback();
    });
    let releasePoll!: () => void;
    const pollGate = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    let refreshed = false;
    let markPollRequested!: () => void;
    const pollRequested = new Promise<void>((resolve) => {
      markPollRequested = resolve;
    });
    await page.route(`**/api/v1/orbs/${ORB_ID}`, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.state = "stopped";
      if (refreshed) {
        markPollRequested();
        await pollGate;
        body.name = "Image drawer poll";
      }
      await route.fulfill({ response, json: body });
    });
    try {
      await gotoFrontendHistory(page, url, ORB_ID);
      const read = imageActivity(page, "artifacts/dashboard-preview.svg");
      const image = read.getByRole("img", { name: "Image returned by read", exact: true });
      await expectPage(page.locator(".orb-name")).toBeVisible();
      await imageRequested;
      await expectPage(image).toHaveCount(0);
      releaseImage();
      await expectPage(image).toBeVisible();
      await expectPage
        .poll(() =>
          image.evaluate(
            (element) =>
              Reflect.get(element, "complete") && Reflect.get(element, "naturalWidth") > 0,
          ),
        )
        .toBe(true);
      await expectPage(
        read.getByText("Dashboard preview (960 × 540)", { exact: true }),
      ).toBeVisible();
      await page.evaluate(() => Reflect.get(globalThis, "document").fonts.ready);
      expectPage(
        await page.locator(".orb-transcript-scroll").evaluate((element) => ({
          overflow: element.scrollHeight > element.clientHeight,
          scrollTop: element.scrollTop,
        })),
      ).toEqual({ overflow: false, scrollTop: 0 });
      const drawer = await read.elementHandle();
      await read.locator(":scope > summary").click();
      await expectPage(read).not.toHaveAttribute("open", "");
      await expectPage(image).toBeHidden();

      refreshed = true;
      await page.clock.runFor(2100);
      await pollRequested;
      await expectPage(read).not.toHaveAttribute("open", "");
      releasePoll();
      await expectPage(page.locator(".orb-name")).toHaveText("Image drawer poll");
      expectPage(await read.evaluate((element, previous) => element === previous, drawer)).toBe(
        true,
      );
      await expectPage(read).not.toHaveAttribute("open", "");
      await expectPage(image).toBeHidden();
    } catch (error) {
      const evidence = await page
        .evaluate(`({
          events: Reflect.get(globalThis, "__imageCollapseEvents"),
          drawers: [...document.querySelectorAll("details.tool-image-activity")].map(element => ({
            open: element.hasAttribute("open"), connected: element.isConnected,
          })),
        })`)
        .catch(() => ({ unavailable: true }));
      await mkdir("test-failures", { recursive: true });
      await writeFile(
        `test-failures/image-collapse-${engine}-${Date.now()}.json`,
        JSON.stringify({ replayable: false, engine, refreshed, evidence }, null, 2),
      );
      throw error;
    } finally {
      releaseImage();
      releasePoll();
      await page.close();
    }
  });

  it("shows distinct unavailable and failed-to-load image states", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.clock.install();
    await seedUnavailableImages(page, origin);
    // This test owns HTTP-only synthetic history; a live socket cannot know its fabricated head.
    let refreshed = false;
    await page.route(`**/api/v1/orbs/${ORB_ID}`, async (route) => {
      const afterInitialLoad = refreshed;
      const response = await route.fetch();
      const body = await response.json();
      body.state = "stopped";
      body.activity = "idle";
      if (afterInitialLoad) body.name = "Image fixture refreshed";
      await route.fulfill({ response, json: body });
    });
    let releaseImage!: () => void;
    const heldImage = new Promise<void>((resolve) => {
      releaseImage = resolve;
    });
    const imageRequested = page.waitForRequest(`${origin}/fixture-broken-image.png`);
    let liveSockets = 0;
    page.on("websocket", (socket) => {
      if (socket.url().endsWith(`/orbs/${ORB_ID}/live`)) liveSockets++;
    });
    await page.route(`${origin}/fixture-broken-image.png`, async (route) => {
      await heldImage;
      await route.fulfill({ status: 404, body: "missing" });
    });
    try {
      await gotoFrontendHistory(page, url, ORB_ID);
      const missing = imageActivity(page, "missing_source");
      const broken = imageActivity(page, "broken_source");
      await expectPage(missing.getByText("image unavailable", { exact: true })).toBeVisible();
      await imageRequested;
      await expectPage(broken.locator("img.tool-image-thumbnail")).toHaveCount(1);
      refreshed = true;
      const pollResponse = page.waitForResponse(
        async (response) =>
          new URL(response.url()).pathname === `/api/v1/orbs/${ORB_ID}` &&
          response.request().method() === "GET" &&
          (await response.json()).name === "Image fixture refreshed",
      );
      await page.clock.runFor(2100);
      await pollResponse;
      await expectPage(page.locator(".orb-name")).toHaveText("Image fixture refreshed");
      expectPage(liveSockets).toBe(0);
      await expectPage(missing.getByText("image unavailable", { exact: true })).toBeVisible();
      await expectPage(broken.locator("img.tool-image-thumbnail")).toHaveCount(1);
      const response = page.waitForResponse(`${origin}/fixture-broken-image.png`);
      releaseImage();
      expectPage((await response).status()).toBe(404);
      await expectPage(broken.getByText("image failed to load", { exact: true })).toBeVisible();
      await expectPage(missing.getByRole("img")).toHaveCount(0);
      await expectPage(broken.getByRole("img")).toHaveCount(0);
    } finally {
      releaseImage();
      await page.close();
    }
  });

  // Own read semantics and transport schedules, not unrelated media or tail scrolling.
  it.each(["normal-first", "result-loading", "input-loading", "input-release-at-click"] as const)(
    "uses call arguments only when a completed read's result has no displayable body · %s",
    async (schedule) => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.addInitScript(`(() => {
        const events = [];
        Object.assign(globalThis, { __readFallbackEvents: events });
        for (const type of ["pointerdown", "pointerup", "click", "toggle"])
          document.addEventListener(type, event => {
            events.push({ type, trusted: event.isTrusted,
              target: event.target?.closest?.("summary, details")?.textContent,
              open: event.target?.closest?.("details")?.open });
          }, true);
      })();`);
      let liveSockets = 0;
      page.on("websocket", (socket) => {
        if (socket.url().endsWith(`/orbs/${ORB_ID}/live`)) liveSockets++;
      });
      const timestamp = "2026-10-05T12:00:00.000Z";
      const records: HistoryRecord[] = [
        {
          id: "read-root",
          parentId: null,
          timestamp,
          type: "message",
          role: "user",
          content: [{ type: "text", text: "Read fallback." }],
          overflow: {},
        },
        {
          id: "read-calls",
          parentId: "read-root",
          timestamp,
          type: "message",
          role: "assistant",
          content: [
            {
              type: "tool_call",
              callId: "fixture-read-one",
              name: "read",
              arguments: { path: "apps/web/src/components/HistoryView.tsx" },
            },
            {
              type: "tool_call",
              callId: "fixture-read-two",
              name: "read",
              arguments: { path: "docs/web-ui.md" },
            },
          ],
          overflow: {},
        },
        {
          id: "read-empty",
          parentId: "read-calls",
          timestamp,
          type: "message",
          role: "tool",
          content: [{ type: "tool_result", callId: "fixture-read-one", content: [] }],
          overflow: {},
        },
        {
          id: "read-body",
          parentId: "read-empty",
          timestamp,
          type: "message",
          role: "tool",
          content: [
            {
              type: "tool_result",
              callId: "fixture-read-two",
              content: [{ type: "text", text: "Web UI design decisions" }],
            },
          ],
          overflow: {},
        },
      ];
      const projected = await projectFixtureHistory(page, ORB_ID, records);
      await page.route(`**/api/v1/orbs/${ORB_ID}`, async (route) => {
        const response = await route.fetch();
        const orb = await response.json();
        orb.state = "stopped";
        await route.fulfill({ response, json: orb });
      });
      let emptyResult = "";
      let emptyCall = "";
      let normalCall = "";
      const requested: string[] = [];
      let releaseResult!: () => void;
      let releaseInput!: () => void;
      const resultGate = new Promise<void>((resolve) => {
        releaseResult = resolve;
      });
      const inputGate = new Promise<void>((resolve) => {
        releaseInput = resolve;
      });
      await page.route(`**/api/v1/orbs/${ORB_ID}/history`, async (route) => {
        const response = await route.fetch();
        const view = await response.json();
        view.records = projected;
        view.headId = records.at(-1)?.id;
        view.cursor = view.headId;
        for (const record of view.records)
          for (const block of record.content ?? []) {
            if (block.callId === "fixture-read-one") {
              if (block.type === "tool_call") emptyCall = `${record.id}/${block.detailKey}`;
              if (block.type === "tool_result") emptyResult = `${record.id}/${block.detailKey}`;
            }
            if (block.callId === "fixture-read-two" && block.type === "tool_call")
              normalCall = `${record.id}/${block.detailKey}`;
          }
        await route.fulfill({ response, json: view });
      });
      await page.route(`**/api/v1/orbs/${ORB_ID}/details/**`, async (route) => {
        const path = decodeURIComponent(new URL(route.request().url()).pathname);
        requested.push(path);
        if (schedule !== "normal-first" && path.endsWith(`/details/${emptyCall}`)) {
          await inputGate;
          return route.fallback();
        }
        if (path.endsWith(`/details/${emptyResult}`) && schedule !== "normal-first")
          await resultGate;
        return route.fallback();
      });
      try {
        await gotoFrontendHistory(page, url, ORB_ID);
        const read = page
          .locator("details.tool-activity-category")
          .filter({ hasText: "HistoryView.tsx" })
          .filter({ hasText: "docs/web-ui.md" });
        await expectPage(read).toBeVisible();
        await page.evaluate(async () => {
          await Reflect.get(globalThis, "document").fonts.ready;
        });
        const assertBoundedHistory = async () => {
          expectPage(
            await page.locator(".orb-transcript-scroll").evaluate((element) => ({
              overflow: element.scrollHeight > element.clientHeight,
              scrollTop: element.scrollTop,
            })),
          ).toEqual({ overflow: false, scrollTop: 0 });
        };
        await assertBoundedHistory();
        await expectPage(page.locator("details.tool-activity-category")).toHaveCount(1);
        await expectPage(page.locator(".tool-image-preview, img.msg-image")).toHaveCount(0);
        await read.locator(":scope > summary").click();
        await assertBoundedHistory();
        await expectPage(read.locator("details.tool-activity-call")).toHaveCount(2);
        const empty = read
          .locator("details.tool-activity-call")
          .filter({ hasText: "HistoryView.tsx" });
        const normal = read
          .locator("details.tool-activity-call")
          .filter({ hasText: "docs/web-ui.md" });
        if (schedule !== "normal-first") {
          const resultRequested = page.waitForRequest((request) =>
            decodeURIComponent(new URL(request.url()).pathname).endsWith(`/details/${emptyResult}`),
          );

          await empty.locator(":scope > summary").click();
          await resultRequested;
          await expectPage(empty).toContainText("Loading…");
          await assertBoundedHistory();
          if (schedule !== "result-loading") {
            const inputRequested = page.waitForRequest((request) =>
              decodeURIComponent(new URL(request.url()).pathname).endsWith(`/details/${emptyCall}`),
            );
            releaseResult();
            await inputRequested;
            await expectPage(empty).toContainText("Loading…");
            await assertBoundedHistory();
          }
        }

        if (schedule === "input-release-at-click") releaseInput();
        await normal.locator(":scope > summary").click();
        await assertBoundedHistory();
        await expectPage(normal.locator(".tool-call-output")).toContainText(
          "Web UI design decisions",
        );
        expectPage(requested.some((path) => path.endsWith(`/details/${normalCall}`))).toBe(false);
        if (schedule === "normal-first") {
          await empty.locator(":scope > summary").click();
          await assertBoundedHistory();
        }
        releaseResult();
        releaseInput();
        await expectPage(empty.locator(".tool-input")).toContainText("HistoryView.tsx");
        expectPage(
          requested.filter((path) => path.endsWith(`/details/${emptyResult}`)),
        ).toHaveLength(1);
        expectPage(requested.filter((path) => path.endsWith(`/details/${emptyCall}`))).toHaveLength(
          1,
        );
        await assertBoundedHistory();
        expectPage(liveSockets).toBe(0);
      } catch (cause) {
        const dir = join(import.meta.dirname, "../test-failures");
        await mkdir(dir, { recursive: true });
        const evidence = await page.evaluate(() => ({
          events: Reflect.get(globalThis, "__readFallbackEvents"),
          scroll: Array.from(
            Reflect.get(globalThis, "document").querySelectorAll(".orb-transcript-scroll"),
            (element: { scrollTop: number; scrollHeight: number; clientHeight: number }) => ({
              scrollTop: element.scrollTop,
              scrollHeight: element.scrollHeight,
              clientHeight: element.clientHeight,
            }),
          ),
        }));
        await writeFile(
          join(dir, `read-fallback-${engine}-${schedule}-${Date.now()}.json`),
          JSON.stringify(
            { replayable: false, requested, liveSockets, evidence, cause: String(cause) },
            null,
            2,
          ),
        );
        throw cause;
      } finally {
        releaseResult();
        releaseInput();
        await page.close();
      }
    },
  );

  it("enlarges a preview and Escape restores focus to its trigger", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await gotoFrontendHistory(page, url, ORB_ID);
      const trigger = imageActivity(page, "artifacts/dashboard-preview.svg").getByRole("button", {
        name: "Enlarge image returned by read",
        exact: true,
      });
      await trigger.click();
      const dialog = page.getByRole("dialog", { name: "Image returned by read", exact: true });
      await expectPage(dialog).toBeVisible();
      await expectPage(
        dialog.getByRole("img", { name: "Image returned by read", exact: true }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expectPage(dialog).not.toBeVisible();
      await expectPage(trigger).toBeFocused();
    } finally {
      await page.close();
    }
  });

  it.each([320, 390])("fits inline previews within a %ipx viewport", async (width) => {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    try {
      await gotoFrontendHistory(page, url, ORB_ID);
      const previews = page.locator(".tool-image-preview");
      await expectPage(previews.first()).toBeVisible();
      const geometry = await previews.evaluateAll((nodes) =>
        nodes.map((node) => {
          const parent = node.closest(".history")?.getBoundingClientRect();
          const box = node.getBoundingClientRect();
          return {
            contained:
              parent !== undefined &&
              box.left >= parent.left - 0.5 &&
              box.right <= parent.right + 0.5,
            internalOverflow: node.scrollWidth > node.clientWidth,
          };
        }),
      );
      expectPage(geometry).toEqual(
        geometry.map(() => ({ contained: true, internalOverflow: false })),
      );
      expectPage(
        await page.evaluate(() => {
          const view = globalThis as unknown as {
            document: { documentElement: { scrollWidth: number } };
            innerWidth: number;
          };
          return view.document.documentElement.scrollWidth <= view.innerWidth;
        }),
      ).toBe(true);
    } finally {
      await page.close();
    }
  });

  it("provides 44px mobile enlarge and close targets", async () => {
    const page = await browser.newPage({ viewport: { width: 320, height: 844 } });
    try {
      await gotoFrontendHistory(page, url, ORB_ID);
      const trigger = imageActivity(page, "artifacts/dashboard-preview.svg").getByRole("button", {
        name: "Enlarge image returned by read",
        exact: true,
      });
      const triggerBox = await trigger.boundingBox();
      expectPage(triggerBox?.width).toBeGreaterThanOrEqual(44);
      expectPage(triggerBox?.height).toBeGreaterThanOrEqual(44);
      await trigger.click();
      const close = page.getByRole("button", { name: "Close image preview", exact: true });
      const closeBox = await close.boundingBox();
      expectPage(closeBox?.width).toBeGreaterThanOrEqual(44);
      expectPage(closeBox?.height).toBeGreaterThanOrEqual(44);
      await close.click();
      await expectPage(trigger).toBeFocused();
    } finally {
      await page.close();
    }
  });
});
