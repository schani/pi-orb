import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect as check, chromium, webkit } from "@playwright/test";
import { createServer } from "vite";
import { it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";
import { gotoFrontendFixture } from "./testkit/frontend-fixture.ts";
import { observeProjectCreates } from "./testkit/project-create-observer.ts";

type NativeElement = {
  tagName: string;
  closest(selector: string): NativeElement | null;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  getBoundingClientRect(): { x: number; y: number; width: number; height: number };
};
type NativeEvent = {
  target: NativeElement | null;
  button: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  clientX: number;
  clientY: number;
  defaultPrevented: boolean;
};
type NativeBrowser = {
  document: {
    fonts: { ready: Promise<unknown> };
    hasFocus(): boolean;
    visibilityState: string;
    querySelectorAll(selector: string): NativeElement[];
    elementFromPoint(x: number, y: number): NativeElement | null;
  };
  location: { pathname: string };
  addEventListener(type: string, listener: (event: NativeEvent) => void): void;
  recordNativeActivation(event: unknown): Promise<void>;
};

it.each(["chromium", "webkit"] as const)(
  "%s: shared project headers create the selected harness in place and preserve retry intent",
  async (engine) => {
    const root = join(import.meta.dirname, "../apps/web");
    const cacheDir = await mkdtemp(join(tmpdir(), "harness-icons-frontend-"));
    const vite = await createServer({
      root,
      cacheDir,
      configFile: join(root, "vite.config.ts"),
      mode: "frontend",
      server: { host: "127.0.0.1", port: 0 },
    });
    const browser =
      engine === "chromium"
        ? await chromium.launch({ channel: "chromium", headless: true })
        : await webkit.launch({ headless: true });
    const context = await browser.newContext();
    const releasePending = new Set<() => void>();
    const nativeEvidence: {
      activation: string;
      stage: string;
      before?: unknown;
      events: unknown[];
      posts: Record<string, unknown>[];
    }[] = [];
    await context.tracing.start({ screenshots: true, snapshots: true });
    try {
      await listenFrontend(vite);
      const address = vite.httpServer?.address();
      check(address && typeof address !== "string").toBeTruthy();
      if (!address || typeof address === "string") return;
      const origin = `http://127.0.0.1:${address.port}`;
      const page = await context.newPage();
      await page.route("**/api/v1/projects", async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        body.items[0].name = "Signal and Boards with a project name long enough to truncate";
        await route.fulfill({ response, json: body });
      });
      const scopedPosts: { path: string; body: Record<string, unknown> }[] = [];
      const projectEndpoint = "**/api/v1/projects/*/orbs";
      await page.route(projectEndpoint, async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        scopedPosts.push({
          path: new URL(route.request().url()).pathname,
          body: route.request().postDataJSON(),
        });
        await route.fulfill({
          status: 503,
          json: { error: { code: "unavailable", message: "scoped failure", retryable: true } },
        });
      });
      for (const surface of ["dashboard", "index"] as const) {
        const scope = page.locator(surface === "index" ? ".orb-index" : ".dashboard");
        await gotoFrontendFixture(
          page,
          `${origin}${surface === "index" ? "/orbs/frontend-fixture-orb" : "/"}`,
          scope.locator(".project-head").first(),
        );
        for (const header of await scope.locator(".project-head").all()) {
          for (const harness of ["pi", "claude"] as const) {
            const action = header.locator(`a[data-harness="${harness}"]`);
            const href = await action.getAttribute("href");
            check(href).toMatch(new RegExp(`\\?harness=${harness}$`));
            const url = new URL(href ?? "", origin);
            const projectId = url.pathname.split("/")[2];
            const count = scopedPosts.length;
            if (harness === "pi") await action.press("Enter");
            else await action.click();
            await check.poll(() => scopedPosts.length).toBe(count + 1);
            check(scopedPosts[count]).toMatchObject({
              path: `/api/v1/projects/${projectId}/orbs`,
              body: { harness },
            });
            await check(header.getByRole("alert")).toContainText("scoped failure");
          }
        }
        const geometry = await scope
          .locator(".project-name")
          .first()
          .evaluate((title) => ({
            overflow: title.scrollWidth > title.clientWidth,
            clipped: title.ownerDocument.defaultView?.getComputedStyle(title).textOverflow,
            actionsFit:
              (title.parentElement?.scrollWidth ?? 0) <= (title.parentElement?.clientWidth ?? 0),
          }));
        check(geometry).toEqual({ overflow: true, clipped: "ellipsis", actionsFit: true });
      }
      await page.unroute(projectEndpoint);
      for (const surface of ["dashboard", "index"] as const) {
        for (const harness of ["pi", "claude"] as const) {
          const path = surface === "index" ? "/orbs/frontend-fixture-orb" : "/";
          const scope = page.locator(surface === "index" ? ".orb-index" : ".dashboard");
          await gotoFrontendFixture(
            page,
            `${origin}${path}`,
            scope.locator(".project-head").first(),
          );
          await check(scope.locator(".project-head")).toHaveCount(4);
          await check(scope.locator(".project-new-orb-row")).toHaveCount(0);
          await check(scope.getByRole("link", { name: /^New (Pi|Claude) orb in / })).toHaveCount(8);
          const composer = page.getByRole("textbox", { name: "Message the orb", exact: true });
          if (surface === "index") await composer.fill("preserve draft during create");
          const node = await scope.elementHandle();
          const history =
            surface === "index" ? await page.locator(".history").elementHandle() : null;
          const posts: Record<string, unknown>[] = [];
          let arrived = () => {};
          let release = () => {};
          const requested = new Promise<void>((resolve) => {
            arrived = resolve;
          });
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          releasePending.add(() => release());
          const endpoint = "**/api/v1/projects/frontend-scratchpad-project/orbs";
          await page.route(endpoint, async (route) => {
            if (route.request().method() !== "POST") return route.continue();
            posts.push(route.request().postDataJSON() as Record<string, unknown>);
            if (posts.length === 1) {
              arrived();
              await gate;
              await route.fulfill({
                status: 503,
                json: {
                  error: { code: "unavailable", message: "synthetic failure", retryable: true },
                },
              });
            } else await route.continue();
          });
          const name = `New ${harness === "pi" ? "Pi" : "Claude"} orb in scratchpad`;
          const header = scope
            .locator(".project-head")
            .filter({ has: page.getByRole("heading", { name: "scratchpad", exact: true }) });
          await header.getByRole("link", { name, exact: true }).click();
          await requested;
          check(posts[0]).toMatchObject({ harness });
          await check(page).toHaveURL(`${origin}${path}`);
          for (const label of ["Pi", "Claude"])
            await check(
              header.getByRole("button", { name: `New ${label} orb in scratchpad`, exact: true }),
            ).toBeDisabled();
          await check(page.getByRole("combobox", { name: /^Harness/ })).toHaveCount(0);
          check(await node?.evaluate((element) => element.isConnected)).toBe(true);
          if (history) check(await history.evaluate((element) => element.isConnected)).toBe(true);
          if (surface === "index")
            await check(composer).toHaveValue("preserve draft during create");
          release();
          await check(header.getByRole("alert")).toContainText("synthetic failure");
          await header.getByRole("button", { name: "retry", exact: true }).click();
          await check(page).toHaveURL(/\/orbs\/[0-9a-f-]+$/);
          check(posts).toHaveLength(2);
          check(posts[1]).toEqual(posts[0]);
          const read = await page.request.get(`${origin}/api/v1/orbs/${posts[0]?.["id"]}`);
          check((await read.json()).harness).toBe(harness);
          await page.unroute(endpoint);
        }
      }
      await page.exposeFunction("recordNativeActivation", (event: unknown) => {
        nativeEvidence.at(-1)?.events.push(event);
      });
      for (const activation of ["modified", "middle"] as const) {
        const evidence = {
          activation,
          stage: "loading",
          events: [] as unknown[],
          posts: [] as Record<string, unknown>[],
          before: undefined as unknown,
        };
        nativeEvidence.push(evidence);
        // Headers precede orb-list hydration, which changes their pointer coordinates.
        const lists = ["fixture", "fieldnotes", "homelab", "scratchpad"].map((name) =>
          page
            .waitForResponse(
              (response) =>
                response.request().method() === "GET" &&
                new URL(response.url()).pathname ===
                  `/api/v1/projects/frontend-${name}-project/orbs`,
            )
            .then(async (response) => {
              check(response.ok()).toBe(true);
              await response.finished();
            }),
        );
        await gotoFrontendFixture(
          page,
          `${origin}/orbs/frontend-fixture-orb`,
          page.locator(".orb-index .project-head").first(),
        );
        await Promise.all(lists);
        await check(page.locator(".orb-index .project-progress")).toHaveCount(0);
        await page.evaluate(() =>
          (globalThis as unknown as NativeBrowser).document.fonts.ready.then(() => undefined),
        );
        await page.evaluate(() => {
          const browser = globalThis as unknown as NativeBrowser;
          const document = browser.document;
          for (const type of ["pointerdown", "pointerup", "click", "auxclick"]) {
            browser.addEventListener(type, (event) => {
              const pointer = event;
              const target = event.target;
              const anchor = target?.closest("a");
              const box = anchor?.getBoundingClientRect();
              queueMicrotask(() => {
                void browser.recordNativeActivation({
                  type,
                  button: pointer.button,
                  ctrl: pointer.ctrlKey,
                  meta: pointer.metaKey,
                  shift: pointer.shiftKey,
                  alt: pointer.altKey,
                  prevented: event.defaultPrevented,
                  focus: document.hasFocus(),
                  visibility: document.visibilityState,
                  target: target?.tagName,
                  anchor: anchor?.getAttribute("href")?.split("?")[0],
                  x: pointer.clientX,
                  y: pointer.clientY,
                  bounds: box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null,
                  loading: document.querySelectorAll(".orb-index .project-progress").length,
                });
              });
            });
          }
        });
        const sourceNode = await page.locator(".orb-index").elementHandle();
        const posts = evidence.posts;
        const stopObserving = observeProjectCreates(context, posts);
        const action = page.getByRole("link", {
          name: "New Claude orb in scratchpad",
          exact: true,
        });
        await check(action).toHaveAttribute(
          "href",
          "/projects/frontend-scratchpad-project/orbs/new?harness=claude",
        );
        evidence.before = await action.evaluate((anchor) => {
          const document = (globalThis as unknown as NativeBrowser).document;
          const box = anchor.getBoundingClientRect();
          const target = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          return {
            href: anchor.getAttribute("href"),
            disabled: anchor.getAttribute("aria-disabled"),
            focus: document.hasFocus(),
            visibility: document.visibilityState,
            target: target?.tagName,
            hitAnchor: target?.closest("a") === anchor,
            bounds: { x: box.x, y: box.y, width: box.width, height: box.height },
          };
        });
        evidence.stage = "native-click";
        const opened = context.waitForEvent("page");
        if (activation === "middle") await action.click({ button: "middle" });
        else
          await action.click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] });
        evidence.stage = "popup";
        const destination = await opened;
        evidence.stage = "destination";
        await check(destination).toHaveURL(/\/orbs\/[0-9a-f-]+$/);
        check(posts).toHaveLength(1);
        check(posts[0]).toMatchObject({ harness: "claude" });
        await check(page).toHaveURL(`${origin}/orbs/frontend-fixture-orb`);
        check(await sourceNode?.evaluate((element) => element.isConnected)).toBe(true);
        await destination.close();
        check(destination.isClosed()).toBe(true);
        evidence.stage = "closed";
        stopObserving();
      }
      for (const fence of ["unmount", "deletion"] as const) {
        await gotoFrontendFixture(
          page,
          `${origin}/orbs/frontend-fixture-orb`,
          page.locator(".orb-index .project-head").first(),
        );
        let arrived = () => {};
        let release = () => {};
        const requested = new Promise<void>((resolve) => {
          arrived = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        releasePending.add(() => release());
        await page.route(projectEndpoint, async (route) => {
          if (route.request().method() !== "POST") return route.continue();
          arrived();
          await gate;
          await route.continue();
        });
        await page.getByRole("link", { name: "New Pi orb in scratchpad", exact: true }).click();
        await requested;
        if (fence === "unmount") {
          await page.locator(".ix-brand").click();
          await check(page.locator(".dashboard")).toBeVisible();
        } else {
          await page.route("**/api/v1/projects", async (route) => {
            const response = await route.fetch();
            const body = await response.json();
            body.items.find(
              (project: { id: string }) => project.id === "frontend-scratchpad-project",
            ).state = "deleting";
            await route.fulfill({ response, json: body });
          });
          await check(page.getByRole("region", { name: "scratchpad", exact: true })).toContainText(
            "deleting project…",
          );
        }
        const response = page.waitForResponse(
          (reply) =>
            reply.request().method() === "POST" && new URL(reply.url()).pathname.endsWith("/orbs"),
        );
        release();
        await (await response).finished();
        await check(page).toHaveURL(
          `${origin}${fence === "unmount" ? "/" : "/orbs/frontend-fixture-orb"}`,
        );
        await page.unroute(projectEndpoint);
        if (fence === "deletion") await page.unroute("**/api/v1/projects");
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await gotoFrontendFixture(page, origin, page.locator(".dashboard .project-head").first());
      const targets = await page
        .locator(".dashboard .project-head-actions > .icon-button")
        .evaluateAll((buttons) =>
          buttons.map((button) => ({
            width: button.getBoundingClientRect().width,
            height: button.getBoundingClientRect().height,
          })),
        );
      check(targets).toHaveLength(16);
      for (const target of targets) check(target).toEqual({ width: 48, height: 48 });
    } catch (error) {
      const root = join(
        import.meta.dirname,
        "../.context/claude-production-hardening/browser-failure",
      );
      await mkdir(root, { recursive: true });
      const directory = await mkdtemp(join(root, `${engine}-`));
      const pages = await Promise.allSettled(
        context.pages().map(async (page, index) => {
          const state = await page.evaluate(() => {
            const browser = globalThis as unknown as NativeBrowser;
            const document = browser.document;
            return {
              path: browser.location.pathname,
              focus: document.hasFocus(),
              visibility: document.visibilityState,
              loading: document.querySelectorAll(".orb-index .project-progress").length,
              anchors: [...document.querySelectorAll(".project-new-orb-icon")].map((anchor) => ({
                tag: anchor.tagName,
                disabled: anchor.hasAttribute("disabled"),
                href: anchor.getAttribute("href")?.split("?")[0],
              })),
            };
          });
          await page.screenshot({ path: join(directory, `page-${index}.png`) });
          return state;
        }),
      );
      await writeFile(
        join(directory, "activation.json"),
        JSON.stringify(
          {
            engine,
            platform: process.platform,
            nativeEvidence,
            pages: pages.map((result) =>
              result.status === "fulfilled" ? result.value : { unavailable: true },
            ),
          },
          null,
          2,
        ),
      );
      await context.tracing.stop({ path: join(directory, "trace.zip") });
      throw error;
    } finally {
      for (const release of releasePending) release();
      await context.close();
      await browser.close();
      await vite.close();
      await rm(cacheDir, { recursive: true, force: true });
    }
  },
);
