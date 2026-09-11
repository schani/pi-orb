import { randomUUID } from "node:crypto";
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
      plugins: [
        {
          name: "test-history-render-count",
          enforce: "pre",
          transform(code, id) {
            if (!id.endsWith("/components/HistoryView.tsx")) return;
            // Count function executions, not DOM mutations: React can reparse the
            // entire transcript without changing a single DOM node.
            return code.replace(
              "const representedMessageIds =",
              'Reflect.set(globalThis, "__historyRenders", (Reflect.get(globalThis, "__historyRenders") ?? 0) + 1); const representedMessageIds =',
            );
          },
        },
      ],
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
      if (modal === "MCPs")
        await dialog.getByRole("button", { name: "add server", exact: true }).click();
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
        const name = dialog
          .getByRole("tabpanel", { name: "MCPs", exact: true })
          .getByLabel("Name", { exact: true });
        await name.fill("analytics");
        await page.clock.runFor(2000);
        await expectPage(name).toBeFocused();
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
      let tokenSaved = false;
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
        const body = await response.json();
        await route.fulfill({
          response,
          json: tokenSaved
            ? {
                ...body,
                items: [...body.items, { name: "TOKEN", updatedAt: new Date(0).toISOString() }],
              }
            : body,
        });
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
        tokenSaved = true;
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
        await mcp.getByRole("button", { name: "add server", exact: true }).click();
        await mcp.getByRole("button", { name: "preset", exact: true }).click();
        await mcp.getByRole("button", { name: "PostHog", exact: true }).click();
        await expectPage(mcp.getByLabel("Token secret", { exact: true })).toHaveValue(
          "POSTHOG_KEY",
        );
        await mcp.getByLabel("Name", { exact: true }).fill("custom");
        await mcp.getByLabel("Endpoint", { exact: true }).fill("https://example.com/mcp");
        await expectPage(mcp.getByLabel("Token secret", { exact: true })).toHaveValue(
          "POSTHOG_KEY",
        );
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
        await expectPage(mcp.getByLabel("Token secret", { exact: true })).toHaveValue(
          "POSTHOG_KEY",
        );
        const headers = { Authorization: { secret: "TOKEN", prefix: "Bearer " } };
        await mcp.getByLabel("Token secret", { exact: true }).selectOption("TOKEN");
        await mcp.getByRole("button", { name: "add server", exact: true }).click();
        await expectPage(mcp.locator("summary").filter({ hasText: "custom" })).toBeVisible();
        await expectPage(mcp.getByLabel("Token secret", { exact: true })).toHaveValue("TOKEN");
        expectPage(saved).toEqual({
          revision: 0,
          servers: [
            { name: "custom", url: "https://example.com/mcp", description: "Analytics", headers },
          ],
        });
        const summary = mcp.locator("summary").filter({ hasText: "custom" });
        await expectPage(summary).toBeFocused();
        await page.keyboard.press("Enter");
        await expectPage(mcp.getByLabel("Description", { exact: true })).toBeHidden();
        await page.keyboard.press("Enter");
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

  it("exercises the real ledger UI, fixture OAuth, disclosure ownership and consistent tab spacing", async () => {
    const page = await browser.newPage();
    const projectId = randomUUID();
    const connectionId = randomUUID();
    try {
      const created = await page.request.post(`${origin}/api/v1/projects`, {
        data: {
          id: projectId,
          name: "MCP ledger test",
          repositoryUrl: "https://github.com/example/ledger",
        },
      });
      expectPage(created.status()).toBe(201);
      const secretCreated = await page.request.put(
        `${origin}/api/v1/projects/${projectId}/secrets/TOKEN`,
        { data: { value: "fixture-token" } },
      );
      expectPage(secretCreated.status()).toBe(200);
      expectPage(
        (
          await page.request.put(`${origin}/api/v1/projects/${projectId}/secrets/EXTRA`, {
            data: { value: "extra-fixture" },
          })
        ).status(),
      ).toBe(200);
      const seeded = await page.request.put(`${origin}/api/v1/projects/${projectId}/mcp`, {
        data: {
          revision: 0,
          servers: [
            {
              name: "alpha",
              url: "https://example.com/mcp",
              description: "Alpha",
              headers: {},
              oauth: { id: connectionId },
            },
            {
              name: "beta",
              url: "https://example.org/mcp",
              description: "Beta",
              headers: { Authorization: { secret: "TOKEN", prefix: "Bearer " } },
            },
          ],
        },
      });
      expectPage(seeded.status()).toBe(200);
      const blocked = await page.request.delete(
        `${origin}/api/v1/projects/${projectId}/secrets/TOKEN`,
      );
      expectPage(blocked.status()).toBe(409);
      expectPage((await blocked.json()).error.message).toContain("beta");
      await page.goto(`${origin}/#/projects/${projectId}/mcp`);
      const dialog = page.getByRole("dialog");
      const mcp = dialog.getByRole("tabpanel", { name: "MCPs", exact: true });
      const alpha = mcp
        .locator("details")
        .filter({ has: page.locator("summary", { hasText: "alpha" }) });
      const beta = mcp
        .locator("details")
        .filter({ has: page.locator("summary", { hasText: "beta" }) });
      await expectPage(alpha.locator("summary")).toContainText("authorization required");
      await expectPage(mcp.locator(".mcp-add-heading")).toHaveCount(0);
      await alpha.locator("summary").focus();
      await page.keyboard.press("Enter");
      await alpha.getByLabel("Description", { exact: true }).fill("Kept while collapsed");
      await beta.locator("summary").click();
      await expectPage(mcp.locator("details[open]")).toHaveCount(1);
      await alpha.locator("summary").click();
      await expectPage(alpha.getByLabel("Description", { exact: true })).toHaveValue(
        "Kept while collapsed",
      );
      await alpha.getByRole("button", { name: "connect", exact: true }).click();
      await expectPage(page).toHaveURL(/mcp-preview-consent=/);
      await expectPage(alpha.locator("summary")).toContainText("connected");
      await alpha.locator("summary").click();
      await alpha.getByRole("button", { name: "disconnect", exact: true }).click();
      await expectPage(alpha.locator("summary")).toContainText("authorization required");
      await mcp
        .locator(".mcp-add-area")
        .getByRole("button", { name: "add server", exact: true })
        .click();
      const add = mcp.locator(".mcp-add-area");
      await add.getByLabel("Name", { exact: true }).fill("new-service");
      await add.getByLabel("Endpoint", { exact: true }).fill("https://example.net/mcp");
      await add.getByRole("button", { name: "add & connect", exact: true }).click();
      await expectPage(mcp.locator("summary").filter({ hasText: "new-service" })).toContainText(
        "connected",
      );
      await dialog.getByRole("tab", { name: "Secrets", exact: true }).click();
      const secretRow = dialog
        .getByRole("tabpanel", { name: "Secrets", exact: true })
        .locator(".project-secret-row")
        .filter({ hasText: "TOKEN" });
      await expectPage(secretRow).toContainText("used by beta");
      await expectPage(
        secretRow.getByRole("button", { name: "remove", exact: true }),
      ).toBeDisabled();
      await expectPage(
        secretRow.getByRole("button", { name: "replace", exact: true }),
      ).toBeEnabled();
      await dialog.getByRole("tab", { name: "MCPs", exact: true }).click();
      await beta.locator("summary").click();
      const tokenSelect = beta.getByLabel("Token secret", { exact: true });
      await expectPage(tokenSelect).toHaveJSProperty("tagName", "SELECT");
      await expectPage(tokenSelect.locator('option[value="TOKEN"]')).toBeEnabled();
      await expectPage(tokenSelect.locator("option")).toHaveText([
        "Select a secret",
        "EXTRA",
        "TOKEN",
      ]);
      const spacing = [];
      for (const tab of ["MCPs", "Secrets", "General"]) {
        await dialog.getByRole("tab", { name: tab, exact: true }).click();
        const body = dialog
          .getByRole("tabpanel", { name: tab, exact: true })
          .locator(".project-secrets-body");
        spacing.push(
          await body.evaluate((el) => {
            const css = el.ownerDocument.defaultView?.getComputedStyle(el);
            return [css?.paddingTop, css?.paddingRight, css?.paddingBottom, css?.paddingLeft];
          }),
        );
      }
      expectPage(spacing).toEqual(Array(3).fill(["8px", "10px", "10px", "10px"]));
      const current = await (
        await page.request.get(`${origin}/api/v1/projects/${projectId}/mcp`)
      ).json();
      expectPage(
        (
          await page.request.put(`${origin}/api/v1/projects/${projectId}/mcp`, {
            data: {
              ...current,
              servers: current.servers.filter((s: { name: string }) => s.name !== "beta"),
            },
          })
        ).status(),
      ).toBe(200);
      await dialog.getByRole("tab", { name: "Secrets", exact: true }).click();
      await expectPage(
        secretRow.getByRole("button", { name: "remove", exact: true }),
      ).toBeEnabled();
      page.once("dialog", (dialog) => dialog.accept());
      await secretRow.getByRole("button", { name: "remove", exact: true }).click();
      await expectPage(secretRow).toHaveCount(0);
      expectPage(
        (
          await page.request.put(`${origin}/api/v1/projects/${projectId}/mcp`, {
            data: { ...current, revision: current.revision + 1 },
          })
        ).status(),
      ).toBe(409);
      await dialog.getByRole("tab", { name: "MCPs", exact: true }).click();
      await page.setViewportSize({ width: 390, height: 844 });
      expectPage(
        await dialog.evaluate((el) => el.getBoundingClientRect().width),
      ).toBeLessThanOrEqual(366);
    } finally {
      await page.request.delete(`${origin}/api/v1/projects/${projectId}`);
      await page.close();
    }
  });

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

  it("uploads arbitrary files in chunks without touching the draft and hides upload when stopped", async () => {
    const page = await browser.newPage();
    await page.goto(`${origin}/${ORB_HASH}`);
    const draft = page.getByPlaceholder(/Message the orb/);
    await draft.fill("Keep this draft");
    const chunks: Promise<number>[] = [];
    page.on("response", (response) => {
      const request = response.request();
      if (request.method() === "PUT" && request.url().includes("/chunk?")) {
        const offset = Number(new URL(request.url()).searchParams.get("offset"));
        // Routing the finish request omits browser-added Content-Length from
        // Playwright's request view. Measure bytes counted by the server instead.
        chunks.push(response.json().then((row: { offset: number }) => row.offset - offset));
      }
    });
    let release = () => {};
    let arrived = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finishing = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    await page.route("**/uploads/*/finish", async (route) => {
      arrived();
      await gate;
      await route.continue();
    });
    try {
      const choosing = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: "Upload files", exact: true }).click();
      await (await choosing).setFiles({
        name: "fixture.bin",
        mimeType: "application/octet-stream",
        buffer: Buffer.alloc(4 * 1024 * 1024 + 13, 0xff),
      });
      await finishing;
      await expectPage(page.getByRole("dialog")).toHaveCount(0);
      await expectPage(page.getByRole("region", { name: "File transfers" })).toContainText(
        "finalizing",
      );
      expectPage(await Promise.all(chunks)).toEqual([4 * 1024 * 1024, 13]);
    } finally {
      release();
    }
    await expectPage(page.getByRole("region", { name: "File transfers" })).toHaveCount(0);
    await expectPage(draft).toHaveValue("Keep this draft");
    await expectPage(page.locator(".history")).toContainText("The user uploaded a file");
    await page.getByRole("button", { name: "Stop orb", exact: true }).click();
    await expectPage(page.getByRole("button", { name: "Start orb", exact: true })).toBeVisible();
    await expectPage(page.getByRole("button", { name: "Upload files", exact: true })).toHaveCount(
      0,
    );
    await page.getByRole("button", { name: "Start orb", exact: true }).click();
    await expectPage(page.getByRole("button", { name: "Upload files", exact: true })).toBeVisible();
    await page.close();
  });

  it("sends one message for a multi-file selection, including after one file needs retry", async () => {
    const page = await browser.newPage();
    let batchId = "";
    let secondId = "";
    let registrations = 0;
    let failSecond = true;
    await page.route("**/uploads", async (route) => {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON() as {
          id: string;
          files: { id: string; name: string }[];
        };
        batchId = body.id;
        secondId = body.files.find((file) => file.name === "batch-second.bin")?.id ?? "";
        registrations++;
      }
      await route.continue();
    });
    await page.route("**/uploads/*/chunk?*", async (route) => {
      if (failSecond && route.request().url().includes(secondId)) {
        failSecond = false;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "unavailable", message: "second file interrupted", retryable: true },
          }),
        });
      } else await route.continue();
    });
    const messages = async () => {
      const response = await page.request.get(
        `${origin}/api/v1/orbs/${ORB_HASH.split("/").at(-1)}/messages`,
      );
      return (
        (await response.json()) as { items: { id: string; content: unknown }[] }
      ).items.filter((row) => row.id === batchId);
    };
    try {
      await page.goto(`${origin}/${ORB_HASH}`);
      const choosing = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: "Upload files", exact: true }).click();
      await (await choosing).setFiles(
        ["batch-first.bin", "batch-second.bin"].map((name) => ({
          name,
          mimeType: "application/octet-stream",
          buffer: Buffer.from([0, 255, 1]),
        })),
      );
      const transfers = page.getByRole("region", { name: "File transfers" });
      await expectPage(transfers).toContainText("stored · notification pending");
      await expectPage(transfers).toContainText("second file interrupted");
      expectPage(await messages()).toHaveLength(0);
      await transfers
        .locator(".workspace-upload-row")
        .filter({ hasText: "batch-second.bin" })
        .getByRole("button", { name: "retry", exact: true })
        .click();
      await expectPage(transfers).toHaveCount(0);
      const accepted = await messages();
      expectPage(accepted).toHaveLength(1);
      expectPage(JSON.stringify(accepted[0]?.content)).toContain("batch-first.bin");
      expectPage(JSON.stringify(accepted[0]?.content)).toContain("batch-second.bin");
      expectPage(registrations).toBe(1);
    } finally {
      await page.close();
    }
  });

  it("starts another selection while an earlier upload is still sending", async () => {
    const page = await browser.newPage();
    let release = () => {};
    let arrived = () => {};
    let holdFirst = true;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sending = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    await page.route("**/uploads/*/chunk?*", async (route) => {
      if (holdFirst) {
        holdFirst = false;
        arrived();
        await gate;
      }
      await route.continue();
    });
    const choose = async (name: string) => {
      const choosing = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: "Upload files", exact: true }).click();
      await (await choosing).setFiles({
        name,
        mimeType: "application/octet-stream",
        buffer: Buffer.from([1, 0, 255]),
      });
    };
    try {
      await page.goto(`${origin}/${ORB_HASH}`);
      await choose("held-first.bin");
      await sending;
      await choose("independent-second.bin");
      await expectPage(page.locator(".history")).toContainText("independent-second.bin");
      await expectPage(page.getByRole("region", { name: "File transfers" })).toContainText(
        "held-first.bin",
      );
      release();
      await expectPage(page.getByRole("region", { name: "File transfers" })).toHaveCount(0);
      await expectPage(page.locator(".history")).toContainText("held-first.bin");
    } finally {
      release();
      await page.close();
    }
  });

  it("keeps automatic-upload failures inline and retries the same file identity", async () => {
    const page = await browser.newPage();
    let failChunk = true;
    const ids = new Set<string>();
    await page.route("**/uploads/*/chunk?*", async (route) => {
      ids.add(new URL(route.request().url()).pathname.split("/").at(-2) ?? "");
      if (failChunk) {
        failChunk = false;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "unavailable", message: "test upload interruption", retryable: true },
          }),
        });
      } else await route.continue();
    });
    try {
      await page.goto(`${origin}/${ORB_HASH}`);
      const choosing = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: "Upload files", exact: true }).click();
      await (await choosing).setFiles({
        name: "retry-direct.bin",
        mimeType: "application/octet-stream",
        buffer: Buffer.from([0, 255, 1]),
      });
      const transfers = page.getByRole("region", { name: "File transfers" });
      await expectPage(transfers).toContainText("test upload interruption");
      await expectPage(page.getByRole("dialog")).toHaveCount(0);
      await transfers.getByRole("button", { name: "retry", exact: true }).click();
      await expectPage(transfers).toHaveCount(0);
      await expectPage(page.locator(".history")).toContainText("retry-direct.bin");
      expectPage(ids.size).toBe(1);
    } finally {
      await page.close();
    }
  });

  it("skips unchanged long history while typing and still renders sent/live messages", async () => {
    const page = await browser.newPage();
    try {
      // Hold live replay and inbox responses before navigation: an initial
      // sync can otherwise race the typing assertion and legitimately render.
      let releaseLive = () => {};
      await page.routeWebSocket("**/orbs/frontend-long-history/live", (socket) => {
        const server = socket.connectToServer();
        const buffered: (string | Buffer)[] = [];
        let released = false;
        server.onMessage((message) => {
          if (released) socket.send(message);
          else buffered.push(message);
        });
        releaseLive = () => {
          released = true;
          for (const message of buffered) socket.send(message);
          buffered.length = 0;
        };
      });
      await page.route("**/api/v1/orbs/frontend-long-history/messages", (route) => route.abort());
      await page.goto(`${origin}/#/orbs/frontend-long-history`);
      const composer = page.getByPlaceholder(/Message the orb/);
      await expectPage(page.locator(".history .rec-you")).toHaveCount(100);
      await expectPage(page.locator(".history")).toContainText("Review 100");
      // The fixture is idle. Gate background history/inbox refreshes so this
      // assertion measures only draft updates, not unrelated polling commits.
      await page.route("**/api/v1/orbs/frontend-long-history/history", (route) => route.abort());
      const before = await page.evaluate(
        () => Reflect.get(globalThis, "__historyRenders") as number,
      );
      expectPage(before).toBeGreaterThan(0);
      await composer.pressSequentially("typing must not reparse history");
      await expectPage(composer).toHaveValue("typing must not reparse history");
      expectPage(await page.evaluate(() => Reflect.get(globalThis, "__historyRenders"))).toBe(
        before,
      );
      await page.unroute("**/api/v1/orbs/frontend-long-history/history");
      await page.unroute("**/api/v1/orbs/frontend-long-history/messages");
      releaseLive();
      await composer.press("Control+Enter");
      await expectPage(composer).toHaveValue("");
      await expectPage(page.locator(".history .rec-you").last()).toContainText(
        "typing must not reparse history",
      );
      await expectPage(page.locator(".history .rec-orb").last()).toContainText(
        "typing must not reparse history",
      );
      expectPage(
        await page.evaluate(() => Reflect.get(globalThis, "__historyRenders")),
      ).toBeGreaterThan(before);
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
