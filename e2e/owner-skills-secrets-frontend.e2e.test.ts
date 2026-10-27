import { expect as check, type Locator, type Page } from "@playwright/test";
import { it } from "vitest";
import { gotoFrontendFixture } from "./testkit/frontend-fixture.ts";
import { createFrontendFixture } from "./testkit/frontend-owned.ts";

const skill = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n`;
const editor = (row: Locator) => row.getByRole("textbox", { name: "SKILL.md", exact: true });
const button = (scope: Locator, name: string) => scope.getByRole("button", { name, exact: true });

async function openSettings(page: Page, tab: string) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await dialog.getByRole("tab", { name: tab, exact: true }).click();
  return dialog;
}

it.each(["chromium", "webkit"] as const)(
  "%s owner Settings: skills with retained drafts, and owner secrets",
  async (engine) => {
    const fixture = await createFrontendFixture(engine, {
      page: { viewport: { width: 1440, height: 900 } },
    });
    const { page, origin } = fixture;
    let releaseWrite = () => {};
    fixture.cleanup(async () => releaseWrite());
    let heldWrite = Promise.resolve();
    await page.route("**/api/v1/owner-skills**", async (route) => {
      if (route.request().method() !== "GET") await heldWrite;
      await route.continue();
    });
    const confirmed: string[] = [];
    page.on("dialog", (dialog) => {
      confirmed.push(dialog.message());
      void dialog.accept();
    });
    await gotoFrontendFixture(page, `${origin}/`);
    const dialog = await openSettings(page, "Skills");
    const panel = dialog.getByRole("tabpanel", { name: "Skills", exact: true });
    const summaries = panel.locator("summary");
    const pg = "pg-migrations · Write PostgreSQL migrations that are safe on a live database.";
    await check(summaries).toHaveText([
      pg,
      "release-notes · Draft release notes from merged PRs since the last tag.",
    ]);
    const row = (name: string | RegExp) =>
      panel
        .locator("details")
        .filter({ has: page.locator(".activity-rail-summary", { hasText: name }) });

    // A rejected save stays inline in its row and keeps the draft.
    const release = row("release-notes");
    await release.locator("summary").click();
    await check(button(release, "Save")).toBeDisabled();
    const invalid = "---\nname: release-notes\n---\n";
    await editor(release).fill(invalid);
    await button(release, "Save").click();
    await check(release.getByRole("alert")).toContainText("description");
    await check(editor(release)).toHaveValue(invalid);

    // Drafts survive tab switches and close/reopen.
    const renamed = skill("changelog", "Release notes, renamed.");
    await editor(release).fill(renamed);
    await check(release.getByRole("alert")).toHaveCount(0);
    await dialog.getByRole("tab", { name: "Git", exact: true }).click();
    await page.keyboard.press("Escape");
    await check(dialog).toHaveCount(0);
    await openSettings(page, "Skills");
    await check(editor(release)).toBeVisible();
    await check(editor(release)).toHaveValue(renamed);

    // A pending save owns the dialog; a frontmatter rename replaces the row.
    heldWrite = new Promise((resolve) => {
      releaseWrite = resolve;
    });
    await button(release, "Save").click();
    await check(button(dialog, "Close settings")).toBeDisabled();
    await check(dialog.getByRole("tab", { name: "Git", exact: true })).toBeDisabled();
    await check(editor(release)).toBeDisabled();
    await check(button(release, "remove")).toBeDisabled();
    releaseWrite();
    await check(row("changelog")).toContainText("Saved · next orb start");
    await check(summaries).toHaveText(["changelog · Release notes, renamed.", pg]);

    // Add: cancel returns to the action, a duplicate is rejected inline, then create.
    const add = button(panel, "add skill");
    await add.click();
    const fresh = row(/^new skill$/);
    await check(editor(fresh)).toBeFocused();
    await button(fresh, "cancel").click();
    await check(fresh).toHaveCount(0);
    await check(add).toBeFocused();
    await add.click();
    await editor(fresh).fill(skill("pg-migrations", "Duplicate."));
    await button(fresh, "Save").click();
    await check(fresh.getByRole("alert")).toContainText("pg-migrations already exists");
    await editor(fresh).fill(skill("screenshots", "Capture screenshots."));
    await button(fresh, "Save").click();
    await check(row("screenshots")).toContainText("Saved · next orb start");
    await check(fresh).toHaveCount(0);
    await button(row("screenshots"), "remove").click();
    await check(summaries).toHaveText(["changelog · Release notes, renamed.", pg]);
    check(confirmed).toEqual(["Remove screenshots from every orb on its next start?"]);

    // Owner secrets: the project Secrets pane, owner-scoped.
    await dialog.getByRole("tab", { name: "Secrets", exact: true }).click();
    await check(dialog.locator("header p")).toHaveText("Changes apply on next start");
    const secrets = dialog.getByRole("tabpanel", { name: "Secrets", exact: true });
    const names = secrets.locator(".project-secret-name");
    await check(names).toHaveText(["DATADOG_API_KEY", "GITHUB_TOKEN"]);
    await secrets.getByRole("textbox", { name: "name", exact: true }).fill("NPM_TOKEN");
    await secrets.getByLabel("secret value", { exact: true }).fill("npm-owner-secret");
    await button(secrets, "save secret").click();
    await check(names).toHaveText(["DATADOG_API_KEY", "GITHUB_TOKEN", "NPM_TOKEN"]);
    const datadog = secrets.locator(".project-secret-row").filter({ hasText: "DATADOG_API_KEY" });
    await button(datadog, "remove").click();
    await check(names).toHaveText(["GITHUB_TOKEN", "NPM_TOKEN"]);
    check(confirmed.at(-1)).toBe("Remove DATADOG_API_KEY from every orb on its next start?");
  },
);

/** Every element box inside the pane, relative to the pane. */
function paneGeometry(pane: Locator) {
  return pane.evaluate((root) => {
    const origin = root.getBoundingClientRect();
    return [root, ...root.querySelectorAll("*")].map((element) => {
      const box = element.getBoundingClientRect();
      const name = `${element.tagName}.${element.getAttribute("class")}`;
      return [name, box.x - origin.x, box.y - origin.y, box.width, box.height];
    });
  });
}

it.each(["chromium", "webkit"] as const)(
  "%s Settings Secrets pane has the project Config Secrets geometry",
  async (engine) => {
    const { page, origin } = await createFrontendFixture(engine);
    const list = {
      revision: 1,
      items: [
        { name: "GITHUB_TOKEN", updatedAt: "2026-10-21T12:00:00.000Z" },
        { name: "NPM_TOKEN", updatedAt: "2026-09-30T12:00:00.000Z" },
      ],
    };
    for (const path of ["**/api/v1/owner-secrets", "**/api/v1/projects/*/secrets"])
      await page.route(path, (route) => route.fulfill({ json: list }));
    await gotoFrontendFixture(page, `${origin}/`);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const settings = await openSettings(page, "Secrets");
      const owner = settings
        .getByRole("tabpanel", { name: "Secrets" })
        .locator(".project-secrets-body");
      await check(owner.locator(".project-secret-row")).toHaveCount(2);
      const ownerBoxes = await paneGeometry(owner);
      await button(settings, "Close settings").click();
      await page
        .getByRole("button", { name: /^Configure / })
        .first()
        .click();
      const config = page.getByRole("dialog");
      await config.getByRole("tab", { name: "Secrets", exact: true }).click();
      const project = config
        .getByRole("tabpanel", { name: "Secrets" })
        .locator(".project-secrets-body");
      await check(button(project, "remove").first()).toBeEnabled();
      check(await paneGeometry(project)).toEqual(ownerBoxes);
      await button(config, "Close project config").click();
    }
  },
);

it.each([
  { engine: "chromium" as const, width: 1440 },
  { engine: "chromium" as const, width: 390 },
  { engine: "webkit" as const, width: 390 },
])(
  "$engine/$width GitHub draft preview, pinned Add and retained failures",
  async ({ engine, width }) => {
    const fixture = await createFrontendFixture(engine, {
      page: { viewport: { width, height: 900 } },
    });
    const { page, origin } = fixture;
    const url = "https://github.com/example/skills/tree/main/handbook";
    const sha = "a".repeat(40);
    const content = skill("handbook", "Write manuals.");
    const preview = {
      name: "handbook",
      description: "Write manuals.",
      content,
      source: { url, commitSha: sha },
      manifest: [
        { path: "SKILL.md", bytes: content.length, executable: false },
        { path: "assets/font.ttf", bytes: 7, executable: false },
        { path: "scripts/render.sh", bytes: 12, executable: true },
      ],
      fileCount: 3,
      totalBytes: content.length + 19,
    };
    const listItem = {
      name: preview.name,
      description: preview.description,
      content,
      source: preview.source,
      fileCount: preview.fileCount,
      totalBytes: preview.totalBytes,
      updatedAt: "2026-10-27T00:00:00Z",
    };
    let items: object[] = [];
    let failPreview = true;
    let failImport = true;
    let branchHead = sha;
    const imports: unknown[] = [];
    await page.route("**/api/v1/owner-skills**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/preview")) {
        if (failPreview)
          return route.fulfill({
            status: 503,
            json: {
              error: { code: "unavailable", message: "GitHub unavailable", retryable: true },
            },
          });
        return route.fulfill({ json: { ...preview, source: { url, commitSha: branchHead } } });
      }
      if (path.endsWith("/import")) {
        const body = route.request().postDataJSON();
        imports.push(body);
        if (failImport)
          return route.fulfill({
            status: 409,
            json: {
              error: { code: "conflict", message: "handbook already exists", retryable: false },
            },
          });
        items = [
          {
            ...listItem,
            source: { url: body.url, commitSha: body.commitSha },
            updatedAt: "2026-10-27T00:00:00Z",
          },
        ];
      } else if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON();
        items = [{ ...listItem, content: body.content, updatedAt: "2026-10-27T00:00:00Z" }];
      }
      return route.fulfill({ json: { items } });
    });
    await gotoFrontendFixture(page, `${origin}/`);
    const dialog = await openSettings(page, "Skills");
    const panel = dialog.getByRole("tabpanel", { name: "Skills", exact: true });
    await button(panel, "add skill").click();
    const fresh = panel
      .locator("details")
      .filter({ has: page.locator(".activity-rail-summary", { hasText: /^new skill$/ }) });
    const source = fresh.getByRole("combobox", { name: "Draft source" });
    await check(source).toHaveValue("manual");
    const raw = skill("manual-draft", "Keep this.");
    const invalid = "---\nname: manual-draft\n---\n";
    await editor(fresh).fill(invalid);
    // This fixture returns a validation error without replacing the draft.
    await page.route("**/api/v1/owner-skills", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({
            status: 400,
            json: {
              error: {
                code: "invalid_request",
                message: "frontmatter description is required",
                retryable: false,
              },
            },
          })
        : route.fallback(),
    );
    await button(fresh, "Save").click();
    await check(fresh.getByRole("alert")).toContainText("description");
    await source.selectOption("github");
    const input = fresh.getByRole("textbox", { name: "GitHub URL", exact: true });
    await input.fill(url);
    await check(button(fresh, "Add")).toHaveCount(0);
    await button(fresh, "Preview").click();
    await check(fresh.getByRole("alert")).toContainText("GitHub unavailable");
    await source.selectOption("manual");
    await check(editor(fresh)).toHaveValue(invalid);
    await check(fresh.getByRole("alert")).toContainText("description");
    await editor(fresh).fill(raw);
    await source.selectOption("github");
    await check(input).toHaveValue(url);
    await check(fresh.getByRole("alert")).toContainText("GitHub unavailable");
    await dialog.getByRole("tab", { name: "Git", exact: true }).click();
    await page.keyboard.press("Escape");
    await openSettings(page, "Skills");
    await check(fresh.getByRole("alert")).toContainText("GitHub unavailable");
    await check(input).toHaveValue(url);
    failPreview = false;
    await button(fresh, "Preview").click();
    await check(fresh).toContainText(sha);
    await fresh
      .locator("summary")
      .filter({ hasText: /^3 files/ })
      .click();
    await check(fresh).toContainText("assets/font.ttf");
    await check(fresh).toContainText("scripts/render.sh");
    await fresh
      .locator("summary")
      .filter({ hasText: /^SKILL.md$/ })
      .click();
    await check(fresh.locator("pre").filter({ hasText: "name: handbook" })).toBeVisible();
    branchHead = "b".repeat(40);
    await button(fresh, "Add").click();
    await check(fresh.getByRole("alert")).toContainText("handbook already exists");
    await check(input).toHaveValue(url);
    await check(fresh).toContainText(sha);
    check(imports).toEqual([{ url, commitSha: sha }]);
    check(items).toEqual([]);
    failImport = false;
    await button(fresh, "Add").click();
    const saved = panel
      .locator("details")
      .filter({ has: page.locator(".activity-rail-summary", { hasText: /^handbook/ }) });
    await check(saved).toContainText("Saved · next orb start");
    await check(saved).toContainText("Import origin");
    await check(saved).toContainText(sha);
    await check(saved).toContainText(`3 files · ${preview.totalBytes} bytes`);
    check(imports).toEqual([
      { url, commitSha: sha },
      { url, commitSha: sha },
    ]);
    await editor(saved).fill(`${content}\nEdited locally.\n`);
    await button(saved, "Save").click();
    await check(saved).toContainText("Saved · next orb start");
    await check(saved).toContainText("Import origin");
    await check(saved).toContainText(sha);
    await check(saved).toContainText(`3 files · ${preview.totalBytes} bytes`);
    check(await dialog.evaluate((root) => root.scrollWidth <= root.clientWidth)).toBe(true);
    check(await page.locator("html").evaluate((root) => root.scrollWidth <= root.clientWidth)).toBe(
      true,
    );
  },
);

it("invalidates changed URLs and cancels stale previews across source switch and cancel", async () => {
  const fixture = await createFrontendFixture("chromium");
  const { page, origin } = fixture;
  const url = "https://github.com/example/skills/tree/main/handbook";
  const content = skill("handbook", "Write manuals.");
  const preview = {
    name: "handbook",
    description: "Write manuals.",
    content,
    source: { url, commitSha: "a".repeat(40) },
    manifest: [{ path: "SKILL.md", bytes: content.length, executable: false }],
    fileCount: 1,
    totalBytes: content.length,
  };
  let release = () => {};
  let started = () => {};
  let finished = () => {};
  let pending = Promise.resolve();
  let seen = Promise.resolve();
  let done = Promise.resolve();
  const hold = () => {
    pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    seen = new Promise<void>((resolve) => {
      started = resolve;
    });
    done = new Promise<void>((resolve) => {
      finished = resolve;
    });
  };
  fixture.cleanup(async () => release());
  await page.route("**/api/v1/owner-skills**", async (route) => {
    if (route.request().url().endsWith("/preview")) {
      started();
      await pending;
      await route.fulfill({ json: preview });
      finished();
    } else await route.fulfill({ json: { items: [] } });
  });
  await gotoFrontendFixture(page, `${origin}/`);
  const dialog = await openSettings(page, "Skills");
  const panel = dialog.getByRole("tabpanel", { name: "Skills", exact: true });
  const begin = async () => {
    await button(panel, "add skill").click();
    await panel.getByRole("combobox", { name: "Draft source" }).selectOption("github");
    await panel.getByRole("textbox", { name: "GitHub URL", exact: true }).fill(url);
  };
  await begin();
  await button(panel, "Preview").click();
  await check(button(panel, "Add")).toBeVisible();
  await panel.getByRole("textbox", { name: "GitHub URL", exact: true }).fill(`${url}-changed`);
  await check(button(panel, "Add")).toHaveCount(0);
  for (const action of ["url", "switch", "cancel"] as const) {
    hold();
    await button(panel, "Preview").click();
    await seen;
    if (action === "url") {
      await panel.getByRole("textbox", { name: "GitHub URL", exact: true }).fill(url);
    } else if (action === "switch") {
      await panel.getByRole("combobox", { name: "Draft source" }).selectOption("manual");
    } else await button(panel, "cancel").click();
    release();
    await done;
    if (action === "switch")
      await panel.getByRole("combobox", { name: "Draft source" }).selectOption("github");
    if (action === "cancel") await begin();
    await check(button(panel, "Add")).toHaveCount(0);
    await check(panel.getByRole("alert")).toHaveCount(0);
  }
});
