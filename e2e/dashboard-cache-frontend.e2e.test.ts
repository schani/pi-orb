import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OrbView, ProjectView } from "@pi-orb/protocol";
import { type Browser, chromium, expect as expectPage, type Page, webkit } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";
import { closeRoutedPage } from "./testkit/close-routed-page.ts";
import { gotoFrontendFixture } from "./testkit/frontend-fixture.ts";

const projectId = "frontend-fixture-project";
const orbId = "frontend-fixture-orb";
const project: ProjectView = {
  id: projectId,
  name: "Cached project",
  repositoryUrl: null,
  state: "active",
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
};
const orb: OrbView = {
  id: orbId,
  name: "Cached orb",
  projectId,
  harness: "pi",
  state: "stopped",
  stateVersion: 1,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  stateChangedAt: "2026-10-01T00:00:00Z",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function gate() {
  const entered = deferred<void>();
  const released = deferred<void>();
  return {
    entered: entered.promise,
    arrive: entered.resolve,
    wait: released.promise,
    release: released.resolve,
  };
}
let vite: ViteDevServer;
let origin: string;
beforeAll(async () => {
  const root = join(import.meta.dirname, "../apps/web");
  vite = await createServer({
    root,
    configFile: join(root, "vite.config.ts"),
    mode: "frontend",
    cacheDir: join(root, "node_modules/.vite-test/dashboard-cache"),
    server: { host: "127.0.0.1", port: 0 },
  });
  await listenFrontend(vite);
  const address = vite.httpServer?.address();
  expect(address !== null && address !== undefined && typeof address !== "string").toBe(true);
  origin = `http://127.0.0.1:${(address as { port: number }).port}`;
});
afterAll(async () => {
  await vite?.close();
});

describe.each(["chromium", "webkit"] as const)("%s dashboard cache", (engine) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await (engine === "chromium" ? chromium : webkit).launch();
  });
  afterAll(async () => {
    await browser?.close();
  });

  async function fixture(
    name: string,
    run: (
      page: Page,
      data: {
        items: OrbView[];
        projects: ProjectView[];
        failOrbs: boolean;
        projectsGate: ReturnType<typeof gate> | null;
        orbsGate: ReturnType<typeof gate> | null;
        orbReads: number;
      },
    ) => Promise<void>,
  ) {
    const evidence = join(import.meta.dirname, "../.context/dashboard-cache", `${engine}-${name}`);
    mkdirSync(evidence, { recursive: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    const page = await context.newPage();
    const gates: ReturnType<typeof gate>[] = [];
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const data = {
      items: [orb],
      projects: [project],
      failOrbs: false,
      projectsGate: null as ReturnType<typeof gate> | null,
      orbsGate: null as ReturnType<typeof gate> | null,
      orbReads: 0,
    };
    await page.clock.install();
    await page.route("**/api/v1/projects", async (route) => {
      const held = data.projectsGate;
      const items = data.projects;
      if (held !== null) {
        gates.push(held);
        held.arrive();
        await held.wait;
      }
      await route.fulfill({ json: { items } });
    });
    await page.route(`**/api/v1/projects/${projectId}/orbs`, async (route) => {
      data.orbReads += 1;
      const held = data.orbsGate;
      const items = data.items;
      const failed = data.failOrbs;
      if (held !== null) {
        gates.push(held);
        held.arrive();
        await held.wait;
      }
      await route.fulfill(
        failed
          ? {
              status: 503,
              json: {
                error: { code: "unavailable", message: "held fixture failure", retryable: true },
              },
            }
          : { json: { items } },
      );
    });
    await page.route(`**/api/v1/orbs/${orbId}`, (route) => route.fulfill({ json: orb }));
    try {
      await gotoFrontendFixture(page, `${origin}/`, page.locator(".orb-entry-link"));
      await expectPage(page.locator(".orb-entry-link")).toHaveText("Cached orb");
      await run(page, data);
      expect(errors).toEqual([]);
    } catch (error) {
      writeFileSync(join(evidence, "failure.txt"), `${String(error)}\n${errors.join("\n")}`);
      await page.screenshot({ path: join(evidence, "failure.png"), fullPage: true });
      throw error;
    } finally {
      for (const held of [...gates, data.projectsGate, data.orbsGate]) held?.release();
      await context.tracing.stop({ path: join(evidence, "trace.zip") });
      await closeRoutedPage(page);
      await context.close();
    }
  }

  it("paints the latest index snapshot before held return reads, then refreshes and retains rows on error", async () => {
    await fixture("return-refresh", async (page, data) => {
      data.items = [{ ...orb, name: "Index latest" }];
      await page.locator(".orb-entry-link").click();
      await expectPage(page.locator(".ix-row .trunc")).toHaveText("Index latest");
      data.projectsGate = gate();
      data.orbsGate = gate();
      data.items = [{ ...orb, name: "Dashboard fresh", activity: "busy", state: "running" }];
      await page.locator(".ix-brand").click();
      await data.projectsGate.entered;
      await expectPage(page.locator(".orb-entry-link")).toHaveText("Index latest");
      await expectPage(page.locator(".dashboard-total").nth(1)).toHaveText("1orb");
      data.projectsGate.release();
      data.projectsGate = null;
      await data.orbsGate.entered;
      await expectPage(page.locator(".orb-entry-link")).toHaveText("Index latest");
      data.orbsGate.release();
      data.orbsGate = null;
      await expectPage(page.locator(".orb-entry-link")).toHaveText("Dashboard fresh");
      await expectPage(page.locator(".dashboard-total").nth(2)).toHaveText("1busy");
      data.failOrbs = true;
      await page.clock.runFor(2_000);
      await expectPage(page.locator(".project-column-error")).toContainText("failed to load orbs");
      await expectPage(page.locator(".orb-entry-link")).toHaveText("Dashboard fresh");
      await page.keyboard.press("Meta+k");
      const find = page.getByRole("dialog", { name: "Find projects and orbs" });
      await find.getByRole("searchbox").fill("Dashboard fresh");
      await expectPage(find.locator(".app-search-result-title")).toHaveText("Dashboard fresh");
      await expectPage(find).toContainText("Some orbs could not be searched");
      await page.keyboard.press("Escape");
      data.failOrbs = false;
      data.items = [];
      await page.clock.runFor(2_000);
      await expectPage(page.locator(".project-column-error")).toHaveCount(0);
      await expectPage(page.locator(".orb-entry-link")).toHaveCount(0);
      await expectPage(page.locator(".dashboard-total").nth(1)).toHaveText("0orbs");
    });
  });

  it("singleflights polls and rejects a read released after navigation", async () => {
    await fixture("unmount-fence", async (page, data) => {
      data.items = [{ ...orb, name: "Late stale read" }];
      data.orbsGate = gate();
      await page.clock.runFor(2_000);
      await data.orbsGate.entered;
      const reads = data.orbReads;
      await page.clock.runFor(6_000);
      expect(data.orbReads).toBe(reads);
      await page.getByRole("link", { name: "Token usage" }).click();
      await expectPage(page.locator(".projects-page")).toHaveCount(0);
      const delivered = page.waitForResponse(`**/api/v1/projects/${projectId}/orbs`);
      data.orbsGate.release();
      data.orbsGate = null;
      await delivered;
      data.projectsGate = gate();
      await page.evaluate(
        'history.pushState(null, "", "/"); dispatchEvent(new PopStateEvent("popstate"));',
      );
      await data.projectsGate.entered;
      await expectPage(page.locator(".orb-entry-link")).toHaveText("Cached orb");
    });
  });

  it("does not duplicate a project already observed before its create response", async () => {
    await fixture("project-create", async (page, data) => {
      const posted = deferred<ProjectView>();
      const held = gate();
      await page.route("**/api/v1/projects", async (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        const request = route.request().postDataJSON();
        const created = { ...project, id: request.id, name: request.name };
        posted.resolve(created);
        await held.wait;
        await route.fulfill({ json: created });
      });
      try {
        await page.getByRole("textbox", { name: "project name" }).fill("Created project");
        await page.getByRole("button", { name: "Create project", exact: true }).click();
        const created = await posted.promise;
        data.projects = [project, created];
        await page.route(`**/api/v1/projects/${created.id}/orbs`, (route) =>
          route.fulfill({ json: { items: [] } }),
        );
        await page.clock.runFor(2_000);
        await expectPage(
          page.locator(".project-name").filter({ hasText: "Created project" }),
        ).toHaveCount(1);
        data.projectsGate = gate();
        const accepted = page.waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            new URL(response.url()).pathname === "/api/v1/projects",
        );
        held.release();
        await accepted;
        await data.projectsGate.entered;
        await expectPage(
          page.getByRole("button", { name: "Create project", exact: true }),
        ).toBeEnabled();
        await expectPage(page.locator(".dashboard-total").first()).toHaveText("2projects");
        await expectPage(
          page.locator(".project-name").filter({ hasText: "Created project" }),
        ).toHaveCount(1);
      } finally {
        held.release();
      }
    });
  });

  it.each(["dashboard", "orb"] as const)(
    "keeps a %s archive mutation across return and fences older reads",
    async (view) => {
      await fixture(`${view}-mutation`, async (page, data) => {
        data.orbsGate = gate();
        if (view === "orb") {
          await page.locator(".orb-entry-link").click();
        } else {
          await page.clock.runFor(2_000);
        }
        await data.orbsGate.entered;
        const changed = { ...orb, name: "Accepted archive", state: "archiving" };
        await page.route(`**/api/v1/orbs/${orbId}/archive`, (route) =>
          route.fulfill({ json: changed }),
        );
        page.once("dialog", (dialog) => dialog.accept());
        const accepted = page.waitForResponse(`**/api/v1/orbs/${orbId}/archive`);
        await page
          .getByRole("button", {
            name: view === "orb" ? "Archive orb" : "Archive Cached orb",
            exact: true,
          })
          .click();
        await accepted;
        if (view === "orb") {
          await expectPage(
            page.getByRole("button", { name: "Archive orb", exact: true }),
          ).toBeDisabled();
        } else {
          await expectPage(page.locator(".project-archive summary")).toHaveText("archive · 1");
        }
        const stale = page.waitForResponse(`**/api/v1/projects/${projectId}/orbs`);
        data.orbsGate.release();
        data.orbsGate = null;
        await stale;
        data.projectsGate = gate();
        if (view === "orb") {
          await page.locator(".ix-brand").click();
        } else {
          await page.getByRole("link", { name: "Token usage" }).click();
          await page.evaluate(
            'history.pushState(null, "", "/"); dispatchEvent(new PopStateEvent("popstate"));',
          );
        }
        await data.projectsGate.entered;
        await expectPage(page.locator(".orb-tree .orb-entry-link")).toHaveCount(0);
        await expectPage(page.locator(".project-archive summary")).toHaveText("archive · 1");
        await page.locator(".project-archive summary").click();
        await expectPage(page.locator(".project-archive .orb-entry-link")).toHaveText(
          "Accepted archive",
        );
      });
    },
  );

  it("does not reuse a previous principal's snapshot", async () => {
    await fixture("principal-reset", async (page, data) => {
      data.projectsGate = gate();
      data.projects = [];
      await page.route("**/api/v1/session", (route) =>
        route.fulfill({
          json: {
            status: "ok",
            logoutAvailable: true,
            principal: {
              kind: "user",
              user: { id: "00000000-0000-4000-8000-000000000002", email: "other@local" },
            },
          },
        }),
      );
      await page.evaluate('dispatchEvent(new Event("focus"))');
      await data.projectsGate.entered;
      await expectPage(page.locator(".project-column")).toHaveCount(0);
      await expectPage(page.locator(".dashboard-total").nth(1)).toHaveText("0orbs");
      data.projectsGate.release();
      data.projectsGate = null;
      await expectPage(page.locator(".project-column")).toHaveCount(0);
    });
  });
});
