import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Browser, chromium, expect as expectPage } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, it } from "vitest";

const WEB_ROOT = join(import.meta.dirname, "../apps/web");
const ORB_HASH = "#/orbs/frontend-fixture-orb";
let vite: ViteDevServer;
let browser: Browser;
let origin: string;

/**
 * Browser E2E for the exact cross-boundary path that unit tests cannot prove:
 * Vite fixture control -> IAP-shaped HTML 401 -> shared API adapter -> React
 * ribbon -> same-tab top-level auth round trip -> draft/session restoration.
 */
describe("frontend-only browser behavior", () => {
  beforeAll(async () => {
    vite = await createServer({
      root: WEB_ROOT,
      configFile: join(WEB_ROOT, "vite.config.ts"),
      mode: "frontend",
      server: { host: "127.0.0.1", port: 0 },
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (address === null || address === undefined || typeof address === "string") {
      throw new Error("frontend E2E Vite server did not own a TCP port");
    }
    origin = `http://127.0.0.1:${address.port}`;

    const configuredExecutable = process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"];
    const systemExecutable = existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined;
    browser = await chromium.launch({
      ...(configuredExecutable !== undefined
        ? { executablePath: configuredExecutable }
        : systemExecutable !== undefined
          ? { executablePath: systemExecutable }
          : {}),
      args: ["--no-sandbox"],
    });
  });

  afterAll(async () => {
    await browser?.close();
    await vite?.close();
  });

  it.each(["MCPs", "Secrets"])("keeps %s field focus across dashboard refreshes", async (modal) => {
    const page = await browser.newPage();
    await page.clock.install();
    let refreshed = false;
    await page.route("**/api/v1/projects", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      if (refreshed) body.items[0].name = "Refreshed project";
      await route.fulfill({ response, json: body });
    });
    await page.route("**/api/v1/projects/*/mcp", (route) =>
      route.fulfill({ json: { revision: 0, servers: [] } }),
    );
    try {
      await page.goto(`${origin}/`);
      await page
        .getByRole("button", { name: /^Configure / })
        .first()
        .click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("tab", { name: modal, exact: true }).click();
      const endpoint = dialog.getByLabel(modal === "MCPs" ? "Endpoint" : "secret value", {
        exact: true,
      });
      await endpoint.fill("https://example.com/mcp");
      refreshed = true;
      await page.clock.runFor(2000);
      await expectPage(
        page.getByRole("heading", { name: "Refreshed project", exact: true }),
      ).toBeVisible();
      await expectPage(endpoint).toBeFocused();
      await expectPage(endpoint).toHaveValue("https://example.com/mcp");
      if (modal === "MCPs") {
        await dialog.getByLabel("Description", { exact: true }).fill("Analytics");
        await page.clock.runFor(2000);
        await expectPage(dialog.getByLabel("Description", { exact: true })).toBeFocused();
      }
      await page.keyboard.press("Escape");
      await expectPage(dialog).toHaveCount(0);
    } finally {
      await page.close();
    }
  });

  it.each(["", ORB_HASH])(
    "preserves MCP drafts while adding a secret from config at %s",
    async (hash) => {
      const page = await browser.newPage();
      let saved: unknown;
      let releaseSecrets = () => {};
      let releaseSave = () => {};
      const saveAllowed = new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
      const secretsLoaded = new Promise<void>((resolve) => {
        releaseSecrets = resolve;
      });
      await page.route("**/api/v1/projects/*/secrets", async (route) => {
        const response = await route.fetch();
        await secretsLoaded;
        await route.fulfill({ response });
      });
      await page.route("**/api/v1/projects/*/mcp", async (route) => {
        if (route.request().method() === "PUT") {
          saved = route.request().postDataJSON();
          await route.fulfill({ json: { ...route.request().postDataJSON(), revision: 1 } });
        } else await route.fulfill({ json: { revision: 0, servers: [] } });
      });
      await page.route("**/api/v1/projects/*/mcp/describe", (route) =>
        route.fulfill({ json: { description: "Analytics" } }),
      );
      await page.route("**/api/v1/projects/*/secrets/TOKEN", async (route) => {
        expectPage(route.request().postDataJSON()).toEqual({ value: "test-value" });
        await saveAllowed;
        await route.fulfill({
          json: { revision: 1, items: [{ name: "TOKEN", updatedAt: new Date(0).toISOString() }] },
        });
      });
      try {
        await page.goto(`${origin}/${hash}`);
        const gear = page.getByRole("button", { name: /^Configure / }).first();
        await expectPage(gear).toBeVisible();
        expectPage(
          await gear.evaluate((element) => {
            const heading = element.parentElement
              ?.querySelector(".project-name, .trunc")
              ?.getBoundingClientRect();
            const button = element.getBoundingClientRect();
            return heading
              ? Math.abs(heading.y + heading.height / 2 - button.y - button.height / 2)
              : Infinity;
          }),
        ).toBeLessThanOrEqual(1);
        await gear.click();
        const dialog = page.getByRole("dialog");
        const mcp = dialog.getByRole("tabpanel", { name: "MCPs", exact: true });
        await expectPage(dialog.getByRole("tab", { name: "General", exact: true })).toBeFocused();
        await dialog.getByRole("tab", { name: "MCPs", exact: true }).click();
        expectPage(JSON.parse(await mcp.getByLabel("Header bindings").inputValue())).toEqual({
          Authorization: { secret: "TOKEN", prefix: "Bearer " },
        });
        await mcp.getByLabel("Provider", { exact: true }).selectOption("posthog");
        await expectPage(mcp.getByLabel("Header bindings")).toHaveValue(/POSTHOG_KEY/);
        await mcp.getByLabel("Provider", { exact: true }).selectOption("");
        expectPage(JSON.parse(await mcp.getByLabel("Header bindings").inputValue())).toEqual({
          Authorization: { secret: "TOKEN", prefix: "Bearer " },
        });
        await mcp.getByLabel("Name", { exact: true }).fill("custom");
        await mcp.getByLabel("Endpoint", { exact: true }).fill("https://example.com/mcp");
        await mcp.getByLabel("Description", { exact: true }).fill("Analytics");
        await mcp.getByLabel("Header bindings").fill('{"unfinished":');
        await dialog.getByRole("tab", { name: "Secrets", exact: true }).click();
        const secrets = dialog.getByRole("tabpanel", { name: "Secrets", exact: true });
        await secrets.getByLabel("name", { exact: true }).fill("TOKEN");
        await secrets.getByLabel("secret value", { exact: true }).fill("test-value");
        const saveSecret = secrets.getByRole("button", { name: "save secret", exact: true });
        await expectPage(saveSecret).toBeDisabled();
        releaseSecrets();
        await expectPage(saveSecret).toBeEnabled();
        await saveSecret.click();
        await expectPage(dialog).toBeFocused();
        await expectPage(dialog.getByRole("tab", { name: "MCPs", exact: true })).toBeDisabled();
        await expectPage(
          dialog.getByRole("button", { name: "Close project config" }),
        ).toBeDisabled();
        await page.keyboard.press("Tab");
        await expectPage(dialog).toBeFocused();
        await page.keyboard.press("Escape");
        await expectPage(dialog).toBeVisible();
        releaseSave();
        await expectPage(
          secrets.locator(".project-secret-name").filter({ hasText: /^TOKEN$/ }),
        ).toBeVisible();
        await dialog.getByRole("tab", { name: "MCPs", exact: true }).click();
        await expectPage(mcp.getByLabel("Name", { exact: true })).toHaveValue("custom");
        await expectPage(mcp.getByLabel("Endpoint", { exact: true })).toHaveValue(
          "https://example.com/mcp",
        );
        await expectPage(mcp.getByLabel("Description", { exact: true })).toHaveValue("Analytics");
        await expectPage(mcp.getByLabel("Header bindings")).toHaveValue('{"unfinished":');
        const headers = { Authorization: { secret: "TOKEN", prefix: "Bearer " } };
        await mcp.getByLabel("Header bindings").fill(JSON.stringify(headers));
        await mcp.getByRole("button", { name: "save", exact: true }).click();
        await expectPage(mcp.getByRole("button", { name: "edit", exact: true })).toBeVisible();
        expectPage(JSON.parse(await mcp.getByLabel("Header bindings").inputValue())).toEqual(
          headers,
        );
        await expectPage(mcp.getByLabel("Provider", { exact: true })).toHaveValue("");
        expectPage(saved).toEqual({
          revision: 0,
          servers: [
            { name: "custom", url: "https://example.com/mcp", description: "Analytics", headers },
          ],
        });
        await mcp.getByRole("button", { name: "edit", exact: true }).click();
        await mcp.getByLabel("Description", { exact: true }).fill("Edited draft");
        const mcpTab = dialog.getByRole("tab", { name: "MCPs", exact: true });
        await mcpTab.focus();
        await page.keyboard.press("ArrowRight");
        await expectPage(dialog.getByRole("tab", { name: "Secrets", exact: true })).toBeFocused();
        await expectPage(secrets).toBeVisible();
        await page.keyboard.press("Home");
        await expectPage(dialog.getByRole("tab", { name: "General", exact: true })).toBeFocused();
        await page.keyboard.press("ArrowRight");
        await expectPage(mcpTab).toBeFocused();
        await expectPage(mcp.getByLabel("Name", { exact: true })).toHaveAttribute("readonly", "");
        await expectPage(mcp.getByLabel("Description", { exact: true })).toHaveValue(
          "Edited draft",
        );
        await page.keyboard.press("Escape");
        await expectPage(dialog).toHaveCount(0);
        await expectPage(gear).toBeFocused();
        await expectPage(page.locator(".project-repo")).toHaveCount(0);
      } finally {
        releaseSecrets();
        releaseSave();
        await page.close();
      }
    },
  );

  it.each(["", ORB_HASH])(
    "shares project header and validates General settings at %s",
    async (hash) => {
      const page = await browser.newPage();
      const response = await page.request.get(`${origin}/api/v1/projects`);
      let project = (await response.json()).items[0];
      const requests: unknown[] = [];
      await page.route("**/api/v1/projects", (route) =>
        route.fulfill({ json: { items: [project] } }),
      );
      await page.route(`**/api/v1/projects/${project.id}`, async (route) => {
        if (route.request().method() === "PATCH") {
          const update = route.request().postDataJSON();
          requests.push(update);
          if (requests.length === 1) {
            await route.fulfill({
              status: 503,
              json: {
                error: { code: "unavailable", message: "Could not save project", retryable: true },
              },
            });
            return;
          }
          project = { ...project, ...update };
        }
        await route.fulfill({ json: project });
      });
      try {
        await page.goto(`${origin}/${hash}`);
        const header = page.locator(".project-head").first();
        await expectPage(header.getByRole("button", { name: /^Configure / })).toBeVisible();
        await expectPage(header.locator(".project-name")).toHaveCSS("font-size", "18px");
        await expectPage(header.getByRole("button")).toHaveCount(2);
        expectPage(
          await header
            .locator("use")
            .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href"))),
        ).toEqual(["#i-gear", "#i-bin"]);
        expectPage(
          await header.evaluate((node) =>
            node.parentElement?.lastElementChild?.classList.contains("project-new-orb-row"),
          ),
        ).toBe(true);
        await header.getByRole("button", { name: /^Configure / }).click();
        const dialog = page.getByRole("dialog");
        const general = dialog.getByRole("tabpanel", { name: "General", exact: true });
        await general.getByLabel("Name", { exact: true }).fill("Updated project");
        await general
          .getByLabel("Repository URL", { exact: true })
          .fill("https://github.com/acme/repo/tree/main");
        await expectPage(general.getByRole("button", { name: "save", exact: true })).toBeDisabled();
        await expectPage(general.getByRole("alert")).toBeVisible();
        expectPage(requests).toHaveLength(0);
        await dialog.getByRole("tab", { name: "Secrets", exact: true }).click();
        await dialog.getByRole("tab", { name: "General", exact: true }).click();
        await expectPage(general.getByLabel("Name", { exact: true })).toHaveValue(
          "Updated project",
        );
        await expectPage(general.getByLabel("Repository URL", { exact: true })).toHaveValue(
          "https://github.com/acme/repo/tree/main",
        );
        await general
          .getByLabel("Repository URL", { exact: true })
          .fill("git@github.com:acme/new.git");
        await expectPage(general.getByRole("button", { name: "save", exact: true })).toBeEnabled();
        await general.getByRole("button", { name: "save", exact: true }).click();
        await expectPage(general.getByRole("alert")).toBeVisible();
        await expectPage(general.getByLabel("Name", { exact: true })).toHaveValue(
          "Updated project",
        );
        await expectPage(general.getByLabel("Repository URL", { exact: true })).toHaveValue(
          "git@github.com:acme/new.git",
        );
        await dialog.getByRole("tab", { name: "Secrets", exact: true }).click();
        await dialog.getByRole("tab", { name: "General", exact: true }).click();
        await expectPage(general.getByRole("alert")).toBeVisible();
        await general.getByRole("button", { name: "save", exact: true }).click();
        await expectPage(
          header.getByRole("heading", { name: "Updated project", exact: true }),
        ).toBeVisible();
        expectPage(requests).toEqual([
          { name: "Updated project", repositoryUrl: "https://github.com/acme/new.git" },
          { name: "Updated project", repositoryUrl: "https://github.com/acme/new.git" },
        ]);
        await expectPage(general.getByLabel("Repository URL", { exact: true })).toHaveValue(
          "https://github.com/acme/new.git",
        );
        if (hash) await expectPage(page).toHaveTitle(/Updated project/);
        await dialog.getByRole("button", { name: "Close project config" }).click();
        await header.getByRole("button", { name: /^Configure / }).click();
        await expectPage(
          page
            .getByRole("tabpanel", { name: "General", exact: true })
            .getByLabel("Name", { exact: true }),
        ).toHaveValue("Updated project");
      } finally {
        await page.close();
      }
    },
  );

  it("keeps native selection visible on normal and inverted surfaces", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/`);
      await expectPage(
        page.getByRole("heading", { name: "New project", exact: true }),
      ).toBeVisible();
      const styles = await page.locator("body").evaluate((body) => {
        const document = body.ownerDocument;
        const window = document.defaultView;
        if (window === null) return [];
        const surfaces: (typeof body)[] = [];
        for (const tag of ["input", "textarea"] as const) {
          const control = document.createElement(tag);
          control.value = "Selected text";
          document.body.append(control);
          control.focus();
          control.setSelectionRange(0, 8);
          surfaces.push(control);
        }
        const dark = document.createElement("span");
        dark.className = "user-code";
        dark.textContent = "Selected code";
        document.body.append(dark);
        const range = document.createRange();
        range.selectNodeContents(dark);
        document.getSelection()?.removeAllRanges();
        document.getSelection()?.addRange(range);
        surfaces.push(dark, document.body);
        const results = surfaces.map((element) => {
          if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") element.focus();
          const selected = window.getComputedStyle(element, "::selection");
          return { background: selected.backgroundColor, color: selected.color };
        });
        for (const element of surfaces) if (element !== document.body) element.remove();
        return results;
      });
      expectPage(styles).toEqual(
        Array.from({ length: 4 }, () => ({
          background: "rgb(153, 153, 153)",
          color: "rgb(0, 0, 0)",
        })),
      );
    } finally {
      await page.close();
    }
  });

  it("keeps the index and conversation visible until an orb switch is ready", async () => {
    const page = await browser.newPage();
    await page.goto(`${origin}/${ORB_HASH}`);
    const composer = page.getByPlaceholder(/Message the orb/);
    await composer.fill("draft for the first orb");
    const index = page.getByRole("navigation", { name: "Project orbs" });
    const destination = index.locator('a[href="#/orbs/frontend-auth-copy-test"]');
    await expectPage(destination).toBeVisible();
    const indexNode = await index.elementHandle();
    const destinationNode = await destination.elementHandle();
    const oldHistory = await page.locator(".history").innerText();
    let release = () => {};
    let arrived = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requested = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    await page.route("**/api/v1/orbs/frontend-auth-copy-test/history", async (route) => {
      const response = await route.fetch();
      arrived();
      await gate;
      await route.fulfill({ response });
    });
    try {
      await destination.click();
      await requested;
      await expectPage(destination).toHaveAttribute("aria-current", "page");
      await expectPage(index).toHaveAttribute("aria-busy", "true");
      await expectPage(page.locator(".orb-main")).toHaveAttribute("inert", "");
      await expectPage(composer).toHaveValue("draft for the first orb");
      expectPage(await page.locator(".history").innerText()).toBe(oldHistory);
      release();
      await expectPage(index).toHaveAttribute("aria-busy", "false");
      await expectPage(page.getByText("COPY-2468")).toBeVisible();
      await expectPage(composer).toHaveValue("");
      expectPage(
        await indexNode?.evaluate(
          (node) => node === node.ownerDocument.querySelector(".orb-index"),
        ),
      ).toBe(true);
      expectPage(await destinationNode?.evaluate((node) => node.isConnected)).toBe(true);
      await index.locator(`a[href="${ORB_HASH}"]`).click();
      await expectPage(index).toHaveAttribute("aria-busy", "false");
      await expectPage(composer).toHaveValue("draft for the first orb");
      await expectPage(composer).toBeFocused();
    } finally {
      release();
      await page.close();
    }
  });

  it("discards a superseded orb load and preserves missing-resource URLs", async () => {
    const page = await browser.newPage();
    await page.goto(`${origin}/${ORB_HASH}`);
    const index = page.getByRole("navigation", { name: "Project orbs" });
    const destination = index.locator('a[href="#/orbs/frontend-auth-copy-test"]');
    await expectPage(destination).toBeVisible();
    let release = () => {};
    let arrived = () => {};
    let finished = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requested = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const completed = new Promise<void>((resolve) => {
      finished = resolve;
    });
    await page.route("**/api/v1/orbs/frontend-auth-copy-test/history", async (route) => {
      const response = await route.fetch();
      arrived();
      await gate;
      await route.fulfill({ response });
      finished();
    });
    try {
      await destination.click();
      await requested;
      await index.evaluate((node) => {
        node.ownerDocument.location.hash = "#/orbs/missing-switch-target";
      });
      await expectPage(page.getByText("Orb doesn't exist")).toBeVisible();
      const response = page.waitForResponse("**/api/v1/orbs/frontend-auth-copy-test/history");
      release();
      await completed;
      await (await response).finished();
      // A browser task after the response lets React process any stale completion.
      await index.evaluate(
        (node) =>
          new Promise<void>((resolve) =>
            node.ownerDocument.defaultView?.requestAnimationFrame(() => resolve()),
          ),
      );
      await expectPage(page.getByText("Orb doesn't exist")).toBeVisible();
      expectPage(page.url()).toBe(`${origin}/#/orbs/missing-switch-target`);
      await expectPage(page.getByRole("link", { name: "Back to dashboard" })).toBeVisible();
    } finally {
      release();
      await page.close();
    }
  });

  it("inserts orb URLs at typed @ and preserves cancelled mentions and shell input", async () => {
    const page = await browser.newPage();
    await page.goto(`${origin}/${ORB_HASH}`);
    const composer = page.getByPlaceholder(/Message the orb/);
    await composer.fill("before replace after");
    await composer.evaluate((element) => element.setSelectionRange(7, 14));
    await composer.press("@");
    const dialog = page.getByRole("dialog", { name: "Find orbs" });
    await expectPage(dialog).toBeVisible();
    await expectPage(composer).toHaveValue("before @ after");
    await dialog.getByRole("searchbox").fill("Finished design");
    await expectPage(dialog.getByRole("link")).toHaveCount(1);
    await dialog.getByRole("searchbox").press("Enter");
    const inserted = `${origin}/#/orbs/frontend-archived-orb`;
    await expectPage(composer).toHaveValue(`before ${inserted} after`);
    await expectPage(composer).toBeFocused();
    expectPage(page.url()).toBe(`${origin}/${ORB_HASH}`);
    await composer.press("@");
    await dialog.getByRole("searchbox").fill("Frontend");
    await dialog.getByRole("link").first().focus();
    await page.keyboard.press("Escape");
    await expectPage(dialog).toBeHidden();
    await expectPage(composer).toBeFocused();
    await expectPage(composer).toHaveValue(`before ${inserted}@ after`);
    await composer.press("x");
    await expectPage(composer).toHaveValue(`before ${inserted}@x after`);

    await composer.fill("");
    await composer.press("!");
    const shell = page.getByPlaceholder(/Run a shell command/);
    await shell.press("@");
    await expectPage(shell).toHaveValue("@");
    await expectPage(dialog).toBeHidden();
    await shell.fill("");
    await shell.press("!");
    await shell.press("@");
    await expectPage(shell).toHaveValue("@");
    await expectPage(dialog).toBeHidden();
    await page.close();
  });

  it("uses full-cell block cursors and keeps the composer caret aligned during native editing", async () => {
    const page = await browser.newPage({ reducedMotion: "reduce" });
    await page.goto(`${origin}/${ORB_HASH}`);
    const composer = page.getByPlaceholder(/Message the orb/);
    const caret = page.locator(".composer-caret");
    await composer.fill("abc\ndef");
    await expectPage(caret).toBeVisible();
    await expectPage(caret).toHaveCSS("height", "20px");
    const position = () =>
      caret.evaluate((element) => ({
        left: Number.parseFloat(element.style.left),
        top: Number.parseFloat(element.style.top),
      }));
    const end = await position();
    expectPage(end.top).toBe(20);
    await composer.press("Home");
    await expectPage.poll(position).toEqual({ left: 0, top: 20 });
    await composer.press("ArrowUp");
    await expectPage.poll(position).toEqual({ left: 0, top: 0 });
    await composer.press("Shift+ArrowRight");
    await expectPage(caret).toBeHidden();
    await composer.press("ArrowRight");
    await expectPage(caret).toBeVisible();

    await composer.dispatchEvent("compositionstart");
    await expectPage(caret).toBeHidden();
    await expectPage(composer).toHaveAttribute("data-block-caret", "false");
    await composer.dispatchEvent("compositionend");
    await expectPage(caret).toBeVisible();

    await composer.fill("x".repeat(400));
    await composer.evaluate((element) => {
      element.style.width = "160px";
    });
    await expectPage.poll(async () => (await position()).top).toBeGreaterThan(0);
    await composer.evaluate((element) => {
      element.setSelectionRange(0, 0);
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll"));
    });
    await expectPage.poll(position).toEqual({ left: 0, top: 0 });
    await composer.fill(Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n"));
    await expectPage(caret).toBeVisible();
    expectPage((await position()).top).toBeLessThan(80);

    // A stable presentation specimen avoids racing a transient streamed delta.
    await page.locator(".composer-editor").evaluate((element) => {
      const working = element.ownerDocument.createElement("span");
      working.className = "cur";
      working.dataset["testWorking"] = "true";
      element.append(working);
    });
    const working = page.locator('[data-test-working="true"]');
    await expectPage(working).toHaveCSS("height", "20px");
    expectPage(await working.evaluate((el) => el.getBoundingClientRect().width)).toBe(
      await caret.evaluate((el) => el.getBoundingClientRect().width),
    );
    await page.getByRole("button", { name: "terminal", exact: true }).click();
    await expectPage(caret).toBeHidden();
    const terminalCursor = page.locator(".term-cursor").first();
    await expectPage(terminalCursor).toBeAttached();
    const terminal = page.locator(".orb-terminal-emulator.wterm");
    await expectPage(terminal).toHaveCSS("font-size", "13px");
    await expectPage(terminal).toHaveCSS("--term-row-height", "20px");
    await page.close();
  });

  it("shows the ribbon and recovers session, route, and composer draft in the same tab", async () => {
    const page = await browser.newPage();
    await page.goto(`${origin}/${ORB_HASH}`);

    const draft = "Keep this exact draft through IAP sign-in";
    const composer = page.getByPlaceholder(/Message the orb/);
    await composer.fill(draft);

    await page.getByRole("button", { name: "expire session" }).click();
    const ribbon = page.locator(".session-ribbon");
    await expectPage(ribbon).toContainText("session expired");
    await expectPage(composer).toHaveValue(draft);

    const loaded = page.waitForEvent("load");
    await ribbon.getByRole("button", { name: "sign in again" }).click();
    await loaded;

    await expectPage(page).toHaveURL(`${origin}/${ORB_HASH}`);
    await expectPage(page.getByRole("alert")).toHaveCount(0);
    await expectPage(page.getByText("frontend fixture · session active")).toBeVisible();
    await expectPage(page.getByPlaceholder(/Message the orb/)).toHaveValue(draft);

    await page.close();
  });

  it("shows hosted files on an archived orb and preserves a missing orb URL", async () => {
    const page = await browser.newPage();
    await page.goto(`${origin}/#/orbs/frontend-archived-orb`);
    await expectPage(page.getByText("files (1)")).toBeVisible();
    await page.getByText("files (1)").click();
    const file = page.getByRole("link", { name: "index.html" });
    await expectPage(file).toHaveAttribute(
      "href",
      "http://files.localhost:7100/s/frontend-archived-orb/index.html",
    );
    await expectPage(page.getByPlaceholder(/Message the orb/)).toHaveCount(0);

    await page.goto(`${origin}/#/orbs/missing-hosted-files-orb`);
    await expectPage(page).toHaveURL(`${origin}/#/orbs/missing-hosted-files-orb`);
    await expectPage(page.getByRole("heading", { name: "Orb doesn't exist" })).toBeVisible();
    await page.close();
  });
});
