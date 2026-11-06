import { createServer as createFileServer } from "node:http";
import { join } from "node:path";
import type { DisplayHistoryView } from "@pi-orb/protocol";
import { expect as check, chromium, webkit } from "@playwright/test";
import { createServer } from "vite";
import { it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";
import { closeRoutedPage } from "./testkit/close-routed-page.ts";
import { gotoFrontendFixture } from "./testkit/frontend-fixture.ts";

const MARKDOWN =
  "[repo file](orb:README.md) [absolute file](orb:/tmp/space%20%23.html?view=1#section) " +
  "[invalid file](orb:///tmp/no.html) [literal percent file](orb:bad/%) " +
  "[reference file][local]\n\n[local]: orb:docs/guide.md";

it.each(["chromium", "webkit"] as const)(
  "%s: orb file anchors use current orb metadata across cached navigation and native clicks",
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
    if (!address || typeof address === "string") throw new Error("No owned fixture port");
    const files = createFileServer((_request, response) => {
      response.setHeader("content-type", "text/plain");
      response.end("Current file bytes");
    });
    await listenFrontend({ httpServer: files });
    const filesAddress = files.address();
    if (!filesAddress || typeof filesAddress === "string") throw new Error("No owned files port");
    const filesOrigin = `http://127.0.0.1:${filesAddress.port}`;
    const browser = await (engine === "chromium" ? chromium : webkit).launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const origin = `http://127.0.0.1:${address.port}`;
    const orbs = [
      ["frontend-fixture-orb", "11111111-1111-4111-8111-111111111111"],
      ["frontend-long-history", "22222222-2222-4222-8222-222222222222"],
    ] as const;
    try {
      for (const [id, uuid] of orbs) {
        await page.route(`**/api/v1/orbs/${id}`, async (route) => {
          const response = await route.fetch();
          return route.fulfill({
            response,
            json: { ...(await response.json()), filesBaseUrl: `${filesOrigin}/files/${uuid}` },
          });
        });
        await page.route(`**/api/v1/orbs/${id}/history`, async (route) => {
          const response = await route.fetch();
          const view: DisplayHistoryView = await response.json();
          for (const record of view.records) {
            if (record.type === "message" && record.role === "assistant") {
              for (const block of record.content) {
                if (block.type === "text") block.text = MARKDOWN;
              }
            }
          }
          return route.fulfill({ response, json: view });
        });
      }
      await gotoFrontendFixture(page, `${origin}/orbs/${orbs[0][0]}`);
      for (const [id, uuid] of [orbs[0], orbs[1], orbs[0]]) {
        if (!page.url().endsWith(`/orbs/${id}`)) {
          await page.locator(`.orb-index a[href="/orbs/${id}"]`).click();
        }
        await check(page).toHaveURL(`${origin}/orbs/${id}`);
        const links = page.locator(".history");
        const repo = links.getByRole("link", { name: "repo file", exact: true }).last();
        await check(repo).toHaveAttribute("href", `${filesOrigin}/files/repo/${uuid}/README.md`);
        await check(repo).toHaveAttribute("target", "_blank");
        await check(repo).toHaveAttribute("rel", "noopener noreferrer");
        await check(
          links.getByRole("link", { name: "absolute file", exact: true }).last(),
        ).toHaveAttribute(
          "href",
          `${filesOrigin}/files/${uuid}/tmp/space%20%23.html?view=1#section`,
        );
        await check(
          links.getByRole("link", { name: "reference file", exact: true }).last(),
        ).toHaveAttribute("href", `${filesOrigin}/files/repo/${uuid}/docs/guide.md`);
        await check(links.getByRole("link", { name: "invalid file", exact: true })).toHaveCount(0);
        await check(
          links.getByRole("link", { name: "literal percent file", exact: true }).last(),
        ).toHaveAttribute("href", `${filesOrigin}/files/repo/${uuid}/bad/%25`);
        const popupPromise = context.waitForEvent("page");
        await repo.click({ modifiers: ["ControlOrMeta"] });
        const popup = await popupPromise;
        await check(popup).toHaveURL(`${filesOrigin}/files/repo/${uuid}/README.md`);
        await check(popup.locator("body")).toHaveText("Current file bytes");
        await popup.waitForLoadState("networkidle");
        await popup.close();
        await check(page).toHaveURL(`${origin}/orbs/${id}`);
      }
    } finally {
      await closeRoutedPage(page);
      await context.close();
      await browser.close();
      await vite.close();
      await new Promise<void>((resolve) => files.close(() => resolve()));
    }
  },
);
