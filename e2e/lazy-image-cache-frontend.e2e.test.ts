import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium, expect, webkit } from "@playwright/test";
import { createServer } from "vite";
import { it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";
import { gotoFrontendHistory } from "./testkit/frontend-fixture.ts";

const ORB = "frontend-fixture-orb";

it.each(["chromium", "webkit"] as const)(
  "%s: image bytes survive drawer and orb navigation",
  async (engine) => {
    const root = join(import.meta.dirname, "../apps/web");
    const cacheDir = await mkdtemp(join(tmpdir(), `pi-orb-image-cache-${engine}-`));
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
      const requests: string[] = [];
      await page.addInitScript(() => {
        const create = URL.createObjectURL.bind(URL);
        const revoke = URL.revokeObjectURL.bind(URL);
        const revoked: string[] = [];
        Object.assign(globalThis, { __imageRevoked: revoked });
        const debug = console.debug.bind(console);
        const diagnostics: unknown[] = [];
        Object.assign(globalThis, { __imageDiagnostics: diagnostics });
        console.debug = (...args) => {
          if (args[0] === "display image") diagnostics.push(args[1]);
          debug(...args);
        };
        URL.createObjectURL = (blob) => create(blob);
        URL.revokeObjectURL = (url) => {
          revoked.push(url);
          revoke(url);
        };
      });
      await page.route(`**/api/v1/orbs/${ORB}/images/**`, async (route) => {
        requests.push(new URL(route.request().url()).pathname);
        const response = await route.fetch();
        await route.fulfill({
          response,
          headers: { ...response.headers(), "cache-control": "no-store" },
        });
      });
      try {
        await gotoFrontendHistory(page, `${origin}/orbs/${ORB}`, ORB);
        const image = page
          .locator("details.tool-image-activity")
          .filter({ hasText: "artifacts/dashboard-preview.svg" });
        const thumbnail = image.locator("img.tool-image-thumbnail").first();
        await expect(thumbnail).toBeVisible();
        await expect
          .poll(() => thumbnail.evaluate((node) => Reflect.get(node, "naturalWidth") as number))
          .toBeGreaterThan(0);
        await expect.poll(() => requests.length).toBeGreaterThan(0);
        const target = requests[0];
        if (target === undefined) throw new Error("No binary image request");
        await expect.poll(() => requests.filter((path) => path === target).length).toBe(1);
        const [record, detail, imageIndex] = target.split("/").slice(-3);
        if (record === undefined || detail === undefined || imageIndex === undefined)
          throw new Error("Invalid binary image path");
        const identity = {
          orbId: ORB,
          recordId: decodeURIComponent(record),
          detailKey: decodeURIComponent(detail),
          imageIndex: Number(imageIndex),
        };
        const diagnosticCount = (outcome: string) =>
          page.evaluate(
            ({ outcome, identity }) =>
              (
                globalThis as typeof globalThis & {
                  __imageDiagnostics: Array<Record<string, unknown>>;
                }
              ).__imageDiagnostics.filter(
                (entry) =>
                  entry.outcome === outcome &&
                  entry.orbId === identity.orbId &&
                  entry.recordId === identity.recordId &&
                  entry.detailKey === identity.detailKey &&
                  entry.imageIndex === identity.imageIndex,
              ).length,
            { outcome, identity },
          );
        await expect.poll(() => diagnosticCount("stored")).toBeGreaterThan(0);
        await expect(thumbnail).toHaveAttribute("src", /^blob:/);
        const attachment = page.locator(".history img.msg-image").first();
        await expect(attachment).toBeVisible();
        await expect(attachment).toHaveAttribute("src", /^blob:/);
        const firstUrl = await thumbnail.getAttribute("src");
        if (firstUrl === null) throw new Error("No visible image URL");
        const revoked = (url: string) =>
          page.evaluate(
            (value) =>
              (
                globalThis as typeof globalThis & { __imageRevoked: string[] }
              ).__imageRevoked.includes(value),
            url,
          );
        expect(await revoked(firstUrl), "visible URL must remain live").toBe(false);
        await image.locator(":scope > summary").click();
        await expect(thumbnail).toBeHidden();
        await image.locator(":scope > summary").click();
        await expect(thumbnail).toBeVisible();
        await expect
          .poll(() => thumbnail.evaluate((node) => Reflect.get(node, "naturalWidth") as number))
          .toBeGreaterThan(0);
        expect(
          requests.filter((path) => path === target),
          "reopening a drawer must reuse cached image bytes",
        ).toHaveLength(1);
        await page.locator('.orb-index a[href="/orbs/frontend-lazy-details"]').click();
        await expect(page.locator(".orb-name")).not.toHaveText("Frontend Playground");
        await expect.poll(() => revoked(firstUrl)).toBe(true);
        await page.locator(`.orb-index a[href="/orbs/${ORB}"]`).click();
        await expect(thumbnail).toBeVisible();
        await expect
          .poll(() => thumbnail.evaluate((node) => Reflect.get(node, "naturalWidth") as number))
          .toBeGreaterThan(0);
        expect(
          requests.filter((path) => path === target),
          "returning to an orb must reuse cached image bytes",
        ).toHaveLength(1);
        await expect.poll(() => diagnosticCount("hit")).toBeGreaterThan(0);

        // A pending image is shared across disclosure remounts, but cannot publish
        // after its view and owner have gone away.
        const pendingPage = await browser.newPage();
        await pendingPage.addInitScript(() => {
          const create = URL.createObjectURL.bind(URL);
          Object.assign(globalThis, { __imageCreated: [] as string[] });
          URL.createObjectURL = (blob) => {
            const url = create(blob);
            (globalThis as typeof globalThis & { __imageCreated: string[] }).__imageCreated.push(
              url,
            );
            return url;
          };
        });
        const pendingRequests: string[] = [];
        let release = () => {};
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        await pendingPage.route(`**/api/v1/orbs/${ORB}/images/**`, async (route) => {
          pendingRequests.push(new URL(route.request().url()).pathname);
          const response = await route.fetch();
          await gate;
          await route.fulfill({
            response,
            headers: { ...response.headers(), "cache-control": "no-store" },
          });
        });
        try {
          await gotoFrontendHistory(pendingPage, `${origin}/orbs/${ORB}`, ORB);
          const pendingImage = pendingPage
            .locator("details.tool-image-activity")
            .filter({ hasText: "artifacts/dashboard-preview.svg" });
          await expect(pendingImage.getByText("Loading…").first()).toBeVisible();
          await expect.poll(() => pendingRequests.length).toBeGreaterThan(0);
          const pendingTarget = pendingRequests[0];
          if (pendingTarget === undefined) throw new Error("No pending image request");
          await pendingImage.locator(":scope > summary").click();
          await pendingImage.locator(":scope > summary").click();
          await expect(pendingImage.getByText("Loading…").first()).toBeVisible();
          expect(
            pendingRequests.filter((path) => path === pendingTarget),
            "reopen shares pending binary reads",
          ).toHaveLength(1);
          await pendingPage.locator(".ix-brand").click();
          await expect(pendingPage.locator(".orb-name")).toHaveCount(0);
          const created = () =>
            pendingPage.evaluate(
              () =>
                (globalThis as typeof globalThis & { __imageCreated: string[] }).__imageCreated
                  .length,
            );
          const beforeRelease = await created();
          const oldResponse = pendingPage.waitForResponse(
            (response) => new URL(response.url()).pathname === pendingTarget,
          );
          release();
          await oldResponse;
          await pendingPage.evaluate(
            () =>
              new Promise<void>((resolve) => {
                const frame = Reflect.get(globalThis, "requestAnimationFrame") as (
                  callback: () => void,
                ) => void;
                frame(() => frame(resolve));
              }),
          );
          expect(await created(), "abandoned image response cannot create an object URL").toBe(
            beforeRelease,
          );
          await pendingPage.locator(`.orb-entry-link[href="/orbs/${ORB}"]`).click();
          await expect(pendingImage.locator("img.tool-image-thumbnail").first()).toBeVisible();
          await expect
            .poll(() => pendingRequests.filter((path) => path === pendingTarget).length)
            .toBeGreaterThan(1);
        } finally {
          release();
          await pendingPage.close();
        }

        const retryPage = await browser.newPage();
        await retryPage.addInitScript(() => {
          const create = URL.createObjectURL.bind(URL);
          let rejectFirst = true;
          URL.createObjectURL = (blob) => {
            if (rejectFirst) {
              rejectFirst = false;
              throw new Error("private platform failure");
            }
            return create(blob);
          };
        });
        try {
          await gotoFrontendHistory(retryPage, `${origin}/orbs/${ORB}`, ORB);
          const failed = retryPage.getByRole("alert").filter({ hasText: "image failed to load" });
          await expect(failed).toHaveCount(1);
          await failed.getByRole("button", { name: "Retry" }).click();
          await expect(failed).toHaveCount(0);
        } finally {
          await retryPage.close();
        }
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

it.each(["chromium", "webkit"] as const)(
  "%s: a valid local image renders even without a resident cache snapshot",
  async (engine) => {
    const root = join(import.meta.dirname, "../apps/web");
    const cacheDir = await mkdtemp(join(tmpdir(), `pi-orb-image-uncacheable-${engine}-`));
    const vite = await createServer({
      root,
      configFile: join(root, "vite.config.ts"),
      cacheDir,
      mode: "frontend",
      server: { host: "127.0.0.1", port: 0 },
      plugins: [
        {
          name: "test-zero-transcript-cache-budget",
          enforce: "pre",
          transform(code, id) {
            if (!id.endsWith("/src/App.tsx")) return;
            const original = "new TranscriptCache()";
            if (!code.includes(original)) throw new Error("Transcript cache constructor moved");
            return code.replace(original, "new TranscriptCache({ maxBytes: 0 })");
          },
        },
      ],
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
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const origin = `http://127.0.0.1:${address.port}`;
      const requests: string[] = [];
      let readImagePath = "";
      await page.route(`**/api/v1/orbs/${ORB}/details/**`, async (route) => {
        const response = await route.fetch();
        const detail = (await response.json()) as {
          recordId: string;
          detailKey: string;
          body: { content?: { type: string; text?: string; imageRef?: string }[] };
        };
        if (detail.body.content?.some((item) => item.text?.includes("Dashboard preview (960"))) {
          const ref = detail.body.content.find((item) => item.type === "image")?.imageRef;
          if (ref === undefined || !ref.startsWith(`${detail.detailKey}:`))
            throw new Error("Fixture read image has no source index");
          const index = ref.slice(detail.detailKey.length + 1);
          readImagePath = `/api/v1/orbs/${ORB}/images/${encodeURIComponent(detail.recordId)}/${encodeURIComponent(detail.detailKey)}/${index}`;
        }
        await route.fulfill({ response, json: detail });
      });
      await page.route(`**/api/v1/orbs/${ORB}/images/**`, async (route) => {
        requests.push(new URL(route.request().url()).pathname);
        const response = await route.fetch();
        await route.fulfill({
          response,
          headers: { ...response.headers(), "cache-control": "no-store" },
        });
      });
      try {
        await gotoFrontendHistory(page, `${origin}/orbs/${ORB}`, ORB);
        const image = page
          .locator("details.tool-image-activity")
          .filter({ hasText: "artifacts/dashboard-preview.svg" });
        const thumbnail = image.locator("img.tool-image-thumbnail").first();
        await expect.poll(() => requests.length).toBeGreaterThan(0);
        await expect(thumbnail).toBeVisible();
        await expect(thumbnail).toHaveAttribute("src", /^blob:/);
        await expect
          .poll(() => thumbnail.evaluate((node) => Reflect.get(node, "naturalWidth") as number))
          .toBeGreaterThan(0);
        await expect(page.locator(".history img.msg-image").first()).toHaveAttribute(
          "src",
          /^blob:/,
        );
        await image.locator(":scope > summary").click();
        await image.locator(":scope > summary").click();
        await expect(thumbnail).toHaveAttribute("src", /^blob:/);
        await expect
          .poll(() => requests.filter((path) => path === readImagePath).length)
          .toBeGreaterThanOrEqual(2);
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
