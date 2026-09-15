import { join } from "node:path";
import { expect as check, chromium, webkit } from "@playwright/test";
import { createServer } from "vite";
import { it } from "vitest";

it.each(["chromium", "webkit"] as const)(
  "%s: final stopped edge recovers records replicated after stopping began",
  async (engine) => {
    const root = join(import.meta.dirname, "../apps/web");
    const vite = await createServer({
      root,
      configFile: join(root, "vite.config.ts"),
      mode: "frontend",
      server: { host: "127.0.0.1", port: 0 },
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("No fixture port");
    const browser = await (engine === "chromium" ? chromium : webkit).launch();
    const page = await browser.newPage();
    const a = "frontend-long-history";
    let lifecycle = "running";
    try {
      await page.route(`**/api/v1/orbs/${a}`, async (route) => {
        const response = await route.fetch();
        return route.fulfill({ response, json: { ...(await response.json()), state: lifecycle } });
      });
      await page.route(`**/orbs/${a}/history`, async (route) => {
        const response = await route.fetch();
        const view = await response.json();
        if (lifecycle === "stopped") {
          view.records.push({
            id: "sealed-tail",
            parentId: view.cursor,
            timestamp: "now",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "FINAL_REPLICATED_TAIL" }],
            overflow: {},
          });
          view.cursor = "sealed-tail";
          view.headId = view.cursor;
        }
        return route.fulfill({ response, json: view });
      });
      await page.goto(`http://127.0.0.1:${address.port}/#/orbs/${a}`);
      await check(page.getByRole("button", { name: "Change thinking", exact: true })).toBeEnabled();
      const intermediate = page.waitForResponse(`**/orbs/${a}/history`);
      lifecycle = "stopping";
      await (await intermediate).finished();
      await check(page.locator(".orb-life")).toContainText("stopping");
      lifecycle = "stopped";
      await check(page.locator(".orb-life")).toContainText("stopped");
      await check(page.locator(".history")).toContainText("FINAL_REPLICATED_TAIL");
    } finally {
      await page.close();
      await browser.close();
      await vite.close();
    }
  },
);
