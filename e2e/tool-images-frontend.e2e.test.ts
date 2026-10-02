import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
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
    let refreshed = false;
    await page.route(`**/api/v1/orbs/${ORB_ID}`, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      if (refreshed) body.name = "Image drawer poll";
      await route.fulfill({ response, json: body });
    });
    try {
      await gotoFrontendHistory(page, url, ORB_ID);
      const read = imageActivity(page, "artifacts/dashboard-preview.svg");
      const image = read.getByRole("img", { name: "Image returned by read", exact: true });
      await expectPage(page.locator(".orb-name")).toBeVisible();
      await read.locator(":scope > summary").click();
      await expectPage(image).toBeHidden();

      refreshed = true;
      await page.clock.runFor(2100);
      await expectPage(page.locator(".orb-name")).toHaveText("Image drawer poll");
      await expectPage(read).not.toHaveAttribute("open", "");
      await expectPage(image).toBeHidden();
    } finally {
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

  it("uses call arguments only when a completed read's result has no displayable body", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    let emptyResult = "";
    let emptyCall = "";
    let normalCall = "";
    const requested: string[] = [];
    await page.route(`**/api/v1/orbs/${ORB_ID}/history`, async (route) => {
      const response = await route.fetch();
      const view = await response.json();
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
      if (!path.endsWith(`/details/${emptyResult}`)) return route.continue();
      const response = await route.fetch();
      const detail = await response.json();
      detail.body.content = [];
      await route.fulfill({ response, json: detail });
    });
    try {
      await gotoFrontendHistory(page, url, ORB_ID);
      const read = page
        .locator("details.tool-activity-category")
        .filter({ hasText: "HistoryView.tsx" })
        .filter({ hasText: "docs/web-ui.md" });
      await read.locator(":scope > summary").click();
      const empty = read
        .locator("details.tool-activity-call")
        .filter({ hasText: "HistoryView.tsx" });
      const normal = read
        .locator("details.tool-activity-call")
        .filter({ hasText: "docs/web-ui.md" });
      await normal.locator(":scope > summary").click();
      await expectPage(normal.locator(".tool-call-output")).toContainText(
        "Web UI design decisions",
      );
      expectPage(requested.some((path) => path.endsWith(`/details/${normalCall}`))).toBe(false);
      await empty.locator(":scope > summary").click();
      await expectPage(empty.locator(".tool-input")).toContainText("HistoryView.tsx");
      expectPage(requested.filter((path) => path.endsWith(`/details/${emptyResult}`))).toHaveLength(
        1,
      );
      expectPage(requested.filter((path) => path.endsWith(`/details/${emptyCall}`))).toHaveLength(
        1,
      );
    } finally {
      await page.close();
    }
  });

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
