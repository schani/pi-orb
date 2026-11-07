import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, expect, type Locator, type Page, webkit } from "@playwright/test";
import { createServer } from "vite";
import { it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";
import { gotoFrontendFixture } from "./testkit/frontend-fixture.ts";

const INK = "rgb(0, 0, 0)";
const PAPER = "rgb(255, 255, 255)";
const BAD = "rgb(180, 35, 24)";

const colors = (target: Locator) =>
  target.evaluate((element) => {
    const view = element.ownerDocument.defaultView;
    const style = view?.getComputedStyle(element);
    return {
      background: style?.backgroundColor,
      color: style?.color,
      descendants: [
        ...new Set(
          [...element.querySelectorAll("*")]
            .filter((node) => (node.textContent ?? "").trim() !== "")
            .map((node) => view?.getComputedStyle(node).color),
        ),
      ],
    };
  });

/** Focus alone and focus under the pointer must both show the focus treatment. */
async function expectFocus(page: Page, target: Locator, background: string, color: string) {
  await page.keyboard.press("Tab");
  await target.focus();
  for (const hovered of [false, true]) {
    if (hovered) await target.hover();
    const seen = await colors(target);
    expect(seen.background).toBe(background);
    expect(seen.color).toBe(color);
    for (const descendant of seen.descendants) expect(descendant).toBe(color);
  }
  await page.mouse.move(0, 0);
}

it.each(["chromium", "webkit"] as const)(
  "%s: keyboard focus inverts controls past their state colors and hover",
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
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        const head = page.locator(".dashboard .project-head-actions").first();
        await gotoFrontendFixture(page, `${origin}/`, head);

        await expectFocus(
          page,
          head.locator("button.icon-button:not(.danger)").first(),
          INK,
          PAPER,
        );
        await expectFocus(page, head.locator("button.danger"), BAD, PAPER);
        await expectFocus(page, page.locator(".project-archive > summary").first(), INK, PAPER);
        const form = page.locator(".new-project");
        const inputs = form.locator("input");
        await inputs.nth(0).fill("Focus");
        await inputs.nth(1).fill("https://example.com/focus.git");
        await expectFocus(page, form.locator("button"), PAPER, INK);

        const mixed = `${origin}/orbs/frontend-mixed-tool-states`;
        const strip = page.locator("details.activity-strip").first();
        await gotoFrontendFixture(page, mixed, strip);
        await expectFocus(page, strip.locator(":scope > summary"), INK, PAPER);
        await strip.locator(":scope > summary .activity-rail-label").click();
        const steps = page.locator(".activity-strip-body > .activity-rail-row > summary");
        await expect(steps.first()).toBeVisible();
        for (const step of await steps.all()) {
          await step.click();
          await expectFocus(page, step, INK, PAPER);
        }
        await expect(
          steps.locator("xpath=parent::*[contains(@class, 'activity-rail-row-running')]").first(),
        ).toBeVisible();
        await expect(
          steps.locator("xpath=parent::*[contains(@class, 'activity-rail-row-failed')]").first(),
        ).toBeVisible();
        for (const state of ["running", "failed"]) {
          const call = strip.locator(`.tool-call-${state}.injected > summary`);
          await strip.evaluate((element, state) => {
            element.querySelector(".tool-activity-calls")?.insertAdjacentHTML(
              "beforeend",
              `<details class="tool-activity-call tool-call-${state} injected"><summary>
                <span class="tool-call-marker">·</span><code class="trunc">run</code>
                <span class="tool-call-status tool-call-${state}">${state}</span>
                <span class="tool-diff-added">+1</span>
              </summary></details>`,
            );
          }, state);
          await expectFocus(page, call, INK, PAPER);
        }
        await page.close();

        const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
        const composer = phone.locator(".composer-open");
        await gotoFrontendFixture(phone, mixed, composer);
        await composer.click();
        await phone.locator(".composer-input").fill("focus");
        await expectFocus(phone, phone.locator("button.composer-send"), PAPER, INK);
        await phone.close();
      } finally {
        await browser.close();
      }
    } finally {
      await vite.close();
    }
  },
);
