import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Browser, chromium, expect as expectPage, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";
import { gotoFrontendHistory } from "./testkit/frontend-fixture.ts";

const WEB_ROOT = join(import.meta.dirname, "../apps/web");
const ORB_ID = "frontend-fixture-orb";
let vite: ViteDevServer;
let browser: Browser;
let origin: string;

type DropFile = { name: string; mimeType: string; bytes: number[] };

async function dragFiles(
  page: Page,
  selector: string,
  type: "dragenter" | "dragover" | "dragleave" | "drop",
  files: DropFile[],
) {
  return page.locator(selector).evaluate(
    (target, { type, files }) => {
      const browser = globalThis as unknown as {
        DataTransfer: new () => { items: { add(file: File): void } };
        DragEvent: new (
          type: string,
          options: {
            bubbles: boolean;
            cancelable: boolean;
            dataTransfer: unknown;
            clientX: number;
            clientY: number;
          },
        ) => Event;
      };
      const transfer = new browser.DataTransfer();
      for (const file of files) {
        transfer.items.add(
          new File([new Uint8Array(file.bytes)], file.name, { type: file.mimeType }),
        );
      }
      // A synthetic exit needs coordinates outside main; (0, 0) is inside on phones.
      const event = new browser.DragEvent(type, {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
        clientX: type === "dragleave" ? -1 : 0,
        clientY: type === "dragleave" ? -1 : 0,
      });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    },
    { type, files },
  );
}

const pngBytes = [
  ...Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC",
    "base64",
  ),
];
const image: DropFile = { name: "dropped-image.png", mimeType: "image/png", bytes: pngBytes };
const documentFile: DropFile = {
  name: "dropped-document.txt",
  mimeType: "text/plain",
  bytes: [104, 101, 108, 108, 111],
};

async function openOrb(viewport?: { width: number; height: number }, errors?: string[]) {
  const page = await browser.newPage(viewport ? { viewport, isMobile: true, hasTouch: true } : {});
  if (errors) page.on("pageerror", (error) => errors.push(error.message));
  await gotoFrontendHistory(
    page,
    `${origin}/#/orbs/${ORB_ID}`,
    ORB_ID,
    viewport ? page.locator(".composer") : page.getByRole("textbox", { name: "Message the orb" }),
  );
  return page;
}

describe("orb native file drop", () => {
  beforeAll(async () => {
    vite = await createServer({
      root: WEB_ROOT,
      cacheDir: join(WEB_ROOT, "node_modules/.vite-test/frontend-drop"),
      configFile: join(WEB_ROOT, "vite.config.ts"),
      mode: "frontend",
      server: { host: "127.0.0.1", port: 0 },
    });
    await listenFrontend(vite);
    const address = vite.httpServer?.address();
    if (address === null || address === undefined || typeof address === "string") {
      throw new Error("drop E2E Vite server did not own a TCP port");
    }
    origin = `http://127.0.0.1:${address.port}`;
    const executable =
      process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"] ??
      (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
    browser = await chromium.launch({
      ...(executable === undefined ? {} : { executablePath: executable }),
      args: ["--no-sandbox"],
    });
  });

  afterAll(async () => {
    await browser?.close();
    await vite?.close();
  });

  it("shows an inset dashed transcript target on hover and clears it on exit and drop", async () => {
    const page = await openOrb();
    try {
      const inset = page.locator(".orb-drop-inset.orb-drop-transcript");
      const layoutHeight = () =>
        page.evaluate(
          () =>
            (globalThis as unknown as { document: { documentElement: { scrollHeight: number } } })
              .document.documentElement.scrollHeight,
        );
      const initialHeight = await layoutHeight();
      const assertInset = async () => {
        await expectPage(inset).toBeVisible();
        await expectPage(inset).toHaveCSS("border-style", "dashed");
        const bounds = await page.evaluate(() => {
          const doc = (
            globalThis as unknown as {
              document: {
                querySelector(selector: string): {
                  getBoundingClientRect(): {
                    left: number;
                    right: number;
                    top: number;
                    bottom: number;
                  };
                } | null;
              };
            }
          ).document;
          const rect = (selector: string) => doc.querySelector(selector)?.getBoundingClientRect();
          const main = rect(".orb-main");
          const header = rect(".orb-header-stack");
          const composer = rect(".composer");
          const overlay = rect(".orb-drop-inset.orb-drop-transcript");
          if (!main || !header || !composer || !overlay) return null;
          return {
            main: { left: main.left, right: main.right },
            headerBottom: header.bottom,
            composerTop: composer.top,
            overlay: {
              left: overlay.left,
              right: overlay.right,
              top: overlay.top,
              bottom: overlay.bottom,
            },
          };
        });
        assert.ok(bounds);
        expectPage(bounds.overlay.left).toBeGreaterThan(bounds.main.left);
        expectPage(bounds.overlay.right).toBeLessThan(bounds.main.right);
        expectPage(bounds.overlay.top).toBeGreaterThanOrEqual(bounds.headerBottom);
        expectPage(bounds.overlay.bottom).toBeLessThanOrEqual(bounds.composerTop);
        expectPage(bounds.overlay.bottom).toBeGreaterThan(bounds.overlay.top);
        expectPage(await layoutHeight()).toBe(initialHeight);
      };
      await expectPage(inset).toHaveCount(0);
      await dragFiles(page, ".orb-transcript-scroll", "dragenter", [documentFile]);
      expectPage(await dragFiles(page, ".orb-transcript-scroll", "dragover", [documentFile])).toBe(
        true,
      );
      await assertInset();
      await page.screenshot({ path: "test-failures/frontend-drop-inset-success.png" });
      await dragFiles(page, ".orb-transcript-scroll", "dragleave", [documentFile]);
      await expectPage(inset).toHaveCount(0);
      await page.evaluate(() =>
        (globalThis as unknown as { scrollTo(x: number, y: number): void }).scrollTo(0, 800),
      );
      await expectPage
        .poll(() => page.evaluate(() => (globalThis as unknown as { scrollY: number }).scrollY))
        .toBeGreaterThan(0);
      await dragFiles(page, ".orb-transcript-scroll", "dragover", [documentFile]);
      await assertInset();
      await page.screenshot({ path: "test-failures/frontend-drop-inset-scrolled-success.png" });
      expectPage(await dragFiles(page, ".orb-transcript-scroll", "drop", [documentFile])).toBe(
        true,
      );
      await expectPage(inset).toHaveCount(0);
      await expectPage(page.locator(".history")).toContainText("dropped-document.txt");
      expectPage(page.url()).toBe(`${origin}/#/orbs/${ORB_ID}`);
    } finally {
      await page.close();
    }
  });

  it("accepts a native drop in the desktop transcript blank space, not the header", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.route(`**/api/v1/orbs/${ORB_ID}/history`, async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        json: { ...(await response.json()), records: [], headId: null },
      });
    });
    await page.routeWebSocket(`**/api/v1/orbs/${ORB_ID}/live`, (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        const frame = JSON.parse(message.toString());
        if (frame.type !== "history.record") socket.send(message);
      });
    });
    const batches: string[][] = [];
    await page.route(`**/api/v1/orbs/${ORB_ID}/uploads`, async (route) => {
      if (route.request().method() === "POST")
        batches.push(
          route
            .request()
            .postDataJSON()
            .files.map((file: { name: string }) => file.name),
        );
      await route.continue();
    });
    try {
      await gotoFrontendHistory(
        page,
        `${origin}/#/orbs/${ORB_ID}`,
        ORB_ID,
        page.getByRole("textbox", { name: "Message the orb" }),
      );
      const point = await page.evaluate(() => {
        // Empty transcript content has no native hit box; expose the containing main.
        const doc = (
          globalThis as unknown as {
            document: {
              querySelector(selector: string): {
                style: { pointerEvents: string };
                getBoundingClientRect(): {
                  left: number;
                  right: number;
                  top: number;
                  bottom: number;
                };
              } | null;
              elementFromPoint(x: number, y: number): { className: string } | null;
            };
          }
        ).document;
        const historyElement = doc.querySelector(".history");
        if (!historyElement) throw new Error("history missing");
        historyElement.style.pointerEvents = "none";
        const main = doc.querySelector(".orb-main");
        const header = doc.querySelector(".orb-header-stack");
        const composer = doc.querySelector(".composer");
        if (!main || !header || !composer) throw new Error("orb layout missing");
        const m = main.getBoundingClientRect();
        const h = header.getBoundingClientRect();
        const c = composer.getBoundingClientRect();
        const x = (m.left + m.right) / 2;
        const y = (h.bottom + c.top) / 2;
        const target = doc.elementFromPoint(x, y);
        if (!target) throw new Error("blank transcript has no hit target");
        return { x, y, headerBottom: h.bottom, composerTop: c.top, targetClass: target.className };
      });
      expectPage(point.composerTop - point.headerBottom).toBeGreaterThan(100);
      assert.equal(point.targetClass, "orb-main", JSON.stringify(point));
      const dropAtPoint = (type: "dragover" | "drop", x: number, y: number) =>
        page.evaluate(
          ({ type, x, y, file }) => {
            const browser = globalThis as unknown as {
              document: {
                elementFromPoint(
                  x: number,
                  y: number,
                ): { dispatchEvent(event: Event): boolean } | null;
              };
              DataTransfer: new () => { items: { add(file: File): void } };
              DragEvent: new (
                type: string,
                options: {
                  bubbles: boolean;
                  cancelable: boolean;
                  dataTransfer: unknown;
                  clientX: number;
                  clientY: number;
                },
              ) => Event;
            };
            const target = browser.document.elementFromPoint(x, y);
            if (!target) throw new Error("drop target missing");
            const transfer = new browser.DataTransfer();
            transfer.items.add(
              new File([new Uint8Array(file.bytes)], file.name, { type: file.mimeType }),
            );
            const event = new browser.DragEvent(type, {
              bubbles: true,
              cancelable: true,
              dataTransfer: transfer,
              clientX: x,
              clientY: y,
            });
            target.dispatchEvent(event);
            return event.defaultPrevented;
          },
          { type, x, y, file: documentFile },
        );
      expectPage(await dropAtPoint("dragover", point.x, point.y)).toBe(true);
      await expectPage(page.locator(".orb-drop-inset.orb-drop-transcript")).toBeVisible();
      expectPage(await dropAtPoint("drop", point.x, point.y)).toBe(true);
      await expectPage(page.locator(".history")).toContainText(documentFile.name);
      expectPage(batches).toEqual([[documentFile.name]]);
      expectPage(await dropAtPoint("drop", point.x, point.headerBottom - 12)).toBe(true);
      expectPage(batches).toEqual([[documentFile.name]]);
    } finally {
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
    }
  });

  it("routes a transcript batch through workspace uploads without changing the composer draft", async () => {
    const page = await openOrb();
    const batches: { id: string; files: { name: string }[] }[] = [];
    await page.route(`**/api/v1/orbs/${ORB_ID}/uploads`, async (route) => {
      if (route.request().method() === "POST") batches.push(route.request().postDataJSON());
      await route.continue();
    });
    try {
      const draft = page.getByRole("textbox", { name: "Message the orb" });
      await draft.fill("Retain this draft");
      await dragFiles(page, ".orb-transcript-scroll", "drop", [documentFile, image]);
      await expectPage(page.locator(".history")).toContainText("dropped-document.txt");
      await expectPage(page.locator(".history")).toContainText("dropped-image.png");
      await expectPage(draft).toHaveValue("Retain this draft");
      expectPage(batches).toHaveLength(1);
      expectPage(batches[0]?.files.map((file) => file.name)).toEqual([
        documentFile.name,
        image.name,
      ]);
      expectPage(page.url()).toBe(`${origin}/#/orbs/${ORB_ID}`);
    } finally {
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
    }
  });

  it("attaches only images dropped onto the composer and visibly rejects other files without sending", async () => {
    const page = await openOrb();
    const uploads: string[] = [];
    const messages: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/uploads"))
        uploads.push(request.url());
      if (request.method() === "PUT" && request.url().includes("/messages/"))
        messages.push(request.url());
    });
    try {
      const composer = page.locator(".composer");
      const draft = composer.getByRole("textbox");
      await draft.fill("Unsent draft");
      await dragFiles(page, ".composer", "dragover", [image, documentFile]);
      const inset = composer.locator(".orb-drop-inset");
      await expectPage(inset).toBeVisible();
      await expectPage(inset).toHaveCSS("border-style", "dashed");
      expectPage(await dragFiles(page, ".composer", "drop", [image, documentFile])).toBe(true);
      await expectPage(inset).toHaveCount(0);
      await expectPage(composer.locator(".composer-attachment")).toHaveCount(1);
      await expectPage(composer.locator(".composer-attachment img")).toHaveAttribute(
        "alt",
        "pasted attachment",
      );
      await expectPage(page.getByRole("status")).toContainText(
        "Non-images can only be uploaded as files to the orb.",
      );
      await expectPage(draft).toHaveValue("Unsent draft");
      expectPage(uploads).toHaveLength(0);
      expectPage(messages).toHaveLength(0);
      expectPage(page.url()).toBe(`${origin}/#/orbs/${ORB_ID}`);
    } finally {
      await page.close();
    }
  });

  it("rejects every drop while stopped with a visible running-required message and no upload", async () => {
    const page = await openOrb();
    const uploads: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/uploads"))
        uploads.push(request.url());
    });
    try {
      await page.getByRole("button", { name: "Stop orb" }).click();
      await expectPage(page.getByRole("button", { name: "Start orb" })).toBeVisible();
      expectPage(await dragFiles(page, ".orb-header", "drop", [documentFile])).toBe(true);
      await expectPage(page.locator(".orb-drop-feedback")).toHaveText(
        "Uploads need a running orb.",
      );
      expectPage(await dragFiles(page, ".orb-transcript-scroll", "drop", [documentFile])).toBe(
        true,
      );
      await expectPage(page.locator(".orb-drop-feedback")).toHaveText(
        "Uploads need a running orb.",
      );
      await dragFiles(page, ".composer", "drop", [image]);
      await expectPage(page.locator(".orb-drop-feedback")).toHaveText(
        "Uploads need a running orb.",
      );
      await expectPage(page.locator(".composer-attachment")).toHaveCount(0);
      expectPage(uploads).toHaveLength(0);
      expectPage(page.url()).toBe(`${origin}/#/orbs/${ORB_ID}`);
    } finally {
      await page.getByRole("button", { name: "Start orb" }).click();
      await expectPage(page.getByRole("button", { name: "Stop orb" })).toBeVisible();
      await page.close();
    }
  });

  it.each([390, 320])(
    "keeps the phone inset within the scroll pane at %ipx and attaches images folded or expanded",
    async (width) => {
      const errors: string[] = [];
      const page = await openOrb({ width, height: 844 }, errors);
      try {
        const scroller = page.locator(".orb-transcript-scroll");
        const composer = page.locator(".composer");
        const transcriptInset = page.locator(".orb-drop-inset.orb-drop-transcript");
        const composerInset = composer.locator(".orb-drop-inset");
        const layoutHeight = await page.evaluate(
          () =>
            (globalThis as unknown as { document: { documentElement: { scrollHeight: number } } })
              .document.documentElement.scrollHeight,
        );
        const checkGeometry = async () => {
          const geometry = await page.locator(".orb-main").evaluate((main) => {
            const pane = main.querySelector(".orb-transcript-scroll").getBoundingClientRect();
            const header = main.querySelector(".orb-header-stack").getBoundingClientRect();
            const composer = main.querySelector(".composer").getBoundingClientRect();
            const inset = main.querySelector(".orb-drop-transcript").getBoundingClientRect();
            const doc = main.ownerDocument.documentElement;
            return {
              pane: { left: pane.left, right: pane.right, top: pane.top, bottom: pane.bottom },
              headerBottom: header.bottom,
              composerTop: composer.top,
              inset: { left: inset.left, right: inset.right, top: inset.top, bottom: inset.bottom },
              paneOverflow:
                main.querySelector(".orb-transcript-scroll").scrollWidth -
                main.querySelector(".orb-transcript-scroll").clientWidth,
              documentOverflow: doc.scrollWidth - doc.clientWidth,
              layoutHeight: doc.scrollHeight,
            };
          });
          expectPage(geometry.inset.left).toBeGreaterThan(geometry.pane.left);
          expectPage(geometry.inset.right).toBeLessThan(geometry.pane.right);
          expectPage(geometry.inset.top).toBeGreaterThanOrEqual(geometry.pane.top);
          expectPage(geometry.inset.top).toBeGreaterThanOrEqual(geometry.headerBottom);
          expectPage(geometry.inset.bottom).toBeLessThanOrEqual(geometry.pane.bottom);
          expectPage(geometry.inset.bottom).toBeLessThanOrEqual(geometry.composerTop);
          expectPage(geometry.paneOverflow).toBeLessThanOrEqual(1);
          expectPage(geometry.documentOverflow).toBeLessThanOrEqual(1);
          expectPage(geometry.layoutHeight).toBe(layoutHeight);
        };
        await expectPage(composer.getByRole("button", { name: "Write message" })).toBeVisible();
        await dragFiles(page, ".orb-transcript-scroll", "dragover", [documentFile]);
        await expectPage(transcriptInset).toHaveCSS("border-style", "dashed");
        await checkGeometry();
        await scroller.evaluate((element) => {
          element.scrollTop = Math.min(400, element.scrollHeight - element.clientHeight);
        });
        await dragFiles(page, ".orb-transcript-scroll", "dragover", [documentFile]);
        await checkGeometry();
        await dragFiles(page, ".orb-transcript-scroll", "dragleave", [documentFile]);
        await expectPage(transcriptInset).toHaveCount(0);

        await dragFiles(page, ".composer", "dragover", [image]);
        await expectPage(composerInset).toBeVisible();
        await expectPage(composerInset).toHaveCSS("border-style", "dashed");
        await page.screenshot({ path: `.context/orb-drop/mobile-${width}-collapsed.png` });
        expectPage(await dragFiles(page, ".composer", "drop", [image])).toBe(true);
        await composer.getByRole("button", { name: "Write message" }).click();
        await expectPage(composer.locator(".composer-attachment img")).toBeVisible();
        await dragFiles(page, ".composer", "dragover", [{ ...image, name: "second-image.png" }]);
        await expectPage(composerInset).toBeVisible();
        await page.screenshot({ path: `.context/orb-drop/mobile-${width}-expanded.png` });
        await dragFiles(page, ".composer", "drop", [{ ...image, name: "second-image.png" }]);
        await expectPage(composer.locator(".composer-attachment img")).toHaveCount(2);
        await expectPage(composer.locator(".composer-attachment img").last()).toBeVisible();
        expectPage(errors).toEqual([]);
        expectPage(page.url()).toBe(`${origin}/#/orbs/${ORB_ID}`);
      } finally {
        await page.close();
      }
    },
  );
});
