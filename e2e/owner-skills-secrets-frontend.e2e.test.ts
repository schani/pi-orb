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

it.each(["chromium", "webkit"] as const)(
  "%s mobile skill import retains drafts and shows the pinned source",
  async (engine) => {
    const fixture = await createFrontendFixture(engine, {
      page: { viewport: { width: 390, height: 844 } },
    });
    const { page, origin } = fixture;
    const githubUrl = "https://github.com/example/skills/tree/main/skills/screenshots";
    const commitSha = "a1b2c3d4".repeat(5);
    const sourceUrl = githubUrl.replace("/main/", `/${commitSha}/`);
    const content = skill("screenshots", "Capture screenshots.");
    const calls: string[] = [];
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture.cleanup(async () => release());
    await page.route("**/api/v1/owner-skills", async (route) => {
      const method = route.request().method();
      calls.push(method);
      if (method === "GET") return route.fulfill({ json: { items: [] } });
      check(route.request().postDataJSON()).toEqual({ githubUrl });
      if (calls.length === 2)
        return route.fulfill({
          status: 400,
          json: {
            error: {
              code: "invalid_request",
              message: "Skill screenshots already exists",
              retryable: false,
            },
          },
        });
      await pending;
      await route.fulfill({
        json: {
          items: [
            {
              name: "screenshots",
              description: "Capture screenshots.",
              content,
              updatedAt: "2026-10-25T00:00:00.000Z",
              source: { url: sourceUrl, commitSha },
            },
          ],
        },
      });
    });
    await gotoFrontendFixture(page, `${origin}/`);
    const dialog = await openSettings(page, "Skills");
    const panel = dialog.getByRole("tabpanel", { name: "Skills", exact: true });
    await button(panel, "add skill").click();
    const fresh = panel.locator("details").filter({ hasText: "new skill" });
    const source = fresh.getByRole("combobox", { name: "Source", exact: true });
    const url = fresh.getByRole("textbox", { name: "GitHub URL", exact: true });
    const draft = skill("manual-draft", "Keep this draft.");
    await check(source).toHaveValue("manual");
    await editor(fresh).fill(draft);
    await source.selectOption("github");
    await check(url).not.toHaveAttribute("placeholder", /.+/);
    await url.fill(githubUrl);
    await source.selectOption("manual");
    await check(editor(fresh)).toHaveValue(draft);
    await source.selectOption("github");
    await check(url).toHaveValue(githubUrl);
    check(calls).toEqual(["GET"]);
    await button(fresh, "Add").click();
    await check(fresh.getByRole("alert")).toContainText("screenshots already exists");
    await check(url).toHaveValue(githubUrl);
    await source.selectOption("manual");
    await check(editor(fresh)).toHaveValue(draft);
    await source.selectOption("github");
    await button(fresh, "Add").click();
    await check(source).toBeDisabled();
    await check(url).toBeDisabled();
    await check(button(fresh, "Add")).toBeDisabled();
    await check(button(dialog, "Close settings")).toBeDisabled();
    release();
    const saved = panel
      .locator("details")
      .filter({ has: page.locator("summary", { hasText: "screenshots" }) });
    await check(saved).toContainText("Saved · next orb start");
    await check(editor(saved)).toHaveValue(content);
    await check(saved.getByRole("link", { name: sourceUrl, exact: true })).toHaveAttribute(
      "href",
      sourceUrl,
    );
    check(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    check(calls).toEqual(["GET", "POST", "POST"]);
    await button(panel, "add skill").click();
    await check(source).toHaveValue("manual");
    await check(editor(fresh)).toHaveValue("");
    await source.selectOption("github");
    await check(url).toHaveValue("");
    await url.fill(githubUrl);
    await button(fresh, "cancel").click();
    await button(panel, "add skill").click();
    await check(source).toHaveValue("manual");
    await source.selectOption("github");
    await check(url).toHaveValue("");
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
