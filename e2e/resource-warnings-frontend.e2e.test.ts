import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OrbMessageView, ResourceWarning } from "@pi-orb/protocol";
import { type Browser, chromium, expect, type Page, type Response } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";
import { gotoFrontendHistory } from "./testkit/frontend-fixture.ts";

const orbId = "frontend-fixture-orb";
const failure = "Resource preparation failed";
const resourceWarnings: ResourceWarning[] = [
  {
    path: ".agents/skills/broken/SKILL.md",
    code: "invalid_yaml",
  },
];
// These message IDs are absent from replicated history, including the delivered message.
const messages: OrbMessageView[] = (["queued", "delivering", "delivered"] as const).map(
  (status, index) => ({
    id: `00000000-0000-4000-8000-00000000000${index}`,
    orbId,
    status,
    content: [{ type: "text", text: `Pending ${status} resource request` }],
    createdAt: "2026-10-09T00:00:00.000Z",
    updatedAt: "2026-10-09T00:00:00.000Z",
  }),
);

async function saveOrbGetEvidence(
  response: Response,
  directory: string,
  phase: "before-reload" | "after-reload",
): Promise<void> {
  const body = await response.json();
  await writeFile(
    join(directory, `orb-get-${phase}.json`),
    JSON.stringify(
      {
        method: response.request().method(),
        path: new URL(response.url()).pathname,
        status: response.status(),
        body,
      },
      null,
      2,
    ),
  );
  expect(response.ok()).toBe(true);
  expect(body.state).toBe("failed");
  expect(body.lastError).toBe(failure);
  expect(body.resourceWarnings).toEqual(resourceWarnings);
}

async function savePageEvidence(
  page: Page,
  directory: string,
  outcome: "success-final" | "failure",
): Promise<void> {
  const captures = await Promise.allSettled([
    page.screenshot({ path: join(directory, `${outcome}.png`), fullPage: true, timeout: 5000 }),
    page.content().then((html) => writeFile(join(directory, `${outcome}.html`), html)),
  ]);
  const errors = captures.flatMap((capture) =>
    capture.status === "rejected" ? [capture.reason] : [],
  );
  if (errors.length > 0) throw new AggregateError(errors, "Could not save page evidence");
}

it.each(["blocked delivery", "warnings survive reload"] as const)(
  "chromium: failed orb %s",
  async (scenario) => {
    const root = join(import.meta.dirname, "../apps/web");
    const evidenceRoot =
      process.env["PI_ORB_E2E_EVIDENCE_DIR"] ??
      join(import.meta.dirname, "../.context/delivery-fix/e2e-evidence");
    await mkdir(evidenceRoot, { recursive: true });
    const evidenceDir = await mkdtemp(
      join(evidenceRoot, `resource-warnings-frontend-${scenario.replaceAll(" ", "-")}-`),
    );
    console.info(`Resource warnings frontend evidence: ${evidenceDir}`);
    const cacheDir = await mkdtemp(join(tmpdir(), "resource-warnings-frontend-"));
    let vite: ViteDevServer | undefined;
    let browser: Browser | undefined;
    let page: Page | undefined;
    let orbReads = 0;
    try {
      await writeFile(
        join(evidenceDir, "message-fixture.json"),
        JSON.stringify({ items: messages, updates: [], cursor: 2 }, null, 2),
      );
      vite = await createServer({
        root,
        cacheDir,
        configFile: join(root, "vite.config.ts"),
        mode: "frontend",
        server: { host: "127.0.0.1", port: 0 },
      });
      await listenFrontend(vite);
      const address = vite.httpServer?.address();
      if (!address || typeof address === "string") throw new Error("No owned fixture port");
      const origin = `http://127.0.0.1:${address.port}`;
      const executablePath =
        process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"] ??
        (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
      browser = await chromium.launch({
        ...(executablePath ? { executablePath } : {}),
        args: ["--no-sandbox"],
      });
      page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.route(`**/api/v1/orbs/${orbId}`, async (route) => {
        const response = await route.fetch();
        orbReads++;
        await route.fulfill({
          response,
          json: {
            ...(await response.json()),
            state: "failed",
            stateVersion: 2,
            activity: "idle",
            lastError: failure,
            resourceWarnings,
          },
        });
      });
      // No runtime/live events supply these diagnostics: reload must use the durable GET.
      await page.route(`**/api/v1/orbs/${orbId}/messages/poll`, async (route) => {
        await route.fulfill({ json: { items: messages, updates: [], cursor: 2 } });
      });
      const isOrbGet = (response: Response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname === `/api/v1/orbs/${orbId}`;
      const [beforeReload] = await Promise.all([
        page.waitForResponse(isOrbGet),
        gotoFrontendHistory(page, `${origin}/orbs/${orbId}`, orbId),
      ]);
      await saveOrbGetEvidence(beforeReload, evidenceDir, "before-reload");
      const main = page.locator(".orb-main");
      const assertFailure = async () => {
        await expect(main.locator(".orb-life-word")).toHaveText("failed");
        await expect(main.locator(".orb-life img")).toHaveAttribute("src", "/favicons/failed.svg");
        await expect(main.locator(".orb-life")).not.toContainText("idle");
        await expect(main.locator(".orb-failure-banner")).toHaveText(failure);
        await expect(main.getByText(failure, { exact: true })).toHaveCount(1);
        await expect(main.locator(".busy-indicator")).toHaveCount(0);
      };
      await assertFailure();
      const assertDelivery = async () => {
        for (const message of messages) {
          const text = message.content[0];
          if (text?.type !== "text") throw new Error("Expected fixture text");
          const row = main.locator(".rec-q", { hasText: text.text });
          await expect(row).toHaveCount(1);
          await expect(row).toBeVisible();
          await expect(row.locator(".rec-status")).toHaveText(
            message.status === "delivered" ? "delivered" : "blocked",
          );
          await expect(row.locator(".error-text")).toHaveCount(0);
        }
        await expect(main.locator(".rec-q")).toHaveCount(3);
      };
      const assertWarning = async () => {
        const warning = resourceWarnings[0];
        if (!warning) throw new Error("Expected fixture resource warning");
        const row = main.getByText(`Skipped repository skill ${warning.path}: invalid YAML.`, {
          exact: true,
        });
        await expect(row).toHaveCount(1);
        await expect(row).toBeVisible();
      };
      const assertScenario = scenario === "blocked delivery" ? assertDelivery : assertWarning;
      await assertScenario();
      const readsBeforeReload = orbReads;
      const [afterReload] = await Promise.all([page.waitForResponse(isOrbGet), page.reload()]);
      await saveOrbGetEvidence(afterReload, evidenceDir, "after-reload");
      await expect.poll(() => orbReads).toBeGreaterThan(readsBeforeReload);
      await assertFailure();
      await assertScenario();
      await savePageEvidence(page, evidenceDir, "success-final");
    } catch (error) {
      await Promise.allSettled([
        writeFile(
          join(evidenceDir, "failure.txt"),
          error instanceof Error ? (error.stack ?? error.message) : String(error),
        ),
        ...(page ? [savePageEvidence(page, evidenceDir, "failure")] : []),
      ]).then((captures) => {
        for (const capture of captures) {
          if (capture.status === "rejected")
            console.error("Evidence capture failed", capture.reason);
        }
      });
      throw error;
    } finally {
      await page?.unrouteAll({ behavior: "ignoreErrors" });
      await page?.close();
      await browser?.close();
      await vite?.close();
      await rm(cacheDir, { recursive: true, force: true });
    }
  },
);
