import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, expect, webkit } from "@playwright/test";
import { createServer } from "vite";
import { it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";
import { gotoFrontendFixture, gotoFrontendHistory } from "./testkit/frontend-fixture.ts";

const INK = "rgb(255, 255, 255)";
const PAPER = "rgb(0, 0, 0)";
const LIGHT_G3 = "rgb(85, 85, 85)";
const DARK_G3 = "rgb(170, 170, 170)";
const YOU = "rgb(43, 43, 43)";
const RED = "rgb(180, 35, 24)";

it.each(["chromium", "webkit"] as const)(
  "%s: follows the desktop color scheme live",
  async (engine) => {
    const root = join(import.meta.dirname, "../apps/web");
    const vite = await createServer({
      root,
      configFile: join(root, "vite.config.ts"),
      mode: "frontend",
      server: { host: "127.0.0.1", port: 0 },
    });
    try {
      await listenFrontend(vite);
      const address = vite.httpServer?.address();
      if (!address || typeof address === "string") throw new Error("No owned fixture port");
      const origin = `http://127.0.0.1:${address.port}`;
      const executable = existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined;
      const browser =
        engine === "chromium"
          ? await chromium.launch({
              ...(executable === undefined ? {} : { executablePath: executable }),
              args: ["--no-sandbox"],
            })
          : await webkit.launch();
      try {
        const page = await browser.newPage({
          viewport: { width: 1280, height: 900 },
          colorScheme: "dark",
        });
        const body = page.locator("body");
        const head = page.locator(".dashboard .project-head-actions").first();
        await gotoFrontendFixture(page, `${origin}/`, head);
        await expect(body).toHaveCSS("background-color", PAPER);
        await expect(body).toHaveCSS("color", INK);
        await expect(head.locator("svg.ic rect").first()).toHaveCSS("fill", LIGHT_G3);
        await page.emulateMedia({ colorScheme: "light" });
        await expect(body).toHaveCSS("background-color", INK);
        await expect(body).toHaveCSS("color", PAPER);
        await page.emulateMedia({ colorScheme: "dark" });
        await expect(body).toHaveCSS("background-color", PAPER);

        const strip = page.locator("details.activity-strip").first();
        await gotoFrontendFixture(page, `${origin}/orbs/frontend-mixed-tool-states`, strip);
        await expect(page.locator(".ix-row-current")).toHaveCSS("background-color", INK);
        await strip.evaluate((element) => {
          element.insertAdjacentHTML(
            "beforebegin",
            '<article class="rec rec-you">turn</article><div class="alert-band">deploy</div><img class="msg-image" alt="shot" src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==">',
          );
        });
        const you = page.locator(".rec-you");
        await expect(you).toHaveCSS("background-color", YOU);
        await expect(you).toHaveCSS("color", INK);
        await expect(page.locator(".alert-band")).toHaveCSS("background-color", RED);
        await expect(page.locator(".alert-band")).toHaveCSS("color", INK);
        await expect(page.locator(".msg-image")).toHaveCSS("background-color", INK);

        await gotoFrontendHistory(page, `${origin}/orbs/frontend-charts`, "frontend-charts");
        const label = page.locator(".chart-canvas svg .role-axis-label text").first();
        await page
          .locator("details.chart-strip")
          .first()
          .evaluate((element) => {
            element.setAttribute("open", "");
          });
        await expect(label).toHaveCSS("fill", DARK_G3);
        await page.emulateMedia({ colorScheme: "light" });
        await expect(label).toHaveCSS("fill", LIGHT_G3);
        await page.emulateMedia({ colorScheme: "dark" });

        await gotoFrontendHistory(page, `${origin}/orbs/frontend-diagrams`, "frontend-diagrams");
        const node = page.locator(".mermaid-canvas svg .node rect").first();
        await expect(node).toHaveCSS("fill", PAPER);
        await expect(node).toHaveCSS("stroke", INK);
        await page.emulateMedia({ colorScheme: "light" });
        await expect(node).toHaveCSS("fill", INK);
        await expect(node).toHaveCSS("stroke", PAPER);
        await page.close();
      } finally {
        await browser.close();
      }
    } finally {
      await vite.close();
    }
  },
);
