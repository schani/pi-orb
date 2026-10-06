import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect as check, chromium, webkit } from "@playwright/test";
import { createServer } from "vite";
import { it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";
import { mockClaudeOwnerConnection } from "./testkit/claude-auth-fixture.ts";

it.each(["chromium", "webkit"] as const)(
  "%s keeps loading and empty transcripts quiet, with full-width auth and error notices",
  async (engine) => {
    const root = join(import.meta.dirname, "../apps/web");
    const cacheDir = await mkdtemp(join(tmpdir(), "orb-notices-frontend-"));
    const vite = await createServer({
      root,
      cacheDir,
      configFile: join(root, "vite.config.ts"),
      mode: "frontend",
      server: { host: "127.0.0.1", port: 0 },
    });
    const browser = await (engine === "chromium" ? chromium : webkit).launch({ headless: true });
    const page = await browser.newPage();
    let releaseHistory = () => {};
    const historyGate = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    let failHistory = false;
    let requireAuth = true;
    try {
      await listenFrontend(vite);
      const address = vite.httpServer?.address();
      if (!address || typeof address === "string") throw new Error("No owned fixture port");
      const origin = `http://127.0.0.1:${address.port}`;
      await mockClaudeOwnerConnection(page);
      await page.route("**/api/v1/orbs/frontend-auth-copy-test", async (route) => {
        const response = await route.fetch();
        const orb = await response.json();
        await route.fulfill({
          json: {
            ...orb,
            harness: "claude",
            state: requireAuth ? "creating" : "stopped",
            actionRequired: requireAuth
              ? {
                  type: "claude_subscription_login",
                  verificationUri: "",
                  userCode: "",
                  expiresAt: "",
                }
              : undefined,
          },
        });
      });
      await page.route("**/api/v1/orbs/frontend-auth-copy-test/history", async (route) => {
        await historyGate;
        if (failHistory) {
          await route.fulfill({ status: 503, json: { error: "history unavailable" } });
        } else {
          await route.fulfill({
            json: {
              orbId: "frontend-auth-copy-test",
              session: null,
              cursor: null,
              headId: null,
              records: [],
            },
          });
        }
      });
      const path = `${origin}/orbs/frontend-auth-copy-test`;
      await page.goto(path);
      const main = page.locator(".orb-main");
      await check(main).toHaveAttribute("aria-busy", "true");
      await check(main).toHaveText("");
      releaseHistory();
      const connect = main.getByRole("button", { name: "Connect Claude", exact: true });
      await check(connect).toBeVisible();
      await check(main.locator(".rec-sys > .rec-px")).toHaveCount(0);
      await check(main.locator(".busy-indicator")).toHaveCount(0);
      await check(main.locator(".history")).toHaveText("");
      const geometry = await connect.evaluate((element) => {
        const notice = element.closest(".notice");
        const record = notice?.parentElement;
        if (!notice || !record) return null;
        const style = element.ownerDocument.defaultView?.getComputedStyle(record);
        if (!style) return null;
        return {
          left: notice.getBoundingClientRect().left - record.getBoundingClientRect().left,
          padding: Number.parseFloat(style.paddingLeft),
          width: notice.getBoundingClientRect().width,
          available:
            record.clientWidth -
            Number.parseFloat(style.paddingLeft) -
            Number.parseFloat(style.paddingRight),
        };
      });
      check(geometry).not.toBeNull();
      check(geometry?.left).toBe(geometry?.padding);
      check(geometry?.width).toBeCloseTo(geometry?.available ?? 0, 1);
      await connect.click();
      await check(
        page.getByRole("dialog", { name: "Claude subscription", exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Close Claude connection" }).click();

      requireAuth = false;
      await page.reload();
      await check(main).toHaveAttribute("aria-busy", "false");
      await check(main.locator(".rec-sys")).toHaveCount(0);
      await check(main.locator(".history")).toHaveText("");

      failHistory = true;
      await page.reload();
      await check(main.locator(".notice-error")).toContainText("history unavailable:");
      await check(main.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
      await check(main.locator(".rec-sys > .rec-px")).toHaveCount(0);
      await page.goto(`${origin}/orbs/missing-notice-test`);
      await check(page.getByText("Orb doesn't exist", { exact: true })).toBeVisible();
      await check(page.getByRole("link", { name: "Back to dashboard", exact: true })).toBeVisible();
      await check(page).toHaveURL(`${origin}/orbs/missing-notice-test`);
    } finally {
      releaseHistory();
      await page.close();
      await browser.close();
      await vite.close();
      await rm(cacheDir, { recursive: true, force: true });
    }
  },
);
