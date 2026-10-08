import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect as check, chromium, webkit } from "@playwright/test";
import { createServer } from "vite";
import { it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";
import { observeFrontendBoot } from "./testkit/frontend-fixture.ts";

for (const engine of ["chromium", "webkit"] as const) {
  for (const scenario of ["missing", "delete-active"] as const) {
    it(`${engine}: ${scenario} keeps the missing orb outside the sidebar and retains its URL`, async () => {
      const root = join(import.meta.dirname, "../apps/web");
      const cacheDir = await mkdtemp(join(tmpdir(), "pi-orb-missing-layout-"));
      await mkdir(join(import.meta.dirname, "../test-failures"), { recursive: true });
      const evidence = await mkdtemp(
        join(import.meta.dirname, `../test-failures/missing-orb-${engine}-${scenario}-`),
      );
      const vite = await createServer({
        root,
        cacheDir,
        configFile: join(root, "vite.config.ts"),
        mode: "frontend",
        server: { host: "127.0.0.1", port: 0 },
      });
      let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
      let boot: ReturnType<typeof observeFrontendBoot> | undefined;
      const waits: Promise<unknown>[] = [];
      function ownWait<T>(wait: Promise<T>): Promise<T> {
        waits.push(Promise.allSettled([wait]));
        return wait;
      }
      try {
        await listenFrontend(vite);
        const address = vite.httpServer?.address();
        if (!address || typeof address === "string") throw new Error("No fixture port");
        browser = await (engine === "chromium" ? chromium : webkit).launch();
        const page = await browser.newPage({ viewport: { width: 820, height: 1080 } });
        boot = observeFrontendBoot(page);
        const origin = `http://127.0.0.1:${address.port}`;
        const id = scenario === "missing" ? "missing-layout-orb" : "frontend-fixture-orb";
        let deleted = false;
        let missingMetadata = scenario === "missing";
        let metadata404s = 0;
        let deletingOrb: Record<string, unknown> | null = null;
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.route(`**/api/v1/orbs/${id}`, async (route) => {
          if (route.request().method() === "DELETE") {
            const response = await route.fetch({ method: "GET" });
            const orb = await response.json();
            deleted = true;
            deletingOrb = { ...orb, state: "deleting" };
            return route.fulfill({ status: 202, json: deletingOrb });
          }
          if (missingMetadata) {
            metadata404s++;
            return route.fulfill({
              status: 404,
              json: {
                error: { code: "not_found", message: "Orb doesn't exist", retryable: false },
              },
            });
          }
          if (deletingOrb) return route.fulfill({ json: deletingOrb });
          return route.continue();
        });
        await page.goto(`${origin}/orbs/${id}`);
        if (scenario === "delete-active") {
          await check(page.getByTitle("delete", { exact: true })).toBeEnabled();
          const deletion = ownWait(
            page.waitForResponse(
              (response) =>
                response.url() === `${origin}/api/v1/orbs/${id}` &&
                response.request().method() === "DELETE",
            ),
          );
          page.once("dialog", (dialog) => dialog.accept());
          await page.getByTitle("delete", { exact: true }).click();
          const response = await deletion;
          check(response.status()).toBe(202);
          check((await response.json()).state).toBe("deleting");
          check(deleted).toBe(true);
        }
        const heading = page.getByRole("heading", { name: "Orb doesn't exist" });
        const link = page.getByRole("link", { name: "Back to dashboard", exact: true });
        await check(heading).toBeVisible();
        await check(link).toHaveAttribute("href", "/");
        const geometry = await page.locator(".orb-page").evaluate((pageNode) => {
          const document = pageNode.ownerDocument;
          const rect = (selector: string) => {
            const node = document.querySelector(selector);
            if (!node) throw new Error(`Missing geometry target: ${selector}`);
            const { x, y, width, height, right } = node.getBoundingClientRect();
            const hit = document.elementFromPoint(x + width / 2, y + height / 2);
            return { x, y, width, height, right, hit: hit === node || node.contains(hit) };
          };
          return {
            sidebar: rect(".orb-index"),
            heading: rect(".simple-page h1"),
            link: rect(".simple-page a"),
          };
        });
        await page.screenshot({ path: join(evidence, "desktop.png") });
        console.log(`${engine} ${scenario} desktop geometry`, geometry);
        await writeFile(join(evidence, "geometry.json"), JSON.stringify(geometry, null, 2));
        check(geometry.heading.x).toBeGreaterThanOrEqual(geometry.sidebar.right);
        check(geometry.link.x).toBeGreaterThanOrEqual(geometry.sidebar.right);
        check(geometry.heading.hit).toBe(true);
        check(geometry.link.hit).toBe(true);
        check(page.url()).toBe(`${origin}/orbs/${id}`);
        if (scenario === "delete-active") {
          check(missingMetadata).toBe(false);
          check(metadata404s).toBe(0);
          console.log(`${engine}: deleting state rendered missing-view geometry before any 404`);
          missingMetadata = true;
          const reloadBoot = boot;
          reloadBoot.checkpoint("deleting:rendered; metadata:switch-to-404; reload:start");
          const response = ownWait(
            page.waitForResponse(
              (value) => value.url() === `${origin}/api/v1/orbs/${id}` && value.status() === 404,
            ),
          );
          await reloadBoot.wait(
            (async () => {
              await page.reload();
              reloadBoot.checkpoint("reload:load");
              await response;
              reloadBoot.checkpoint("metadata:404");
              await check(heading).toBeVisible();
              reloadBoot.checkpoint("missing:visible");
            })(),
          );
          check(page.url()).toBe(`${origin}/orbs/${id}`);
        }
        await page.setViewportSize({ width: 390, height: 844 });
        await check(page.getByRole("navigation", { name: "All project orbs" })).toBeHidden();
        for (const target of [heading, link]) {
          const phone = await target.boundingBox();
          if (!phone) throw new Error("Missing phone target");
          check(phone.x).toBeGreaterThanOrEqual(0);
          check(phone.x + phone.width).toBeLessThanOrEqual(390);
          check(phone.y + phone.height).toBeLessThanOrEqual(844);
        }
        await link.click();
        await check(page).toHaveURL(`${origin}/`);
        check(errors).toEqual([]);
      } catch (error) {
        await writeFile(
          join(evidence, "failure.json"),
          JSON.stringify({ engine, scenario, failure: String(error) }, null, 2),
        );
        console.error(`Missing-orb layout evidence retained: ${evidence}`);
        throw error;
      } finally {
        boot?.dispose();
        try {
          await browser?.close();
        } finally {
          await Promise.all(waits);
          await vite.close();
        }
      }
      await rm(cacheDir, { recursive: true, force: true });
      await rm(evidence, { recursive: true, force: true });
    });
  }
}
