import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OrbView } from "@pi-orb/protocol";
import { chromium, expect, webkit } from "@playwright/test";
import { createServer } from "vite";
import { it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";
import { mockClaudeOwnerConnection } from "./testkit/claude-auth-fixture.ts";
import { closeRoutedPage } from "./testkit/close-routed-page.ts";
import { gotoFrontendHistory } from "./testkit/frontend-fixture.ts";

const orbId = "frontend-long-history";
const apiPath = `/api/v1/orbs/${orbId}`;
const cases = (["chromium", "webkit"] as const).flatMap((engine) =>
  [1280, 320].map((width) => ({ engine, width })),
);

it.each(cases)(
  "$engine at $width px: login stays above a busy central transcript at its tail",
  async ({ engine, width }) => {
    const root = join(import.meta.dirname, "../apps/web");
    const cacheDir = await mkdtemp(join(tmpdir(), "auth-notice-frontend-"));
    const vite = await createServer({
      root,
      cacheDir,
      configFile: join(root, "vite.config.ts"),
      mode: "frontend",
      server: { host: "127.0.0.1", port: 0 },
    });
    const browser = await (engine === "chromium" ? chromium : webkit).launch({ headless: true });
    const page = await browser.newPage({ viewport: { width, height: 740 } });
    try {
      await listenFrontend(vite);
      const address = vite.httpServer?.address();
      if (!address || typeof address === "string") throw new Error("No owned fixture port");
      const origin = `http://127.0.0.1:${address.port}`;
      const response = await page.request.get(`${origin}${apiPath}`);
      expect(response.ok()).toBe(true);
      const original: OrbView = await response.json();
      const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
      const actions: NonNullable<OrbView["actionRequired"]>[] = [
        {
          type: "github_device_login",
          verificationUri: "https://github.com/login/device",
          userCode: "AUTH-2468",
          expiresAt,
        },
        {
          type: "openai_codex_device_login",
          verificationUri: "https://auth.openai.com/codex/device",
          userCode: "AUTH-1357",
          expiresAt,
        },
        { type: "owner_login_required", provider: "github" },
        { type: "claude_subscription_login", verificationUri: "", userCode: "", expiresAt: "" },
      ];
      let actionRequired: NonNullable<OrbView["actionRequired"]>;
      await mockClaudeOwnerConnection(page);
      await page.route(`**${apiPath}`, (route) =>
        route.fulfill({
          json: {
            ...original,
            centralAgent: true,
            state: "creating",
            activity: "busy",
            actionRequired,
            lastError: "Fixture lifecycle failure",
            resourceWarnings: [{ path: ".agents/skills/bad/SKILL.md", code: "invalid_yaml" }],
          } satisfies OrbView,
        }),
      );
      const header = page.locator(".orb-header-scroll");
      const scroller = page.locator(".orb-transcript-scroll");
      for (const action of actions) {
        actionRequired = action;
        await gotoFrontendHistory(page, `${origin}/orbs/${orbId}`, orbId);
        await expect(page.locator(".orb-life-word")).toHaveText("creating · busy");
        await expect(page.locator(".history")).toContainText("const iteration = 199;");
        // Wait for the real tail follower, without scrolling the login notice into view.
        await expect
          .poll(() =>
            scroller.evaluate((element) => ({
              long: element.scrollTop > element.clientHeight,
              atTail:
                Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop) <= 1,
            })),
          )
          .toEqual({ long: true, atTail: true });

        const notice = page.locator(".notice").filter({
          hasText:
            action.type === "github_device_login"
              ? "GitHub device login required."
              : action.type === "openai_codex_device_login"
                ? "OpenAI device login required."
                : action.type === "owner_login_required"
                  ? "Project owner login required for github."
                  : "Connect Claude",
        });
        await expect(notice).toHaveCount(1);
        await expect(notice).toBeInViewport({ ratio: 1 });
        expect(
          await notice.evaluate(
            (element) =>
              element.closest(".orb-header-scroll")?.firstElementChild === element.parentElement,
          ),
        ).toBe(true);
        const beforeScroll = await notice.boundingBox();
        await scroller.evaluate(
          (element) =>
            new Promise<void>((resolve) => {
              element.addEventListener("scroll", () => queueMicrotask(resolve), { once: true });
              element.scrollTop -= 100;
            }),
        );
        expect(await notice.boundingBox()).toEqual(beforeScroll);
        await expect(notice).toBeInViewport({ ratio: 1 });
        await expect(scroller.locator(".user-code")).toHaveCount(0);
        await expect(
          scroller.getByRole("button", { name: "Connect Claude", exact: true }),
        ).toHaveCount(0);

        if (action.type === "github_device_login" || action.type === "openai_codex_device_login") {
          await expect(page.locator(".user-code")).toHaveCount(1);
          await expect(notice.locator(".user-code")).toHaveText(action.userCode);
          await expect(notice.locator(".user-code")).toBeInViewport({ ratio: 1 });
          const link = notice.getByRole("link", { name: action.verificationUri, exact: true });
          await expect(link).toHaveAttribute("href", action.verificationUri);
          await expect(link).toBeInViewport({ ratio: 1 });
          await expect(notice).toContainText("expires in");
          await expect(
            notice.getByRole("button", { name: "Copy device code", exact: true }),
          ).toBeVisible();
        } else if (action.type === "owner_login_required") {
          await expect(notice.locator("a, button")).toHaveCount(0);
          await expect(notice).not.toContainText("expires");
        } else {
          await notice.getByRole("button", { name: "Connect Claude", exact: true }).click();
          await expect(
            page.getByRole("dialog", { name: "Claude subscription", exact: true }),
          ).toBeVisible();
          await page.getByRole("button", { name: "Close Claude connection" }).click();
        }
        await expect(header.locator(".orb-failure-banner")).toHaveText("Fixture lifecycle failure");
        await expect(
          header.getByText("Skipped repository skill .agents/skills/bad/SKILL.md: invalid YAML.", {
            exact: true,
          }),
        ).toHaveCount(1);
        const geometry = await page.locator(".orb-main").evaluate((element) => {
          const header = element.querySelector(".orb-header-stack")?.getBoundingClientRect();
          const transcript = element
            .querySelector(".orb-transcript-scroll")
            ?.getBoundingClientRect();
          const composer = element.querySelector(".composer")?.getBoundingClientRect();
          const view = element.ownerDocument.defaultView;
          if (!header || !transcript || !composer || !view)
            throw new Error("Missing conversation layout");
          return {
            headerBottom: header.bottom,
            transcriptTop: transcript.top,
            transcriptBottom: transcript.bottom,
            transcriptHeight: transcript.height,
            composerTop: composer.top,
            composerBottom: composer.bottom,
            viewportHeight: view.innerHeight,
            overflow: element.ownerDocument.documentElement.scrollWidth - view.innerWidth,
          };
        });
        expect(geometry.headerBottom).toBeLessThanOrEqual(geometry.transcriptTop);
        expect(geometry.transcriptHeight).toBeGreaterThanOrEqual(40);
        expect(geometry.transcriptBottom).toBeLessThanOrEqual(geometry.composerTop);
        expect(geometry.composerBottom).toBeLessThanOrEqual(geometry.viewportHeight);
        expect(geometry.overflow).toBeLessThanOrEqual(0);
      }
    } finally {
      await closeRoutedPage(page);
      await browser.close();
      await vite.close();
      await rm(cacheDir, { recursive: true, force: true });
    }
  },
);
