import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type OrbView, OrbViewSchema, type ProjectView, type SessionProbe } from "@pi-orb/protocol";
import { chromium, expect as expectPage, webkit } from "@playwright/test";
import Fastify from "fastify";
import { Errors } from "typebox/value";
import { build } from "vite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { registerWebAssets } from "../apps/control-plane/src/http/web-assets.ts";

const root = mkdtempSync(join(tmpdir(), "pi-orb-built-shell-"));
const app = Fastify({ logger: false });
let browser: Awaited<ReturnType<typeof chromium.launch>>;

beforeAll(async () => {
  await build({
    root: join(import.meta.dirname, "../apps/web"),
    configFile: join(import.meta.dirname, "../apps/web/vite.config.ts"),
    build: { outDir: root, emptyOutDir: true },
  });
  app.get(
    "/api/v1/session",
    (): SessionProbe => ({
      status: "ok",
      principal: { kind: "user", user: { id: "built-shell-user", email: null } },
    }),
  );
  await registerWebAssets(app, root);
  await app.listen({ host: "127.0.0.1", port: 0 });
  browser = await chromium.launch({
    ...(process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"]
      ? { executablePath: process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"] }
      : existsSync("/usr/bin/chromium")
        ? { executablePath: "/usr/bin/chromium" }
        : {}),
    args: ["--no-sandbox"],
  });
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

it.each(["/", "/orbs/missing-orb"])(
  "%s freezes orb ordering across polls, but not activity or reload",
  async (path) => {
    const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const page = await browser.newPage();
    const project = {
      id: "ordering",
      name: "Ordering",
      state: "active",
      repositoryUrl: "https://github.com/example/ordering",
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
    };
    const older = {
      id: "older",
      projectId: project.id,
      harness: "pi",
      name: "Older",
      state: "running",
      stateVersion: 1,
      stateChangedAt: project.createdAt,
      createdAt: project.createdAt,
      updatedAt: "2026-10-02T00:00:00Z",
      activity: "idle",
    } satisfies OrbView;
    const newer = { ...older, id: "newer", name: "Newer", updatedAt: "2026-10-03T00:00:00Z" };
    let items: OrbView[] = [older, newer];
    for (const item of items) expect([...Errors(OrbViewSchema, item)]).toEqual([]);
    const rows = path === "/" ? ".orb-entry-link" : ".ix-row .trunc";
    try {
      await page.route("**/api/v1/projects", (route) =>
        route.fulfill({ json: { items: [project] } }),
      );
      await page.route("**/api/v1/projects/ordering/orbs", (route) =>
        route.fulfill({ json: { items } }),
      );
      await page.goto(`${origin}${path}`);
      await expectPage(page.locator(rows)).toHaveText(["Newer", "Older"]);
      items = [
        { ...older, name: "Refreshed", activity: "busy", updatedAt: "2100-01-01T00:00:00Z" },
        newer,
      ];
      await expectPage(page.locator(rows).filter({ hasText: "Refreshed" })).toHaveCount(1);
      await expectPage(page.locator(rows)).toHaveText(["Newer", "Refreshed"]);
      const refreshedRow = page.locator(path === "/" ? ".orb-entry" : ".ix-row", {
        hasText: "Refreshed",
      });
      await expectPage(refreshedRow.locator('img[src="/favicons/busy.svg"]')).toHaveCount(1);
      await expectPage(
        refreshedRow.locator(path === "/" ? ".orb-entry-meta > span:first-child" : ".ix-age"),
      ).toHaveText("1s");
      await page.reload();
      await expectPage(page.locator(rows)).toHaveText(["Refreshed", "Newer"]);
    } finally {
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
    }
  },
);

it("prioritizes running, sleeping, then other working projects ahead of empty/archive-only projects across polls", async () => {
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const page = await browser.newPage();
  await page.clock.install();
  const projects: ProjectView[] = ["Archive", "Stopped", "Empty", "Idle", "Live", "Failed"].map(
    (name) => ({
      id: name.toLowerCase(),
      name,
      state: "active",
      repositoryUrl: "https://github.com/example/ordering",
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
    }),
  );
  const makeOrb = (projectId: string, state: OrbView["state"]): OrbView => ({
    id: `${projectId}-${state}`,
    projectId,
    harness: "pi",
    name: `${projectId} ${state}`,
    state,
    stateVersion: 1,
    stateChangedAt: "2026-10-01T00:00:00Z",
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
  });
  let incoming = projects;
  const lists: Record<string, OrbView[]> = {
    archive: (["archived", "archiving", "deleting"] as const).map((s) => makeOrb("archive", s)),
    stopped: [{ ...makeOrb("stopped", "stopped"), sleepUntil: "2100-01-01T00:00:00Z" }],
    empty: [],
    idle: [{ ...makeOrb("idle", "running"), activity: "idle" }],
    live: [
      { ...makeOrb("live", "running"), activity: "busy" },
      { ...makeOrb("live", "stopped"), sleepUntil: "2100-01-01T00:00:00Z" },
    ],
    failed: (["failed", "creating", "starting", "stopping"] as const).map((s) => ({
      ...makeOrb("failed", s),
      sleepUntil: "2100-01-01T00:00:00Z",
    })),
  };
  try {
    await page.route("**/api/v1/projects", (route) => route.fulfill({ json: { items: incoming } }));
    await page.route("**/api/v1/projects/*/orbs", (route) => {
      const id = route.request().url().split("/").at(-2) ?? "";
      return route.fulfill({ json: { items: lists[id] ?? [] } });
    });
    await page.goto(`${origin}/orbs/missing-orb`);
    const sections = page.locator(".orb-index .ix-project");
    const names = sections.locator(".project-name");
    await expectPage(names).toHaveText(["Idle", "Live", "Stopped", "Failed", "Archive", "Empty"]);
    const stoppedSection = await page
      .getByRole("region", { name: "Stopped", exact: true })
      .elementHandle();
    incoming = [...projects].reverse();
    lists.archive = [makeOrb("archive", "running")];
    lists.idle = [{ ...makeOrb("idle", "stopped"), sleepUntil: "2100-01-01T00:00:00Z" }];
    await page.clock.runFor(2000);
    await expectPage(names).toHaveText(["Archive", "Live", "Stopped", "Idle", "Failed", "Empty"]);
    expect(await stoppedSection?.evaluate((node) => node.isConnected)).toBe(true);
    lists.archive = [makeOrb("archive", "archived")];
    lists.stopped = [makeOrb("stopped", "stopped")];
    lists.idle = [{ ...makeOrb("idle", "running"), activity: "busy" }];
    await page.clock.runFor(2000);
    await expectPage(names).toHaveText(["Idle", "Live", "Stopped", "Failed", "Archive", "Empty"]);
  } finally {
    await page.unrouteAll({ behavior: "wait" });
    await page.close();
  }
});

it("freezes dashboard project order after list loading, while polling metadata and resetting on reload", async () => {
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const page = await browser.newPage();
  const olderProject = {
    id: "older-project",
    name: "Older project",
    state: "active" as const,
    repositoryUrl: "https://github.com/example/ordering",
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
  };
  const newerProject = { ...olderProject, id: "newer-project", name: "Newer project" };
  const older: OrbView = {
    id: "older",
    projectId: olderProject.id,
    harness: "pi",
    name: "Older",
    state: "running",
    stateVersion: 1,
    stateChangedAt: olderProject.createdAt,
    createdAt: olderProject.createdAt,
    updatedAt: "2026-10-02T00:00:00Z",
    activity: "idle",
  };
  const newer = {
    ...older,
    id: "newer",
    projectId: newerProject.id,
    name: "Newer",
    updatedAt: "2026-10-03T00:00:00Z",
  };
  let projects: ProjectView[] = [olderProject, newerProject];
  let olderItems = [older];
  let releaseLists!: () => void;
  const listsReady = new Promise<void>((resolve) => {
    releaseLists = resolve;
  });
  try {
    await page.route("**/api/v1/projects", (route) => route.fulfill({ json: { items: projects } }));
    await page.route("**/api/v1/projects/older-project/orbs", async (route) => {
      await listsReady;
      await route.fulfill({ json: { items: olderItems } });
    });
    await page.route("**/api/v1/projects/newer-project/orbs", async (route) => {
      await listsReady;
      await route.fulfill({ json: { items: [newer] } });
    });
    await page.goto(origin);
    await expectPage(page.locator(".dashboard-total").first()).toContainText("2");
    await expectPage(page.locator(".project-column")).toHaveCount(0);
    releaseLists();
    const headings = page.locator(".project-column .project-name");
    await expectPage(headings).toHaveText(["Newer project", "Older project"]);
    olderItems = [
      { ...older, name: "Fresh work", activity: "busy", updatedAt: "2100-01-01T00:00:00Z" },
    ];
    projects = [{ ...olderProject, name: "Renamed project" }, newerProject];
    await expectPage(page.locator(".orb-entry-link").filter({ hasText: "Fresh work" })).toHaveCount(
      1,
    );
    await expectPage(headings).toHaveText(["Newer project", "Renamed project"]);
    await expectPage(
      page.locator("#project-older-project img[src='/favicons/busy.svg']"),
    ).toHaveCount(1);
    projects = [
      { ...olderProject, name: "Renamed project" },
      { ...newerProject, name: "Deleting project", state: "deleting" },
    ];
    await expectPage(page.locator("#project-newer-project")).toHaveClass(
      "project-column project-column-deleting",
    );
    await expectPage(headings).toHaveText(["Deleting project", "Renamed project"]);
    await page.reload();
    await expectPage(headings).toHaveText(["Renamed project", "Deleting project"]);
  } finally {
    releaseLists();
    await page.unrouteAll({ behavior: "wait" });
    await page.close();
  }
});

it.each(["schani/pi-orb", "github.com/schani/pi-orb"])(
  "creates a project from GitHub shorthand %s with a canonical API URL",
  async (repositoryUrl) => {
    const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const page = await browser.newPage();
    const submissions: { id: string; name: string; repositoryUrl: string }[] = [];
    try {
      await page.route("**/api/v1/projects", async (route) => {
        if (route.request().method() === "POST") {
          const body = route.request().postDataJSON();
          submissions.push(body);
          await route.fulfill({
            status: 201,
            json: {
              ...body,
              state: "active",
              createdAt: "2026-10-05T00:00:00Z",
              updatedAt: "2026-10-05T00:00:00Z",
            },
          });
          return;
        }
        await route.fulfill({ json: { items: [] } });
      });
      const projectsLoaded = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/v1/projects" &&
          response.request().method() === "GET",
      );
      await page.goto(origin);
      await projectsLoaded;
      await page.getByRole("textbox", { name: "project name", exact: true }).fill("Pi Orb");
      const repository = page.getByRole("textbox", { name: "repository URL", exact: true });
      await repository.fill(repositoryUrl);
      await page.getByRole("button", { name: "Create project", exact: true }).click();
      await expectPage(repository).toHaveValue("");
      expect(submissions).toHaveLength(1);
      expect(submissions[0]).toMatchObject({
        name: "Pi Orb",
        repositoryUrl: "https://github.com/schani/pi-orb",
      });
    } finally {
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
    }
  },
);

it("boots the production shell and loads built assets and install metadata on direct deep links and reload", async () => {
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const page = await browser.newPage();
  const responses: { path: string; status: number }[] = [];
  page.on("response", (response) =>
    responses.push({ path: new URL(response.url()).pathname, status: response.status() }),
  );
  try {
    await page.goto(`${origin}/orbs/missing-orb`);
    await expectPage(page.getByText("Orb doesn't exist")).toBeVisible();
    await page.reload();
    await expectPage(page.getByText("Orb doesn't exist")).toBeVisible();
    expect(page.url()).toBe(`${origin}/orbs/missing-orb`);
    const fontsLoaded = await page.locator("body").evaluate(async (body) => {
      const fonts = body.ownerDocument.fonts;
      const faces = await Promise.all([
        fonts.load('13px "Iosevka Etoile"'),
        fonts.load('13px "JetBrains Mono"'),
      ]);
      return faces.every(
        (family: { status: string }[]) =>
          family.length > 0 && family.every((face) => face.status === "loaded"),
      );
    });
    expect(fontsLoaded).toBe(true);
    expect(
      responses.filter(({ path, status }) => path.endsWith(".woff2") && status === 200).length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      responses.some(({ path, status }) => path.startsWith("/assets/") && status === 200),
    ).toBe(true);
    const favicon = await page.locator('link[rel="icon"]').getAttribute("href");
    expect(favicon).toBeTruthy();
    expect((await page.request.get(`${origin}${favicon}`)).status()).toBe(200);
    const manifestLink = page.locator('link[rel="manifest"]');
    await expectPage(manifestLink).toHaveAttribute("href", "/manifest.webmanifest");
    await expectPage(manifestLink).toHaveAttribute("crossorigin", "use-credentials");
    const manifestResponse = await page.request.get(`${origin}/manifest.webmanifest`);
    expect(manifestResponse.status()).toBe(200);
    expect(manifestResponse.headers()["content-type"]).toContain("application/manifest+json");
    const manifest = await manifestResponse.json();
    expect(manifest).toMatchObject({
      id: "/",
      scope: "/",
      start_url: "/",
      display: "standalone",
      theme_color: "#ffffff",
      background_color: "#ffffff",
    });
    const appleIcon = page.locator('link[rel="apple-touch-icon"]');
    await expectPage(appleIcon).toHaveAttribute("href", "/favicons/apple-touch-icon.png");
    const iconSizes = [
      ["/favicons/apple-touch-icon.png", 180],
      ...manifest.icons.map((icon: { src: string; sizes: string }) => [
        icon.src,
        Number(icon.sizes.split("x")[0]),
      ]),
    ] as [string, number][];
    expect(iconSizes).toEqual([
      ["/favicons/apple-touch-icon.png", 180],
      ["/favicons/app-192.png", 192],
      ["/favicons/app-512.png", 512],
    ]);
    for (const [path, size] of iconSizes) {
      const response = await page.request.get(`${origin}${path}`);
      expect(response.status()).toBe(200);
      expect(response.headers()["content-type"]).toContain("image/png");
      const dimensions = await page.locator("body").evaluate(async (body, src) => {
        const image = body.ownerDocument.createElement("img");
        image.src = src;
        await image.decode();
        return [image.naturalWidth, image.naturalHeight];
      }, path);
      expect(dimensions).toEqual([size, size]);
    }
    for (const path of ["/manifest.webmanifest", ...iconSizes.map(([path]) => path)]) {
      const head = await page.request.head(`${origin}${path}`);
      expect(head.status()).toBe(200);
      expect(await head.body()).toHaveLength(0);
    }
    for (const path of ["/missing.webmanifest", "/favicons/missing.png"]) {
      for (const method of ["GET", "HEAD"] as const) {
        const response = await page.request.fetch(`${origin}${path}`, { method });
        expect(response.status()).toBe(404);
        expect(await response.text()).not.toContain('<div id="root">');
      }
    }
    expect(responses.some(({ path, status }) => path.endsWith(".js") && status === 200)).toBe(true);
    expect(responses.some(({ path, status }) => path.endsWith(".css") && status === 200)).toBe(
      true,
    );
    await page.route("**/api/v1/projects", (route) => route.fulfill({ json: { items: [] } }));
    await page.goto(`${origin}/projects/missing-project`);
    await expectPage(page.getByText("Project doesn't exist")).toBeVisible();
    expect(page.url()).toBe(`${origin}/projects/missing-project`);
    await expectPage(page.getByRole("link", { name: "Back to dashboard" })).toHaveAttribute(
      "href",
      "/",
    );
    await page.goto(`${origin}/unrecognized`);
    await expectPage(page.getByText("Page doesn't exist")).toBeVisible();
    expect(page.url()).toBe(`${origin}/unrecognized`);
    await expectPage(page.getByRole("link", { name: "Back to dashboard" })).toHaveAttribute(
      "href",
      "/",
    );
  } finally {
    await page.close();
  }
});

it.each(["chromium", "webkit"] as const)(
  "%s: the status-bar band qualifies for WebKit's solid status bar without painting or hit testing",
  async (engine) => {
    const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const engineBrowser = engine === "webkit" ? await webkit.launch() : browser;
    const page = await engineBrowser.newPage({ viewport: { width: 1180, height: 820 } });
    try {
      await page.goto(`${origin}/unrecognized`);
      await expectPage(page.getByText("Page doesn't exist")).toBeVisible();
      const band = page.locator(".status-bar-band");
      const geometry = await band.evaluate((element) => {
        const view = element.ownerDocument.defaultView;
        const style = view.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          position: style.position,
          zIndex: style.zIndex,
          backgroundColor: style.backgroundColor,
          pointerEvents: style.pointerEvents,
          top: rect.top,
          widthShare: rect.width / view.innerWidth,
          height: rect.height,
          hit: element.ownerDocument.elementFromPoint(view.innerWidth / 2, 4) === element,
        };
      });
      expect(geometry).toEqual({
        position: "fixed",
        zIndex: "2147483647",
        backgroundColor: "rgb(255, 255, 255)",
        pointerEvents: "none",
        top: 0,
        widthShare: 1,
        height: 12,
        hit: false,
      });
      const withBand = await page.screenshot({ animations: "disabled" });
      // A black backdrop makes any band paint visible.
      const backdrop = await page.evaluateHandle(() => {
        const document = Reflect.get(globalThis, "document");
        const element = document.createElement("div");
        element.style.cssText = "position:fixed;top:0;left:0;right:0;height:24px;background:#000";
        return document.body.appendChild(element);
      });
      const clip = { x: 0, y: 0, width: 1180, height: 24 };
      const backdropWithBand = await page.screenshot({ clip, animations: "disabled" });
      await band.evaluate((element) => {
        element.style.display = "none";
      });
      expect(await page.screenshot({ clip, animations: "disabled" })).toEqual(backdropWithBand);
      await backdrop.evaluate((element) => element.remove());
      expect(await page.screenshot({ animations: "disabled" })).toEqual(withBand);
    } finally {
      await page.close();
      if (engineBrowser !== browser) await engineBrowser.close();
    }
  },
);

it.each(["chromium", "webkit"] as const)(
  "%s: retains dashboard rows on return, refreshes them, and isolates principals",
  async (engine) => {
    const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const engineBrowser = engine === "webkit" ? await webkit.launch() : browser;
    const page = await engineBrowser.newPage();
    const project: ProjectView = {
      id: "snapshot",
      name: "Cached project",
      state: "active",
      repositoryUrl: null,
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
    };
    const orb: OrbView = {
      id: "cached-orb",
      projectId: project.id,
      name: "Cached orb",
      harness: "pi",
      state: "stopped",
      stateVersion: 1,
      stateChangedAt: project.createdAt,
      createdAt: project.createdAt,
      updatedAt: project.createdAt,
    };
    let projects = [project];
    let orbs = [orb];
    let principal = "alice";
    let releaseProjects!: () => void;
    const projectsGate = new Promise<void>((resolve) => {
      releaseProjects = resolve;
    });
    let releaseOrbs!: () => void;
    const orbsGate = new Promise<void>((resolve) => {
      releaseOrbs = resolve;
    });
    let held = false;
    try {
      await page.clock.install();
      await page.route("**/api/v1/session", (route) =>
        route.fulfill({
          json: {
            status: "ok",
            principal: { kind: "user", user: { id: principal, email: null } },
          },
        }),
      );
      await page.route("**/api/v1/projects", async (route) => {
        if (held) await projectsGate;
        await route.fulfill({ json: { items: projects } });
      });
      await page.route("**/api/v1/projects/snapshot/orbs", async (route) => {
        if (held) await orbsGate;
        await route.fulfill({ json: { items: orbs } });
      });
      await page.goto(origin);
      const headings = page.locator(".project-column .project-name");
      const rows = page.locator(".orb-entry-link");
      await expectPage(headings).toHaveText(["Cached project"]);
      await expectPage(rows).toHaveText(["Cached orb"]);
      await page.getByRole("link", { name: "Token usage", exact: true }).click();
      await expectPage(page.locator(".projects-page")).toHaveCount(0);
      held = true;
      projects = [{ ...project, name: "Fresh project" }];
      orbs = [{ ...orb, id: "fresh-orb", name: "Fresh orb" }];
      const projectRead = page.waitForRequest("**/api/v1/projects");
      await page.getByRole("link", { name: "Dashboard", exact: true }).click();
      await projectRead;
      await expectPage(headings).toHaveText(["Cached project"]);
      await expectPage(rows).toHaveText(["Cached orb"]);
      const orbRead = page.waitForRequest("**/api/v1/projects/snapshot/orbs");
      releaseProjects();
      await orbRead;
      await expectPage(headings).toHaveText(["Fresh project"]);
      await expectPage(rows).toHaveText(["Cached orb"]);
      releaseOrbs();
      await expectPage(rows).toHaveText(["Fresh orb"]);

      const principalGate = new Promise<void>((resolve) => {
        releaseProjects = resolve;
      });
      await page.route("**/api/v1/projects", async (route) => {
        await principalGate;
        await route.fulfill({ json: { items: [] } });
      });
      principal = "bob";
      const isolatedRead = page.waitForRequest("**/api/v1/projects");
      await page.evaluate("window.dispatchEvent(new Event('focus'))");
      await isolatedRead;
      await expectPage(headings).toHaveCount(0);
      await expectPage(rows).toHaveCount(0);
      releaseProjects();
      await expectPage(page.locator(".dashboard-total").first()).toHaveText("0projects");
    } finally {
      releaseProjects();
      releaseOrbs();
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
      if (engineBrowser !== browser) await engineBrowser.close();
    }
  },
);
