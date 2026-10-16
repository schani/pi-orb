import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  type DisplayHistoryView,
  type OrbView,
  OrbViewSchema,
  type ProjectView,
  type SessionProbe,
} from "@pi-orb/protocol";
import { chromium, expect as expectPage } from "@playwright/test";
import Fastify from "fastify";
import { Errors } from "typebox/value";
import { build } from "vite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { registerWebAssets } from "../apps/control-plane/src/http/web-assets.ts";
import { waitForAppliedHistory } from "./testkit/applied-history.ts";
import {
  captureColdNavigation,
  observeColdNavigation,
} from "./testkit/cold-navigation-evidence.ts";

const root = mkdtempSync(join(tmpdir(), "pi-orb-built-shell-"));
const app = Fastify({ logger: false });
let browser: Awaited<ReturnType<typeof chromium.launch>>;
let metadataBodyRelease: Promise<void> | null = null;

beforeAll(async () => {
  console.info("built-shell environment", { nodeEnv: process.env["NODE_ENV"] });
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
  app.get("/api/v1/orbs/cold-child", (_, reply) => {
    if (metadataBodyRelease === null) return coldOrb;
    const stream = new PassThrough();
    const body = JSON.stringify(coldOrb);
    stream.write(body.slice(0, 1));
    void metadataBodyRelease.then(() => stream.end(body.slice(1)));
    reply.type("application/json");
    return stream;
  });
  app.get("/api/v1/orbs/cold-child/history", () => coldHistory);
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

it("boots the production shell and loads its built JS, CSS and favicon on direct deep links and reload", async () => {
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

const coldOrb: OrbView = {
  id: "cold-child",
  projectId: "cold-project",
  harness: "pi",
  name: "Cold child",
  state: "running",
  stateVersion: 1,
  activity: "idle",
  stateChangedAt: "2026-10-16T00:00:00Z",
  createdAt: "2026-10-16T00:00:00Z",
  updatedAt: "2026-10-16T00:00:00Z",
};
const coldHistory: DisplayHistoryView = {
  orbId: coldOrb.id,
  session: { id: "cold-session" },
  cursor: "completion",
  headId: "completion",
  records: [
    {
      id: "completion",
      parentId: null,
      timestamp: "2026-10-16T00:00:00Z",
      type: "message",
      role: "assistant",
      finishReason: "stop",
      content: [{ type: "text", text: "SPAWNED_TASK_COMPLETE" }],
    },
  ],
};

it.each([
  "projects",
  "metadata",
  "history-before-fetch",
  "history-after-body",
  "metadata-body",
] as const)("cold navigation controlled gate: %s", async (held) => {
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const page = await browser.newPage();
  const evidence = observeColdNavigation(page);
  const signal = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  const gate = signal();
  const entered = signal();
  const historyFulfilled = signal();
  const metadataFulfilled = signal();
  let metadataHeaders: ReturnType<typeof page.waitForResponse> | null = null;
  const hold = async () => {
    entered.resolve();
    await gate.promise;
  };
  try {
    await page.route("**/api/v1/projects", async (route) => {
      if (held === "projects") await hold();
      await route.fulfill({ json: { items: [] } });
    });
    if (held === "metadata-body") {
      metadataBodyRelease = gate.promise;
      metadataHeaders = page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/api/v1/orbs/cold-child",
      );
    } else {
      await page.route("**/api/v1/orbs/cold-child", async (route) => {
        if (held === "metadata") await hold();
        await route.fulfill({ json: coldOrb });
        metadataFulfilled.resolve();
      });
    }
    await page.route("**/api/v1/orbs/cold-child/history", async (route) => {
      evidence.stage("history", "entered", undefined, route.request());
      if (held === "history-before-fetch") await hold();
      evidence.stage("history", "upstream-fetch", undefined, route.request());
      const response = await route.fetch();
      evidence.stage("history", "upstream-body-complete", undefined, route.request());
      const body = await response.text();
      evidence.stage(
        "history",
        "buffer-summary",
        {
          records: coldHistory.records.length,
          marker: body.includes("SPAWNED_TASK_COMPLETE"),
        },
        route.request(),
      );
      if (held === "history-after-body") await hold();
      await route.fulfill({ response, body });
      evidence.stage("history", "fulfill-acknowledged", undefined, route.request());
      historyFulfilled.resolve();
    });
    await page.goto(`${origin}/orbs/${coldOrb.id}`);
    if (metadataHeaders !== null) await metadataHeaders;
    else await entered.promise;
    if (held === "projects") {
      await Promise.all([metadataFulfilled.promise, historyFulfilled.promise]);
      await expectPage(page.getByText("SPAWNED_TASK_COMPLETE", { exact: true })).toBeVisible();
      await expectPage(page.getByRole("status")).toHaveText("loading projects…");
    } else {
      await (held === "metadata" || held === "metadata-body"
        ? historyFulfilled.promise
        : metadataFulfilled.promise);
      await expectPage(page.locator(".orb-main[aria-busy=true]")).toHaveCount(1);
      await expectPage(page.getByText("SPAWNED_TASK_COMPLETE", { exact: true })).toHaveCount(0);
    }
    console.info("cold-navigation held", held, JSON.stringify(evidence.snapshot()));
    if (held === "metadata-body") {
      const directory = join(
        import.meta.dirname,
        "../test-failures/cold-navigation",
        `${Date.now()}`,
      );
      const captured = await captureColdNavigation(page, evidence, directory);
      expect(captured.isOk()).toBe(true);
      expect(JSON.parse(readFileSync(join(directory, "dom.json"), "utf8"))).toMatchObject({
        mainBusy: "true",
        mainChildren: 0,
        debug: { navigation: [], current: null },
      });
      console.info("cold-navigation capture", directory);
    }
    const acceptance = waitForAppliedHistory(page, coldHistory);
    gate.resolve();
    await acceptance;
    await expectPage(page.getByText("SPAWNED_TASK_COMPLETE", { exact: true })).toBeVisible();
    console.info("cold-navigation released", held, JSON.stringify(evidence.snapshot()));
  } finally {
    gate.resolve();
    metadataBodyRelease = null;
    await page.unrouteAll({ behavior: "wait" });
    evidence.dispose();
    await page.close();
  }
});

it.each(["cancelled-first", "active-first", "crossed"] as const)(
  "cold navigation owns each StrictMode request: %s",
  async (order) => {
    const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const page = await browser.newPage();
    const pending: { metadata: (() => Promise<void>)[]; history: (() => Promise<void>)[] } = {
      metadata: [],
      history: [],
    };
    let acceptance: Promise<void> | undefined;
    try {
      await page.route("**/api/v1/projects", (route) => route.fulfill({ json: { items: [] } }));
      for (const kind of ["metadata", "history"] as const) {
        const path = `**/api/v1/orbs/cold-child${kind === "history" ? "/history" : ""}`;
        await page.route(path, async (route) => {
          const index = pending[kind].length;
          let release!: () => void;
          let fulfilled!: () => void;
          const held = new Promise<void>((resolve) => {
            release = resolve;
          });
          const completed = new Promise<void>((resolve) => {
            fulfilled = resolve;
          });
          pending[kind].push(async () => {
            release();
            await completed;
          });
          await held;
          const json =
            kind === "metadata"
              ? coldOrb
              : index === 0
                ? {
                    ...coldHistory,
                    records: [
                      {
                        ...coldHistory.records[0],
                        content: [{ type: "text", text: "CANCELLED_LOAD" }],
                      },
                    ],
                  }
                : coldHistory;
          await route.fulfill({ json });
          fulfilled();
        });
      }
      await page.goto(`${origin}/orbs/${coldOrb.id}`);
      await expectPage
        .poll(() => [pending.metadata.length, pending.history.length])
        .toEqual([2, 2]);
      const marker = page.getByText("SPAWNED_TASK_COMPLETE", { exact: true });
      if (order === "cancelled-first") {
        await Promise.all([pending.metadata[0]?.(), pending.history[0]?.()]);
      } else if (order === "crossed") {
        await Promise.all([pending.metadata[0]?.(), pending.history[1]?.()]);
      } else {
        await Promise.all([pending.metadata[1]?.(), pending.history[1]?.()]);
        await expectPage(marker).toBeVisible();
      }
      let applied = false;
      acceptance = waitForAppliedHistory(page, coldHistory).then(() => {
        applied = true;
      });
      if (order !== "active-first") {
        await page.evaluate(() => undefined);
        expect(applied).toBe(false);
        await expectPage(page.locator(".orb-main[aria-busy=true]")).toHaveCount(1);
        await expectPage(marker).toHaveCount(0);
      }
      await Promise.all([pending.metadata[1]?.(), pending.history[1]?.()]);
      await acceptance;
      await expectPage(marker).toBeVisible();
      await Promise.all([pending.metadata[0]?.(), pending.history[0]?.()]);
      await page.unrouteAll({ behavior: "wait" });
      await expectPage(marker).toBeVisible();
      await expectPage(page.getByText("CANCELLED_LOAD", { exact: true })).toHaveCount(0);
    } finally {
      await Promise.all(
        Object.values(pending)
          .flat()
          .map((release) => release()),
      );
      await acceptance;
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
    }
  },
);
