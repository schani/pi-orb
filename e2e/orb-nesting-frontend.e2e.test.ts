import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { OrbView } from "@pi-orb/protocol";
import { chromium, expect as expectPage, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";
import { gotoFrontendFixture } from "./testkit/frontend-fixture.ts";

const evidence = "/tmp/orb-pad-nesting";
const projectId = "frontend-fixture-project";
const childId = "frontend-fixture-orb";
const orb = (id: string, name: string, spawnedByOrb?: string): OrbView => ({
  id,
  name,
  projectId,
  harness: "pi",
  state: "stopped",
  stateVersion: 1,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  stateChangedAt: "2026-10-01T00:00:00Z",
  ...(spawnedByOrb === undefined ? {} : { spawnedByOrb }),
});
let vite: ViteDevServer;
let browser: Awaited<ReturnType<typeof chromium.launch>>;
let origin: string;

beforeAll(async () => {
  mkdirSync(evidence, { recursive: true });
  const root = join(import.meta.dirname, "../apps/web");
  vite = await createServer({
    root,
    configFile: join(root, "vite.config.ts"),
    mode: "frontend",
    server: { host: "127.0.0.1", port: 0 },
  });
  await listenFrontend(vite);
  const address = vite.httpServer?.address();
  expect(address !== null && address !== undefined && typeof address !== "string").toBe(true);
  origin = `http://127.0.0.1:${(address as { port: number }).port}`;
  browser = await chromium.launch({
    ...(process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"]
      ? { executablePath: process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"] }
      : existsSync("/usr/bin/chromium")
        ? { executablePath: "/usr/bin/chromium" }
        : {}),
    args: ["--no-sandbox"],
  });
});
afterAll(async () => {
  await browser?.close();
  await vite?.close();
});

async function fixture(page: Page, read: () => OrbView[]) {
  await page.route("**/api/v1/projects", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: {
        ...body,
        items: body.items.filter((project: { id: string }) => project.id === projectId),
      },
    });
  });
  await page.route(`**/api/v1/projects/${projectId}/orbs`, (route) =>
    route.fulfill({ json: { items: read() } }),
  );
  await page.route(`**/api/v1/orbs/${childId}`, (route) =>
    route.fulfill({ json: read().find((item) => item.id === childId) }),
  );
}

it.each(["dashboard", "orb"] as const)(
  "%s keeps the working tree expanded and promotes children on authoritative list changes",
  async (view) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const child = orb(childId, "Child", "parent");
    const parent = orb("parent", "Parent");
    let items: OrbView[] = [
      child,
      orb("other", "Other"),
      orb("grandchild", "Grandchild", childId),
      parent,
      orb("sibling", "Sibling", "parent"),
      { ...orb("archived-child", "Archived child", "parent"), state: "archived" },
      orb("released", "Released", "archived-child"),
    ];
    const scope = page.locator(view === "dashboard" ? `#project-${projectId}` : ".ix-project");
    const row = (id: string) => scope.locator(`.orb-tree-row[data-orb-id="${id}"]`);
    const workingNames = scope.locator(".orb-tree .orb-entry-link, .orb-tree .ix-row .trunc");
    const archive = scope.locator(".project-archive");
    const path = view === "dashboard" ? "/" : `/orbs/${childId}`;
    async function publish(next: OrbView[]) {
      const response = page.waitForResponse(
        async (response) =>
          new URL(response.url()).pathname === `/api/v1/projects/${projectId}/orbs` &&
          response.request().method() === "GET" &&
          response.status() === 200 &&
          JSON.stringify((await response.json()).items) === JSON.stringify(next),
      );
      items = next;
      await response;
    }
    async function selectedChild() {
      if (view === "orb") {
        await expectPage(row(childId).locator(".ix-row")).toHaveAttribute("aria-current", "page");
        await expectPage(row(childId).locator(".ix-row")).toHaveCSS(
          "background-color",
          "rgb(0, 0, 0)",
        );
        expect(page.url()).toBe(`${origin}/orbs/${childId}`);
      }
      await expectPage(row(childId).getByRole("link")).toHaveAttribute("href", `/orbs/${childId}`);
      await expectPage(row("grandchild")).toHaveAttribute("data-orb-depth", "1");
    }
    try {
      await fixture(page, () => items);
      await gotoFrontendFixture(page, `${origin}${path}`, scope);
      await expectPage(workingNames).toHaveText([
        "Other",
        "Parent",
        "Child",
        "Grandchild",
        "Sibling",
        "Released",
      ]);
      await expectPage(row(childId)).toHaveAttribute("data-orb-depth", "1");
      await expectPage(row("grandchild")).toHaveAttribute("data-orb-depth", "2");
      await expectPage(
        scope.locator(".orb-tree summary, .orb-tree details, .orb-tree [aria-expanded]"),
      ).toHaveCount(0);
      await expectPage(scope.getByRole("button", { name: /collapse|expand/i })).toHaveCount(0);
      const geometry = await Promise.all(
        ["parent", childId, "grandchild"].map((id) =>
          row(id)
            .getByRole("link")
            .evaluate((element) => element.getBoundingClientRect().left),
        ),
      );
      const parentLeft = geometry[0] ?? Number.NaN;
      expect(geometry).toEqual([parentLeft, parentLeft + 18, parentLeft + 36]);
      const guides = await Promise.all(
        [childId, "grandchild", "sibling"].map((id) =>
          row(id).evaluate((element) => {
            const guide = Reflect.get(globalThis, "getComputedStyle")(element, "::before");
            return {
              left: guide.left,
              width: guide.width,
              height: guide.height,
              image: guide.backgroundImage,
              rowHeight: element.getBoundingClientRect().height,
            };
          }),
        ),
      );
      expect(guides.map((guide) => [guide.left, guide.width])).toEqual([
        ["9px", "10px"],
        ["9px", "28px"],
        ["9px", "10px"],
      ]);
      for (const guide of guides) {
        expect(guide.image).toContain("repeating-linear-gradient");
        expect(Number.parseFloat(guide.height)).toBe(guide.rowHeight);
      }
      await page.screenshot({ path: join(evidence, `${view}-nested.png`), fullPage: true });
      await page.keyboard.press("Meta+k");
      const find = page.getByRole("dialog", { name: "Find projects and orbs" });
      await find.getByRole("searchbox").fill("r");
      await expectPage(
        find.locator('.app-search-result[href^="/orbs/"] .app-search-result-title'),
      ).toHaveText(["Other", "Parent", "Grandchild", "Released", "Archived child"]);
      await page.keyboard.press("Escape");
      await expectPage(archive.locator("summary")).toHaveText("archive · 1");
      await archive.locator("summary").click();
      await expectPage(archive.locator('a[href="/orbs/archived-child"]')).toBeVisible();
      await expectPage(archive.locator(".orb-tree")).toHaveCount(0);
      await archive.locator("summary").click();
      const heldChild = await row(childId).elementHandle();
      await row(childId).getByRole("link").focus();

      await publish(
        items.map((item) =>
          item.id === "parent" ? { ...item, state: "failed", lastError: "fixture failure" } : item,
        ),
      );
      await expectPage(row("parent").locator('img[src="/favicons/failed.svg"]')).toHaveCount(1);
      await expectPage(row(childId)).toHaveAttribute("data-orb-depth", "1");
      await publish(
        items.map((item) =>
          item.id === "other"
            ? { ...item, name: "Refreshed other", updatedAt: "2100-01-01T00:00:00Z" }
            : item,
        ),
      );
      await expectPage(workingNames).toHaveText([
        "Refreshed other",
        "Parent",
        "Child",
        "Grandchild",
        "Sibling",
        "Released",
      ]);

      for (const state of ["archiving", "deleting", "missing"] as const) {
        await publish(
          state === "missing"
            ? items.filter((item) => item.id !== "parent")
            : items.map((item) => (item.id === "parent" ? { ...item, state } : item)),
        );
        await expectPage(row("parent")).toHaveCount(0);
        await expectPage(row(childId)).toHaveAttribute("data-orb-depth", "0");
        await expectPage(row("sibling")).toHaveAttribute("data-orb-depth", "0");
        await selectedChild();
        expect(await heldChild?.evaluate((element) => element.isConnected)).toBe(true);
        await expectPage(row(childId).getByRole("link")).toBeFocused();
        await expectPage(workingNames).toHaveText([
          "Child",
          "Grandchild",
          "Refreshed other",
          "Sibling",
          "Released",
        ]);
        await expectPage(archive.locator("summary")).toHaveText(
          state === "missing" ? "archive · 1" : "archive · 2",
        );
      }
      await page.keyboard.press("Meta+k");
      await find.getByRole("searchbox").fill("r");
      await expectPage(
        find.locator('.app-search-result[href^="/orbs/"] .app-search-result-title'),
      ).toHaveText(["Grandchild", "Refreshed other", "Released", "Archived child"]);
      await page.keyboard.press("Escape");
      await expectPage(row(childId).getByRole("link")).toBeFocused();
      await page.screenshot({ path: join(evidence, `${view}-promoted.png`), fullPage: true });
      await page.keyboard.press("Enter");
      await expectPage(page.locator(`.ix-row[href="/orbs/${childId}"]`)).toHaveAttribute(
        "aria-current",
        "page",
      );
      expect(page.url()).toBe(`${origin}/orbs/${childId}`);
      expect(errors).toEqual([]);
    } catch (cause) {
      const failurePath = join(evidence, `${view}-first-failure.png`);
      if (!existsSync(failurePath)) await page.screenshot({ path: failurePath, fullPage: true });
      throw cause;
    } finally {
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
    }
  },
);

it("contains deep lineage on desktop and phone without hiding rows or changing shelf controls", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const items = Array.from({ length: 32 }, (_, depth) =>
    orb(
      depth === 31 ? childId : `depth-${depth}`,
      `Level ${depth}: a long orb title that must truncate without losing actions`,
      depth === 0 ? undefined : `depth-${depth - 1}`,
    ),
  );
  try {
    await fixture(page, () => items);
    for (const width of [1280, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const path of ["/", `/orbs/${childId}`]) {
        await gotoFrontendFixture(page, `${origin}${path}`);
        const dashboard = path === "/";
        const tree = page.locator(dashboard ? ".project-column .orb-tree" : ".orb-index .orb-tree");
        await expectPage(tree.locator(".orb-tree-row")).toHaveCount(32);
        await expectPage(tree.locator(".orb-tree-row").last()).toHaveAttribute(
          "data-orb-depth",
          "31",
        );
        if (!dashboard && width <= 600) {
          await expectPage(page.locator(".orb-index")).toBeHidden();
        } else {
          const contained = await tree.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            const rows = element.querySelectorAll(".orb-entry, .ix-row") as ArrayLike<{
              getBoundingClientRect(): { right: number; width: number };
            }>;
            return Array.from(rows).every((row) => {
              const box = row.getBoundingClientRect();
              return box.right <= bounds.right + 1 && box.width >= bounds.width * 0.59;
            });
          });
          expect(contained).toBe(true);
          if (dashboard) {
            const target = tree.getByRole("button", { name: /^Delete Level 31:/ });
            await expectPage(target).toBeVisible();
            const box = await target.boundingBox();
            expect(box?.width).toBe(20);
          }
          await expectPage(tree.locator("summary, details, [aria-expanded]")).toHaveCount(0);
        }
        expect(
          await page.evaluate(() => {
            const root = Reflect.get(globalThis, "document").documentElement;
            return root.scrollWidth <= root.clientWidth;
          }),
        ).toBe(true);
        await page.screenshot({
          path: join(evidence, `${width}-${dashboard ? "dashboard" : "orb"}-deep.png`),
          fullPage: true,
        });
      }
    }
  } catch (cause) {
    const failurePath = join(evidence, "deep-first-failure.png");
    if (!existsSync(failurePath)) await page.screenshot({ path: failurePath, fullPage: true });
    throw cause;
  } finally {
    await page.unrouteAll({ behavior: "wait" });
    await page.close();
  }
});
