import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ClientFrame,
  DisplayHistoryViewSchema,
  type HistoryRecord,
  type OrbView,
  OrbViewSchema,
  type ProjectView,
  projectDisplayRecords,
  type ServerFrame,
  type SessionProbe,
} from "@pi-orb/protocol";
import { chromium, expect as expectPage, webkit } from "@playwright/test";
import Fastify from "fastify";
import { Errors } from "typebox/value";
import { build } from "vite";
import { afterAll, beforeAll, expect, it, onTestFinished } from "vitest";
import { registerWebAssets } from "../apps/control-plane/src/http/web-assets.ts";
import { diagramFixtureRecords } from "../apps/web/dev/diagram-fixtures.ts";
import { gotoFrontendHistory } from "./testkit/frontend-fixture.ts";

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

it.each([
  { source: "click", open: false, existingArchive: true },
  { source: "poll", open: false, existingArchive: true },
  { source: "click", open: true, existingArchive: true },
  { source: "poll", open: true, existingArchive: true },
  { source: "poll", open: false, existingArchive: false },
  { source: "click", open: false, existingArchive: false },
  { source: "delete", open: false, existingArchive: true },
  { source: "delete", open: false, existingArchive: false },
  { source: "delete", open: true, existingArchive: true },
  { source: "cancel", open: false, existingArchive: true },
  { source: "reject", open: false, existingArchive: true },
  { source: "pending", open: false, existingArchive: true },
])(
  "keeps archive disclosure state on $source (open=$open, existing=$existingArchive)",
  async ({ source, open, existingArchive }) => {
    const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const page = await browser.newPage();
    await page.clock.install();
    const project: ProjectView = {
      id: "archival",
      name: "Archival",
      state: "active",
      repositoryUrl: null,
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
    };
    let selected: OrbView = {
      id: "selected",
      projectId: project.id,
      harness: "pi",
      name: "Selected",
      state: "stopped",
      stateVersion: 1,
      stateChangedAt: project.createdAt,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    };
    const archived: OrbView = { ...selected, id: "old", name: "Old", state: "archived" };
    let archiveRequests = 0;
    let releaseMetadata = () => {};
    const metadataGate = new Promise<void>((resolve) => {
      releaseMetadata = resolve;
    });
    try {
      await page.route("**/api/v1/projects", (route) =>
        route.fulfill({ json: { items: [project] } }),
      );
      await page.route("**/api/v1/projects/archival/orbs", (route) =>
        route.fulfill({ json: { items: [selected, ...(existingArchive ? [archived] : [])] } }),
      );
      await page.route("**/api/v1/orbs/selected", async (route) => {
        if (source === "pending") await metadataGate;
        await route.fulfill({ json: selected });
      });
      await page.route("**/api/v1/orbs/selected/history", (route) =>
        route.fulfill({
          json: { orbId: selected.id, session: null, records: [], cursor: null, headId: null },
        }),
      );
      await page.route("**/api/v1/orbs/selected/archive", (route) => {
        archiveRequests++;
        if (source === "reject")
          return route.fulfill({
            status: 409,
            json: { error: { code: "conflict", message: "Archive blocked", retryable: false } },
          });
        selected = { ...selected, state: "archiving" };
        return route.fulfill({ json: selected });
      });
      await page.goto(`${origin}/orbs/selected`);
      if (source === "pending")
        await expectPage(page.locator(".orb-index")).toHaveAttribute("aria-busy", "true");
      else await expectPage(page.locator(".orb-name")).toHaveText("Selected");
      await expectPage(page.locator('.ix-row[aria-current="page"]')).toHaveCount(1);
      const index = await page.locator(".orb-index").elementHandle();
      const disclosure = page.locator(".project-archive");
      if (existingArchive) {
        await expectPage(disclosure).not.toHaveAttribute("open");
        if (open) {
          await disclosure.locator("summary").click();
          await expectPage(disclosure).toHaveAttribute("open", "");
        }
      }
      if (source === "click" || source === "cancel" || source === "reject") {
        page.once(
          "dialog",
          (dialog) => void (source === "cancel" ? dialog.dismiss() : dialog.accept()),
        );
        await page.getByRole("button", { name: "Archive orb", exact: true }).click();
        if (source === "reject")
          await expectPage(page.getByText("Archive blocked", { exact: false })).toBeVisible();
        else
          await expectPage(page.locator(".orb-life-word")).toHaveText(
            source === "cancel" ? "stopped" : "archiving",
          );
      } else {
        selected = { ...selected, state: source === "delete" ? "deleting" : "archived" };
      }
      const refreshedList = page.waitForResponse("**/api/v1/projects/archival/orbs");
      await page.clock.runFor(2000);
      await (await refreshedList).finished();
      if (source === "cancel" || source === "reject") {
        expect(archiveRequests).toBe(source === "cancel" ? 0 : 1);
        expect(page.url()).toBe(`${origin}/orbs/selected`);
        await expectPage(page.locator(".orb-name")).toHaveText("Selected");
        await expectPage(page.locator('.ix-row[aria-current="page"]')).toHaveCount(1);
        await expectPage(disclosure).not.toHaveAttribute("open");
        return;
      }
      await expectPage(disclosure.locator("summary")).toHaveText(
        `archive · ${existingArchive ? 2 : 1}`,
      );
      if (source === "delete") {
        await expectPage(page.getByText("Orb doesn't exist")).toBeVisible();
        expect(page.url()).toBe(`${origin}/orbs/selected`);
        if (open) await expectPage(disclosure).toHaveAttribute("open", "");
        else await expectPage(disclosure).not.toHaveAttribute("open");
        await page.clock.runFor(2000);
        if (open) await expectPage(disclosure).toHaveAttribute("open", "");
        else await expectPage(disclosure).not.toHaveAttribute("open");
        expect(page.url()).toBe(`${origin}/orbs/selected`);
        return;
      }
      if (open) {
        await expectPage(disclosure).toHaveAttribute("open", "");
        expect(page.url()).toBe(`${origin}/orbs/selected`);
        await expectPage(page.locator('.ix-row[aria-current="page"]')).toHaveCount(1);
        // A user may collapse an already-selected archived orb without being navigated away.
        await disclosure.locator("summary").click();
        await expectPage(disclosure).not.toHaveAttribute("open");
        await page.clock.runFor(2000);
        expect(page.url()).toBe(`${origin}/orbs/selected`);
      } else {
        await expectPage(page).toHaveURL(`${origin}/orbs`);
        await expectPage(disclosure).not.toHaveAttribute("open");
        await expectPage(page.locator(".orb-main")).toBeEmpty();
        await expectPage(page.locator(".orb-main")).not.toHaveAttribute("aria-busy", "true");
        await expectPage(page.locator('[aria-current="page"]')).toHaveCount(0);
        await expectPage(page).toHaveTitle("pi-orb");
        expect(await index?.evaluate((node) => node.isConnected)).toBe(true);
        if (source === "pending") {
          const metadataResponse = page.waitForResponse("**/api/v1/orbs/selected");
          releaseMetadata();
          await (await metadataResponse).finished();
          await page.clock.runFor(2000);
          await expectPage(page.locator(".orb-main")).toBeEmpty();
          await expectPage(page.locator(".orb-index")).toHaveAttribute("aria-busy", "false");
        }
        // The empty view remains navigable on phones, where a selected view hides the index.
        await page.setViewportSize({ width: 390, height: 844 });
        await expectPage(page.locator(".orb-index")).toBeVisible();
        await disclosure.locator("summary").click();
        await page.getByRole("link", { name: /Selected/ }).click();
        await expectPage(page).toHaveURL(`${origin}/orbs/selected`);
        await expectPage(page.locator(".orb-name")).toHaveText("Selected");
      }
      // A direct archived-orb load must reveal its row, not clear the selection.
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.reload();
      await expectPage(page.locator(".orb-name")).toHaveText("Selected");
      await expectPage(page.locator('.ix-row[aria-current="page"]')).toHaveCount(1);
      await expectPage(disclosure).toHaveAttribute("open", "");
      expect(page.url()).toBe(`${origin}/orbs/selected`);
    } finally {
      releaseMetadata();
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
    }
  },
);

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
    await expect
      .poll(
        () =>
          responses.filter(({ path, status }) => path.endsWith(".woff2") && status === 200).length,
      )
      .toBeGreaterThanOrEqual(2);
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

it.each(["chromium", "webkit"] as const)(
  "%s: built Mermaid preserves privacy, sanitization, rendering and adjacent edge IDs",
  async (engine) => {
    const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const engineBrowser = engine === "webkit" ? await webkit.launch() : browser;
    if (engine === "webkit") onTestFinished(() => engineBrowser.close());
    const page = await engineBrowser.newPage();
    onTestFinished(async () => {
      try {
        await page.unrouteAll({ behavior: "wait" });
      } finally {
        await page.close();
      }
    });
    const timestamp = "2026-11-04T00:00:00Z";
    const project: ProjectView = {
      id: "built-diagrams",
      name: "Diagrams",
      state: "active",
      repositoryUrl: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const orb: OrbView = {
      id: "built-diagrams",
      projectId: project.id,
      harness: "pi",
      name: "Diagrams",
      state: "stopped",
      stateVersion: 1,
      stateChangedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const privateLabel = "private-mermaid-label";
    const hostile = `%%{init: {"securityLevel": "loose"}}%%
flowchart LR
  A["<img src=x onerror='globalThis.__mermaidUnsafe = true'>${privateLabel}"] --> B["Link"]
  click A "javascript:globalThis.__mermaidUnsafe=true"
  click B "https://mermaid-private.invalid/leak"`;
    const adjacent = "flowchart LR\n A[Start]e1@--> B@{shape: circle} e2@--> C[End]";
    const fence = (source: string) => `\`\`\`mermaid\n${source}\n\`\`\``;
    const records: HistoryRecord[] = [
      ...diagramFixtureRecords(timestamp),
      {
        id: "built-safety",
        parentId: "diagrams-answer",
        timestamp,
        type: "message",
        role: "assistant",
        overflow: {},
        content: [
          {
            type: "text",
            text: [hostile, 'flowchart LR\n A["$$E=mc^2$$"]', adjacent].map(fence).join("\n\n"),
          },
        ],
      },
    ];
    const history = {
      orbId: orb.id,
      session: null,
      records: projectDisplayRecords(records),
      cursor: "built-safety",
      headId: "built-safety",
    };
    expect([...Errors(DisplayHistoryViewSchema, history)]).toEqual([]);
    const telemetry: unknown[] = [];
    const errors: string[] = [];
    const externalRequests: string[] = [];
    const scripts: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", async (message) => {
      if (message.text().startsWith("mermaid render"))
        telemetry.push(await message.args()[1]?.jsonValue());
    });
    page.on("request", (request) => {
      if (request.resourceType() === "script") scripts.push(new URL(request.url()).pathname);
    });
    // Only this listener and explicit synthetic API responses may receive browser traffic.
    await page.route("**/*", (route) => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      externalRequests.push(new URL(route.request().url()).origin);
      return route.abort("blockedbyclient");
    });
    await page.route("**/api/v1/projects", (route) =>
      route.fulfill({ json: { items: [project] } }),
    );
    await page.route("**/api/v1/projects/built-diagrams/orbs", (route) =>
      route.fulfill({ json: { items: [orb] } }),
    );
    await page.route("**/api/v1/orbs/built-diagrams", (route) => route.fulfill({ json: orb }));
    await page.route("**/api/v1/orbs/built-diagrams/history", (route) =>
      route.fulfill({
        json: history,
      }),
    );
    await page.goto(`${origin}/orbs/${orb.id}`);
    const boards = page.locator(".mermaid-diagram");
    await expectPage(boards).toHaveCount(7);
    await expectPage.poll(() => telemetry.length).toBe(7);
    for (const index of [0, 1, 2, 4, 5, 6]) {
      const svg = boards.nth(index).locator(".mermaid-canvas svg");
      await expectPage(svg).toBeVisible();
      const size = await svg.boundingBox();
      expect(size?.width).toBeGreaterThan(0);
      expect(size?.height).toBeGreaterThan(0);
    }
    await expectPage(boards.nth(1).locator("g.actor-man rect.actor-you")).toHaveCount(1);
    await expectPage(boards.nth(5).locator(".katex")).toHaveCount(1);
    await expectPage(boards.nth(3).locator(".mermaid-error")).toHaveText(
      "Mermaid: parse error on line 4",
    );
    await expectPage(boards.nth(3).locator("pre code")).toContainText('A --> S["Support API"');
    const unsafe = boards.nth(4);
    await expectPage(unsafe.locator("script, [onerror], [onclick]")).toHaveCount(0);
    expect(
      await unsafe
        .locator("a")
        .evaluateAll((links) =>
          links
            .flatMap((link) =>
              [...link.attributes]
                .filter((attribute) => /href$/i.test(attribute.name))
                .map((attribute) => attribute.value),
            )
            .sort(),
        ),
    ).toEqual(["https://mermaid-private.invalid/leak"]);
    expect(await page.evaluate(() => Reflect.get(globalThis, "__mermaidUnsafe"))).toBeUndefined();
    expect(externalRequests).toEqual([]);
    expect(errors).toEqual([]);
    expect(JSON.stringify(telemetry)).not.toContain(privateLabel);
    for (const detail of telemetry) {
      expect(detail).toEqual(
        expect.objectContaining({ outcome: expect.stringMatching(/^(rendered|parse_failed)$/) }),
      );
      expect(Object.keys(detail as object).sort()).toEqual(
        Reflect.get(detail as object, "outcome") === "rendered"
          ? ["ms", "outcome"]
          : ["line", "outcome", "type"],
      );
    }
    expect(scripts.some((path) => /mermaid-render-.*\.js$/.test(path))).toBe(true);
    expect(scripts.every((path) => path.startsWith("/assets/"))).toBe(true);
    await expectPage
      .poll(() =>
        page
          .locator(".orb-transcript-scroll")
          .evaluate((e) => Math.abs(e.scrollHeight - e.clientHeight - e.scrollTop)),
      )
      .toBeLessThanOrEqual(1);
    const sourceToggle = unsafe.getByRole("button", { name: "Show Mermaid source" });
    await sourceToggle.focus();
    await expectPage(sourceToggle).toBeFocused();
    await sourceToggle.press("Enter");
    await expectPage(unsafe.locator("pre code")).toHaveText(hostile);
    await unsafe.getByRole("button", { name: "Show diagram" }).click();
    await unsafe.getByRole("button", { name: "Open diagram" }).click();
    const dialog = page.locator("dialog.mermaid-dialog");
    await expectPage(dialog.locator(".mermaid-dialog-canvas svg")).toBeVisible();
    await expectPage(dialog.locator("script, [onerror], [onclick]")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expectPage(dialog).toBeHidden();
    // Mermaid #8459: brackets must not become part of an adjacent edge ID.
    const syntax = boards.nth(6);
    await expectPage(syntax.locator(".mermaid-canvas svg")).toBeVisible();
    await expectPage(syntax.locator('path[id$="-e1"], path[id$="-e2"]')).toHaveCount(2);
    await expectPage(syntax.locator(".node")).toHaveCount(3);
    await expectPage(syntax.locator(".mermaid-error")).toHaveCount(0);
    expect(externalRequests).toEqual([]);
    expect(errors).toEqual([]);
  },
);

it.each([
  ["stopped", 1280],
  ["failed", 390],
  ["running", 1280],
  ["running", 390],
] as const)("retries model picker errors in place on a %s orb at %ipx", async (state, width) => {
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const page = await browser.newPage({ viewport: { width, height: 844 } });
  onTestFinished(async () => {
    await page.unrouteAll({ behavior: "wait" });
    await page.close();
  });
  const desktop = width > 600;
  const live = state === "running";
  const orbId = "queued-model-orb";
  const path = `**/api/v1/orbs/${orbId}`;
  const url = `${origin}/orbs/${orbId}`;
  const stamp = "2026-11-01T00:00:00Z";
  const project: ProjectView = {
    id: "queued-model-project",
    name: "Queued model",
    state: "active",
    repositoryUrl: "https://github.com/example/queued-model",
    createdAt: stamp,
    updatedAt: stamp,
  };
  let orb: OrbView = {
    id: orbId,
    projectId: project.id,
    name: "Offline picker",
    harness: live ? "claude" : "pi",
    createdAt: stamp,
    updatedAt: stamp,
    stateChangedAt: stamp,
    state: desktop ? "running" : state,
    stateVersion: 1,
    ...(desktop && !live ? { centralAgent: true } : {}),
    canQueueModel: !desktop && !live,
    pendingModel: null,
  };
  const model = { provider: "test", id: "next" };
  const oldModel = { provider: "test", id: "old" };
  const models = [
    { ...model, name: "Next model" },
    ...Array.from({ length: 18 }, (_, i) => ({
      provider: "test",
      id: `model-${i}`,
      name: `Model ${i}`,
    })),
  ];
  const setterError = `Claude did not apply the model: ${"unbrokendetail".repeat(8)}`;
  await page.route("**/api/v1/projects", (route) => route.fulfill({ json: { items: [project] } }));
  await page.route(`**/api/v1/projects/${project.id}/orbs`, (route) =>
    route.fulfill({ json: { items: [orb] } }),
  );
  await page.route(path, (route) => route.fulfill({ json: orb }));
  const sessionId = "queued-model-session";
  await page.route(`${path}/history`, (route) =>
    route.fulfill({
      json: { orbId, session: { id: sessionId }, records: [], cursor: null, headId: null },
    }),
  );
  const liveRequests: ClientFrame[] = [];
  if (desktop || live) {
    await page.routeWebSocket(`${path}/live`, (socket) => {
      const send = (frame: ServerFrame) => socket.send(JSON.stringify(frame));
      const settings = (selected: typeof model): ServerFrame => ({
        v: 1,
        at: stamp,
        type: "runtime.event",
        event: {
          type: "agent_settings",
          settings: { model: selected, thinkingLevel: "high" },
          models: [
            { ...oldModel, name: "Old model", thinkingLevels: ["high"] },
            ...(live
              ? models.map((model) => ({ ...model, thinkingLevels: ["high" as const] }))
              : []),
          ],
          writable: live,
        },
      });
      socket.onMessage((data) => {
        const frame: ClientFrame = JSON.parse(data.toString());
        if (frame.type === "client.request") {
          liveRequests.push(frame);
          if (!live) return;
          const reject = liveRequests.length === 1;
          if (!reject) send(settings(model));
          send({
            v: 1,
            at: stamp,
            type: "request.result",
            requestId: frame.requestId,
            result: reject
              ? {
                  type: "rejected",
                  error: { code: "internal", message: setterError, retryable: true },
                }
              : { type: "settings_applied", duplicate: false },
          });
        }
        if (frame.type !== "client.hello") return;
        const frames: ServerFrame[] = [
          {
            v: 1,
            at: stamp,
            type: "server.welcome",
            connectionId: "queued-model-connection",
            runtimeInstanceId: "queued-model-runtime",
            orbId,
            sessionId,
            capabilities: [],
            limits: { maxIncomingFrameBytes: 1_000_000, maxPromptBytes: 1_000_000 },
          },
          {
            v: 1,
            at: stamp,
            type: "sync.started",
            mode: "after",
            afterRecordId: frame.afterRecordId,
          },
          settings(oldModel),
          { v: 1, at: stamp, type: "runtime.event", event: { type: "status", activity: "idle" } },
          { v: 1, at: stamp, type: "sync.completed", headId: null },
        ];
        for (const frame of frames) send(frame);
      });
    });
  }
  let rejectOptions = true;
  const catalogError = "Catalog unavailable";
  await page.route(`${path}/model-options`, (route) => {
    expect(live).toBe(false);
    expect(route.request().method()).toBe("GET");
    return rejectOptions
      ? route.fulfill({
          status: 503,
          json: {
            error: { code: "unavailable", message: catalogError, retryable: true },
          },
        })
      : route.fulfill({ json: { models } });
  });
  let rejectQueue = true;
  const queueError = "Retry model selection";
  await page.route(`${path}/pending-model`, (route) => {
    expect(live).toBe(false);
    expect(route.request().method()).toBe("PUT");
    expect(route.request().postDataJSON()).toEqual({ model });
    if (rejectQueue) {
      return route.fulfill({
        status: 409,
        json: { error: { code: "conflict", message: queueError, retryable: false } },
      });
    }
    orb = { ...orb, pendingModel: { changeId: "change-1", model } };
    return route.fulfill({ json: orb });
  });
  const orbApiPath = `/api/v1/orbs/${orbId}`;
  const lifecycleOrMessageRequests: string[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (
      pathname === `${orbApiPath}/start` ||
      pathname === `${orbApiPath}/messages` ||
      (pathname.startsWith(`${orbApiPath}/messages/`) && pathname !== `${orbApiPath}/messages/poll`)
    ) {
      lifecycleOrMessageRequests.push(`${request.method()} ${pathname}`);
    }
  });

  await gotoFrontendHistory(page, url, orbId);
  page.setDefaultTimeout(10_000);
  const changeModel = { name: "Change model", exact: true };
  const modelButton = page.locator(".orb-header .orb-settings").getByRole("button", changeModel);
  const liveThinking = page.getByRole("button", { name: "Change thinking", exact: true });
  const picker = page.locator(".composer").getByRole("listbox", { name: "Commands" });
  const input = page.getByRole("textbox", { name: "Message the orb", exact: true });
  // On phones, Start lives in the collapsed actions row.
  const start = page.getByRole("button", { name: "Start orb", exact: true, includeHidden: true });
  const write = page.getByRole("button", { name: "Write message", exact: true });
  const draft = desktop ? "keep my draft" : "";
  const popup = page.locator(".command-picker");
  const openPicker = async () => {
    if (desktop) await modelButton.click();
    else {
      await input.press("/");
      await picker.getByRole("option", { name: "model", exact: true }).click();
    }
    await expectPage(input).toHaveValue("model ");
    await expectPage(popup).toBeVisible();
  };
  const expectPickerAlert = async (message: string) => {
    const notice = popup.getByText(message, { exact: false });
    await expectPage(notice).toBeInViewport({ ratio: 1 });
    // Visibility alone does not catch the picker covering the text.
    expect(
      await notice.evaluate((element) => {
        const { left, right, top, bottom } = element.getBoundingClientRect();
        return [left + 2, right - 2].every((x) =>
          [top + 2, bottom - 2].every((y) =>
            element.contains(element.ownerDocument.elementFromPoint(x, y)),
          ),
        );
      }),
    ).toBe(true);
    await expectPage(popup.getByRole("alert")).toContainText(message);
    await expectPage(picker.getByRole("alert")).toHaveCount(0);
    await expectPage(
      page.getByText(message, { exact: false }).filter({ visible: true }),
    ).toHaveCount(1);
  };
  const option = picker.getByRole("option", { name: "Next model", exact: true });
  if (live) {
    if (desktop) await input.fill(draft);
    else await write.click();
    await openPicker();
    await input.fill("model test");
    await expectPage(option).toBeEnabled();
    await option.click();
    await expectPickerAlert(setterError);
    await expectPage(input).toHaveValue("model test");
    await expectPage(option).toHaveAttribute("aria-selected", "true");
    await expectPage(option).toBeEnabled();
    await input.press("Enter");
    await expectPage(input).toHaveValue(draft);
    await expectPage(picker).toBeHidden();
    await expectPage(page.getByText(setterError, { exact: false })).toHaveCount(0);
    expect(liveRequests.map((frame) => frame.type === "client.request" && frame.action)).toEqual([
      { type: "set_model", model },
      { type: "set_model", model },
    ]);
    expect(lifecycleOrMessageRequests).toEqual([]);
    return;
  }
  if (desktop) {
    // Record the running orb's picker while the read-only socket is still supplying settings.
    await expectPage(modelButton).toHaveText("Old model");
    await expectPage(liveThinking).toBeVisible();
    await input.fill(draft);
    await openPicker();
    await expectPage(picker.getByRole("option", { name: "Old model", exact: true })).toBeVisible();
    await input.press("Escape");
    await expectPage(input).toHaveValue(draft);
    orb = { ...orb, state, stateVersion: 2, stopReason: "sleep", canQueueModel: true };
    await expectPage(modelButton).toBeVisible();
    await expectPage(liveThinking).toHaveCount(0);
  } else {
    await expectPage(page.getByRole("button", changeModel)).toBeHidden();
    await write.click();
  }
  await expectPage(start).toHaveCount(1);
  await openPicker();
  await expectPickerAlert(catalogError);
  rejectOptions = false;
  await popup.getByRole("button", { name: "Retry", exact: true }).click();
  await expectPage(input).toBeFocused();
  await expectPage(popup).toBeVisible();
  await expectPage(input).toHaveValue("model ");
  await expectPage(option).toBeVisible();
  await expectPage(popup.getByRole("alert")).toHaveCount(0);
  await input.fill("model test");
  await input.press("Enter");
  await expectPickerAlert(queueError);
  await expectPage(input).toHaveValue("model test");
  await expectPage(option).toBeEnabled();
  rejectQueue = false;
  await option.click();
  await expectPage(input).toHaveValue(draft);
  await expectPage(picker).toBeHidden();
  await expectPage(page.getByText(queueError, { exact: false })).toHaveCount(0);
  await expectPage(start).toHaveCount(1);
  const queuedLabel = "Next model (queued)";
  if (desktop) await expectPage(modelButton).toHaveText(queuedLabel);
  await expectPage(page.locator(".orb-header-scroll")).not.toContainText(/Queued:|\(queued\)/i);
  await page.reload();
  await expectPage(start).toHaveCount(1);
  if (desktop) {
    await expectPage(modelButton).toHaveText(queuedLabel);
    orb = { ...orb, pendingModel: null, canQueueModel: false };
    await expectPage(modelButton).toHaveText("Old model");
  } else {
    await write.click();
    await openPicker();
    await expectPage(picker.getByRole("option", { name: queuedLabel, exact: true })).toBeVisible();
  }
  expect(lifecycleOrMessageRequests).toEqual([]);
  expect(liveRequests).toEqual([]);
});
