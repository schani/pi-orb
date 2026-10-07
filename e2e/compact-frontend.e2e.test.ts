import { join } from "node:path";
import { expect as check, chromium, webkit } from "@playwright/test";
import { createServer } from "vite";
import { it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";
import { gotoFrontendFixture } from "./testkit/frontend-fixture.ts";

it.each(["chromium", "webkit"] as const)(
  "%s: compact is a native command, survives reconnect and remains abortable",
  async (engine) => {
    const root = join(import.meta.dirname, "../apps/web");
    const vite = await createServer({
      root,
      configFile: join(root, "vite.config.ts"),
      mode: "frontend",
      server: { host: "127.0.0.1", port: 0 },
    });
    await listenFrontend(vite);
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("No owned fixture port");
    const browser = await (engine === "chromium" ? chromium : webkit).launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const base = `http://127.0.0.1:${address.port}`;
    const control = `${base}/api/v1/orbs/frontend-fixture-orb/fixture-compaction`;
    try {
      await gotoFrontendFixture(page, `${base}/orbs/frontend-fixture-orb`);
      const input = page.getByRole("textbox", { name: "Message the orb", exact: true });
      await check(page.getByRole("button", { name: "Change thinking", exact: true })).toBeEnabled();
      const before = await page.request.post(
        `${base}/api/v1/orbs/frontend-fixture-orb/messages/poll`,
        {
          data: { after: 0, tracked: [] },
        },
      );
      const inbox = await before.text();
      await input.fill("/comp");
      await check(page.getByRole("option", { name: "compact", exact: true })).toBeVisible();
      await input.press("Enter");
      const progress = page.locator(".compaction-activity").filter({ hasText: "compacting" });
      await check(progress).toHaveCount(1);
      await check(page.locator(".bit-register")).toHaveCount(0);
      await check(page.locator(".activity-rail-row-running.reasoning")).toHaveCount(0);
      await progress.locator("summary").click();
      await check(progress).toHaveAttribute("open", "");
      await check(page.locator(".busy-indicator")).toHaveCount(0);
      await check(page.locator(".composer-abort")).toBeEnabled();
      await input.press("Escape");
      await input.fill("new draft");
      const second = await browser.newPage();
      await second.goto(`${base}/orbs/frontend-fixture-orb`);
      await check(second.locator(".composer-abort")).toBeEnabled();
      await check(
        second.locator(".compaction-activity").filter({ hasText: "compacting" }),
      ).toHaveCount(1);
      await second.reload();
      await check(second.locator(".composer-abort")).toBeEnabled();
      await check(
        second.locator(".compaction-activity").filter({ hasText: "compacting" }),
      ).toHaveCount(1);
      await page.request.post(control, { data: { outcome: "completed", deferFinish: true } });
      const completed = page
        .locator(".compaction-activity")
        .filter({ hasText: "context compacted" });
      await check(completed).toHaveCount(1);
      await check(progress).toHaveCount(0);
      await check(completed).toHaveAttribute("open", "");
      await check(completed).toContainText("Fixture native summary");
      await check(page.locator(".composer-abort")).toBeEnabled();
      await second.reload();
      await check(second.locator(".composer-abort")).toBeEnabled();
      await check(second.locator(".compaction-activity")).toHaveCount(1);
      await check(
        second.locator(".compaction-activity").filter({ hasText: "compacting" }),
      ).toHaveCount(0);
      await check(second.locator(".compaction-activity")).not.toContainText(
        "Fixture native summary",
      );
      await second.locator(".compaction-activity summary").click();
      await check(second.locator(".compaction-activity")).toContainText("Fixture native summary");
      await page.request.post(control, { data: { outcome: "completed" } });
      await check(completed).toHaveAttribute("open", "");
      await check(page.locator(".composer-abort")).toHaveCount(0);
      await check(page.locator(".record-compaction")).toBeVisible();
      await check(input).toHaveValue("new draft");
      await input.fill("/compact preserve decisions");
      await input.press("Enter");
      await check(page.locator(".composer-abort")).toBeEnabled();
      const probe = await page.request.get(control);
      check((await probe.json()).customInstructions).toBe("preserve decisions");
      await check(progress).toHaveCount(1);
      await progress.locator("summary").click();
      await page.locator(".composer-abort").click();
      const aborted = page
        .locator(".compaction-activity")
        .filter({ hasText: "Compaction aborted" });
      await check(aborted).toHaveCount(1);
      await check(aborted).toHaveAttribute("open", "");
      await check(progress).toHaveCount(0);
      await check(page.locator(".composer-abort")).toHaveCount(0);
      await check(page.locator(".orb-transcript-scroll")).toContainText("Compaction aborted");
      await check(page.locator(".orb-composer-feedback-original")).not.toContainText(
        "Compaction aborted",
      );
      await page.request.post(control, { data: { reject: true } });
      await input.fill("/compact retain paths");
      await input.press("Enter");
      await check(page.locator(".orb-composer-feedback-original")).toContainText(
        "fixture compaction rejected",
      );
      await check(input).toHaveValue("compact retain paths");
      await input.press("Escape");
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("button", { name: "Write message", exact: true }).click();
      await input.fill("/compact");
      await page.getByRole("option", { name: "compact", exact: true }).click();
      await check(input).toHaveValue("");
      await check(page.locator(".composer-abort")).toBeEnabled();
      await page.request.post(control, { data: { outcome: "completed" } });
      await check(page.locator(".record-compaction")).toHaveCount(2);
      const after = await page.request.post(
        `${base}/api/v1/orbs/frontend-fixture-orb/messages/poll`,
        {
          data: { after: 0, tracked: [] },
        },
      );
      check(await after.text()).toBe(inbox);
      await second.close();

      await page.setViewportSize({ width: 1280, height: 900 });
      await input.fill("/compact");
      await input.press("Enter");
      await check(page.locator(".composer-abort")).toBeEnabled();
      await progress.locator("summary").click();
      await page.request.post(control, { data: { outcome: "failed", deferFinish: true } });
      const failure = "Context compaction failed: Fixture summary failed";
      await check(
        page.locator(".orb-transcript-scroll").getByText(failure, { exact: true }),
      ).toHaveCount(1);
      const failed = page.locator(".compaction-activity").filter({ hasText: failure });
      await check(failed).toHaveAttribute("open", "");
      await check(progress).toHaveCount(0);
      await check(page.locator(".composer-abort")).toBeEnabled();
      await page.request.post(control, { data: { outcome: "failed" } });
      await check(failed).toHaveAttribute("open", "");
      await check(page.locator(".compaction-activity .error-text")).toHaveText(failure);
      await check(page.locator(".compaction-activity .error-text")).toHaveCSS(
        "color",
        "rgb(180, 35, 24)",
      );
      await check(page.locator(".orb-composer-feedback-original")).not.toContainText(failure);
      await check(page.locator(".compaction-activity .error-text")).not.toContainText(
        "Compaction aborted",
      );

      await input.fill("/compact");
      await input.press("Enter");
      await check(page.locator(".composer-abort")).toBeEnabled();
      await input.press("Escape");
      const queuedText = "deliver only after compaction";
      await input.fill(queuedText);
      const send = page.getByRole("button", {
        name: "Send message",
        exact: true,
        includeHidden: true,
      });
      await check(send).toBeEnabled();
      await input.press("Control+Enter");
      await check(input).toHaveValue("");
      const queued = page.locator(".rec-you").filter({ hasText: queuedText });
      await check(queued).toHaveCount(1);
      await check(queued.locator(".rec-status")).toHaveText("queued");
      await check(page.locator(".rec-orb").filter({ hasText: queuedText })).toHaveCount(0);
      const held = await page.request.post(
        `${base}/api/v1/orbs/frontend-fixture-orb/messages/poll`,
        {
          data: { after: 0, tracked: [] },
        },
      );
      check(
        (await held.json()).items.filter(
          (message: { status: string }) => message.status === "queued",
        ),
      ).toHaveLength(1);
      await page.request.post(control, { data: { outcome: "completed" } });
      await check(queued).toHaveCount(1);
      await check(queued.locator(".rec-status")).toHaveCount(0);
      await check(page.locator(".rec-orb").filter({ hasText: queuedText })).toHaveCount(1);
      await check(page.locator(".composer-abort")).toHaveCount(0);
    } finally {
      await browser.close();
      await vite.close();
    }
  },
);
