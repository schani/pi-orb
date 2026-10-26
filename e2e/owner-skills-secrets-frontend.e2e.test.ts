import { expect as check, type Locator, type Page } from "@playwright/test";
import { it } from "vitest";
import { gotoFrontendFixture } from "./testkit/frontend-fixture.ts";
import { createFrontendFixture } from "./testkit/frontend-owned.ts";

const skill = (name: string, description: string, body = "") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;

async function openSettings(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  return page.getByRole("dialog", { name: "Settings", exact: true });
}

function confirmations(page: Page) {
  const messages: string[] = [];
  page.on("dialog", (dialog) => {
    messages.push(dialog.message());
    void dialog.accept();
  });
  return messages;
}

it.each(["chromium", "webkit"] as const)(
  "%s owner Settings: skill workbench, retained drafts, failures and owner secrets",
  async (engine) => {
    const fixture = await createFrontendFixture(engine, {
      page: { viewport: { width: 1440, height: 900 } },
    });
    const { page, origin } = fixture;
    let failWrite = false;
    let releaseWrite: (() => void) | undefined;
    fixture.cleanup(async () => {
      releaseWrite?.();
    });
    let heldWrite: Promise<void> = Promise.resolve();
    await page.route("**/api/v1/owner-skills**", async (route) => {
      if (route.request().method() !== "GET") {
        await heldWrite;
        if (failWrite) return route.abort("failed");
      }
      await route.continue();
    });
    const confirmed = confirmations(page);
    await gotoFrontendFixture(page, `${origin}/`);
    const gear = page.getByRole("button", { name: "Settings", exact: true });
    const dialog = await openSettings(page);
    const tabs = dialog.getByRole("tab");
    await check(tabs).toHaveText(["Instructions", "Skills", "Secrets", "Git", "Claude"]);
    const subtitle = dialog.locator(".project-secrets-header p");
    await check(subtitle).toHaveCount(0);
    await dialog.getByRole("tab", { name: "Skills", exact: true }).click();
    await check(subtitle).toHaveCount(0);
    const panel = dialog.getByRole("tabpanel", { name: "Skills", exact: true });
    const rows = panel.locator("details.activity-rail-row.project-mcp-connection");
    await check(rows.locator("summary")).toHaveText([
      "pg-migrations · Write PostgreSQL migrations that are safe on a live database.",
      "release-notes · Draft release notes from merged PRs since the last tag.",
    ]);
    const row = (name: string) =>
      rows.filter({ has: page.locator(".activity-rail-summary", { hasText: name }) });
    const release = row("release-notes");
    const editor = (target: Locator) =>
      target.getByRole("textbox", { name: "SKILL.md", exact: true });
    const save = (target: Locator) => target.getByRole("button", { name: "Save", exact: true });
    const remove = (target: Locator) => target.getByRole("button", { name: "remove", exact: true });

    // One disclosure at a time; a clean row cannot save.
    await release.locator("summary").click();
    await check(release).toHaveAttribute("open", "");
    await check(save(release)).toBeDisabled();
    await check(remove(release)).toBeEnabled();
    await row("pg-migrations").locator("summary").click();
    await check(row("pg-migrations")).toHaveAttribute("open", "");
    await check(release).not.toHaveAttribute("open", "");
    await release.locator("summary").click();

    // Server validation stays inline in the failing row and keeps the draft.
    const invalid = "---\nname: release-notes\n---\nno description\n";
    await editor(release).fill(invalid);
    await check(save(release)).toBeEnabled();
    await save(release).click();
    await check(release.getByRole("alert")).toContainText("description");
    await check(editor(release)).toHaveValue(invalid);
    await check(panel.getByRole("alert")).toHaveCount(1);
    const clash = skill("pg-migrations", "Clash.");
    await editor(release).fill(clash);
    await check(release.getByRole("alert")).toHaveCount(0);
    await save(release).click();
    await check(release.getByRole("alert")).toContainText("pg-migrations");
    await check(editor(release)).toHaveValue(clash);
    const bundled = skill("charts", "Bundled.");
    await editor(release).fill(bundled);
    await save(release).click();
    await check(release.getByRole("alert")).toContainText("charts");
    await check(editor(release)).toHaveValue(bundled);

    // A network failure keeps the draft; drafts survive tab switches and close/reopen.
    const edited = skill("release-notes", "Release notes, edited.", "\n# Edited\n");
    await editor(release).fill(edited);
    failWrite = true;
    await save(release).click();
    await check(release.getByRole("alert")).toContainText("network error");
    await check(editor(release)).toHaveValue(edited);
    failWrite = false;
    await dialog.getByRole("tab", { name: "Git", exact: true }).click();
    await check(panel).toBeHidden();
    await dialog.getByRole("tab", { name: "Skills", exact: true }).click();
    await check(editor(release)).toHaveValue(edited);
    await page.keyboard.press("Escape");
    await check(dialog).toHaveCount(0);
    await check(gear).toBeFocused();
    await openSettings(page);
    await dialog.getByRole("tab", { name: "Skills", exact: true }).click();
    await check(editor(release)).toHaveValue(edited);

    // A pending save owns the dialog; success is acknowledged once.
    heldWrite = new Promise((resolve) => {
      releaseWrite = resolve;
    });
    await save(release).click();
    const close = dialog.getByRole("button", { name: "Close settings" });
    await check(close).toBeDisabled();
    await check(dialog.getByRole("tab", { name: "Git", exact: true })).toBeDisabled();
    await check(editor(release)).toBeDisabled();
    await check(remove(release)).toBeDisabled();
    await page.keyboard.press("Escape");
    await check(dialog).toBeVisible();
    check(
      await dialog.evaluate((element) => element.contains(element.ownerDocument.activeElement)),
    ).toBe(true);
    releaseWrite?.();
    await check(release).toContainText("Saved · next orb start");
    await check(panel.getByText("Saved · next orb start")).toHaveCount(1);
    await check(release.locator("summary")).toHaveText("release-notes · Release notes, edited.");
    await check(save(release)).toBeDisabled();
    await editor(release).fill(`${edited}more\n`);
    await check(release).not.toContainText("Saved · next orb start");
    await editor(release).fill(edited);

    // Renaming through the frontmatter replaces the row.
    await editor(release).fill(skill("changelog", "Release notes, renamed.", "\n# Renamed\n"));
    await save(release).click();
    const changelog = row("changelog");
    await check(changelog.locator("summary")).toHaveText("changelog · Release notes, renamed.");
    await check(row("release-notes")).toHaveCount(0);
    await check(changelog).toHaveAttribute("open", "");
    await check(changelog).toContainText("Saved · next orb start");

    // Add: an empty disclosure with cancel; then a real create.
    const add = panel.getByRole("button", { name: "add skill", exact: true });
    await add.click();
    const fresh = rows.filter({
      has: page.locator(".activity-rail-summary", { hasText: /^new skill$/ }),
    });
    await check(fresh).toHaveAttribute("open", "");
    await check(editor(fresh)).toHaveValue("");
    await check(editor(fresh)).toBeFocused();
    await check(add).toHaveCount(0);
    await check(save(fresh)).toBeDisabled();
    await check(remove(fresh)).toHaveCount(0);
    await editor(fresh).fill("draft");
    await fresh.getByRole("button", { name: "cancel", exact: true }).click();
    await check(fresh).toHaveCount(0);
    await check(add).toBeFocused();
    await add.click();
    await check(editor(fresh)).toHaveValue("");
    await editor(fresh).fill(skill("pg-migrations", "Duplicate."));
    await save(fresh).click();
    await check(fresh.getByRole("alert")).toContainText("pg-migrations");
    const created = skill("screenshot-review", "Capture desktop and phone screenshots.");
    await editor(fresh).fill(created);
    await dialog.getByRole("tab", { name: "Instructions", exact: true }).click();
    await dialog.getByRole("tab", { name: "Skills", exact: true }).click();
    await check(editor(fresh)).toHaveValue(created);
    await save(fresh).click();
    const screenshot = row("screenshot-review");
    await check(screenshot.locator("summary")).toHaveText(
      "screenshot-review · Capture desktop and phone screenshots.",
    );
    await check(screenshot).toContainText("Saved · next orb start");
    await check(fresh).toHaveCount(0);
    await check(add).toBeVisible();

    // Remove asks once, scoped to every orb.
    await remove(screenshot).click();
    await check(screenshot).toHaveCount(0);
    check(confirmed).toEqual(["Remove screenshot-review from every orb on its next start?"]);
    await check(rows.locator("summary")).toHaveText([
      "changelog · Release notes, renamed.",
      "pg-migrations · Write PostgreSQL migrations that are safe on a live database.",
    ]);

    // Server state survives reload.
    await page.reload();
    await openSettings(page);
    await dialog.getByRole("tab", { name: "Skills", exact: true }).click();
    await check(rows.locator("summary")).toHaveText([
      "changelog · Release notes, renamed.",
      "pg-migrations · Write PostgreSQL migrations that are safe on a live database.",
    ]);

    // Owner secrets: the project Secrets pane, owner-scoped.
    await dialog.getByRole("tab", { name: "Secrets", exact: true }).click();
    await check(subtitle).toHaveText("Changes apply on next start");
    const secrets = dialog.getByRole("tabpanel", { name: "Secrets", exact: true });
    const secretRows = secrets.locator(".project-secret-row");
    await check(secretRows.locator(".project-secret-name")).toHaveText([
      "DATADOG_API_KEY",
      "GITHUB_TOKEN",
    ]);
    await check(secretRows.locator(".project-secret-updated").first()).toHaveText(/^updated /);
    const name = secrets.getByRole("textbox", { name: "name", exact: true });
    const value = secrets.getByLabel("secret value", { exact: true });
    await name.fill("NPM_TOKEN");
    await value.fill("npm-owner-secret");
    await secrets.getByRole("button", { name: "save secret", exact: true }).click();
    await check(secretRows.locator(".project-secret-name")).toHaveText([
      "DATADOG_API_KEY",
      "GITHUB_TOKEN",
      "NPM_TOKEN",
    ]);
    await check(name).toHaveValue("");
    await check(value).toHaveValue("");
    const github = secretRows.filter({ hasText: "GITHUB_TOKEN" });
    await github.getByRole("button", { name: "replace", exact: true }).click();
    await check(name).toHaveValue("GITHUB_TOKEN");
    await check(value).toBeFocused();
    await value.fill("rotated");
    await secrets.getByRole("button", { name: "save secret", exact: true }).click();
    await check(name).toHaveValue("");
    await check(secretRows).toHaveCount(3);
    const datadog = secretRows.filter({ hasText: "DATADOG_API_KEY" });
    await check(datadog.getByRole("button", { name: "remove", exact: true })).toBeEnabled();
    await datadog.getByRole("button", { name: "remove", exact: true }).click();
    await check(secretRows.locator(".project-secret-name")).toHaveText([
      "GITHUB_TOKEN",
      "NPM_TOKEN",
    ]);
    check(confirmed.at(-1)).toBe("Remove DATADOG_API_KEY from every orb on its next start?");
    await dialog.getByRole("tab", { name: "Git", exact: true }).click();
    await check(subtitle).toHaveCount(0);
  },
);

it.each(["chromium", "webkit"] as const)(
  "%s owner Skills on a phone: touch targets, 16px text, no overflow",
  async (engine) => {
    const fixture = await createFrontendFixture(engine, {
      page: { viewport: { width: 390, height: 844 } },
    });
    const { page, origin } = fixture;
    await gotoFrontendFixture(page, `${origin}/`);
    const dialog = await openSettings(page);
    await dialog.getByRole("tab", { name: "Skills", exact: true }).click();
    const panel = dialog.getByRole("tabpanel", { name: "Skills", exact: true });
    // The text action keeps its underline geometry; its hit area fills a 48px row below the list.
    const add = panel.getByRole("button", { name: "add skill", exact: true });
    await add.scrollIntoViewIfNeeded();
    const reach = await add.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const row = element.parentElement?.getBoundingClientRect();
      const last = element.closest(".project-secrets-body")?.querySelector("details:last-of-type");
      if (!row || !last) return null;
      const x = box.left + box.width / 2;
      const hits = [row.top + 1, row.bottom - 1].map((y) => {
        const hit = element.ownerDocument.elementFromPoint(x, y);
        return hit === element || element.contains(hit);
      });
      return { height: row.height, hits, clear: last.getBoundingClientRect().bottom <= row.top };
    });
    check(reach).toEqual({ height: 48, hits: [true, true], clear: true });
    const summary = panel.locator("summary").first();
    await summary.click();
    const row = panel.locator("details[open]");
    const textarea = row.getByRole("textbox", { name: "SKILL.md", exact: true });
    check(
      await textarea.evaluate(
        (element) => element.ownerDocument.defaultView?.getComputedStyle(element).fontSize,
      ),
    ).toBe("16px");
    for (const target of [
      summary,
      row.getByRole("button", { name: "remove", exact: true }),
      row.getByRole("button", { name: "Save", exact: true }),
    ]) {
      check((await target.boundingBox())?.height).toBeGreaterThanOrEqual(48);
    }
    check(
      await page.locator("html").evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
  },
);

/** Every element box inside the pane, relative to the pane. */
function paneGeometry(pane: Locator) {
  return pane.evaluate((root) => {
    const origin = root.getBoundingClientRect();
    return [root, ...root.querySelectorAll("*")].map((element) => {
      const box = element.getBoundingClientRect();
      return [
        element.tagName,
        element.getAttribute("class") ?? "",
        box.x - origin.x,
        box.y - origin.y,
        box.width,
        box.height,
      ].join(" ");
    });
  });
}

it.each(["chromium", "webkit"] as const)(
  "%s Settings Secrets pane has the project Config Secrets geometry",
  async (engine) => {
    const fixture = await createFrontendFixture(engine, {
      page: { viewport: { width: 1440, height: 900 } },
    });
    const { page, origin } = fixture;
    const list = {
      revision: 1,
      items: [
        { name: "GITHUB_TOKEN", updatedAt: "2026-10-21T12:00:00.000Z" },
        { name: "NPM_TOKEN", updatedAt: "2026-09-30T12:00:00.000Z" },
      ],
    };
    for (const path of ["**/api/v1/owner-secrets", "**/api/v1/projects/*/secrets"])
      await page.route(path, (route) =>
        route.request().method() === "GET" ? route.fulfill({ json: list }) : route.continue(),
      );
    await gotoFrontendFixture(page, `${origin}/`);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const settings = await openSettings(page);
      await settings.getByRole("tab", { name: "Secrets", exact: true }).click();
      const owner = settings
        .getByRole("tabpanel", { name: "Secrets" })
        .locator(".project-secrets-body");
      await check(owner.locator(".project-secret-row")).toHaveCount(2);
      const ownerBoxes = await paneGeometry(owner);
      await settings.getByRole("button", { name: "Close settings" }).click();
      await page
        .getByRole("button", { name: /^Configure / })
        .first()
        .click();
      const config = page.getByRole("dialog");
      await config.getByRole("tab", { name: "Secrets", exact: true }).click();
      const project = config
        .getByRole("tabpanel", { name: "Secrets" })
        .locator(".project-secrets-body");
      await check(project.locator(".project-secret-row")).toHaveCount(2);
      await check(
        project.getByRole("button", { name: "remove", exact: true }).first(),
      ).toBeEnabled();
      check(await paneGeometry(project)).toEqual(ownerBoxes);
      await config.getByRole("button", { name: "Close project config" }).click();
    }
  },
);
