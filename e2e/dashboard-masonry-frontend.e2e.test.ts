import { expect as check, type Page } from "@playwright/test";
import { it } from "vitest";
import { gotoFrontendFixture } from "./testkit/frontend-fixture.ts";
import { createFrontendFixture } from "./testkit/frontend-owned.ts";

type Box = { left: number; top: number; width: number; height: number };

// A string keeps DOM types out of the Node test program.
const readBoxes = `(() => {
  const board = document.querySelector(".dashboard").getBoundingClientRect();
  return {
    width: document.querySelector(".dashboard-probe").getBoundingClientRect().width,
    boxes: [...document.querySelector(".dashboard").children].map((box) => {
      const rect = box.getBoundingClientRect();
      return { left: rect.left - board.left, top: rect.top - board.top, width: rect.width, height: rect.height };
    }),
  };
})()`;

/** Replays the shortest-column rule over the measured heights and returns every mismatch. */
async function masonryViolations(page: Page): Promise<string[]> {
  const board = await page.evaluate<{ width: number; boxes: Box[] }>(readBoxes);
  const count = Math.max(1, Math.floor(board.width / 316));
  const width = Math.floor(board.width / count);
  const bottoms = Array.from({ length: count }, () => 0);
  return board.boxes.flatMap((box, index) => {
    const column = bottoms.indexOf(Math.min(...bottoms));
    const top = bottoms[column] ?? 0;
    bottoms[column] = top + box.height;
    const expected = { left: column * width, top, width };
    return (["left", "top", "width"] as const)
      .filter((key) => Math.abs(box[key] - expected[key]) > 0.5)
      .map((key) => `box ${index} ${key} ${box[key]} != ${expected[key]}`);
  });
}

it.each(["chromium", "webkit"] as const)(
  "%s: dashboard packs each project box into the shortest column across widths and reflows",
  async (engine) => {
    const { page, origin } = await createFrontendFixture(engine, {
      page: { viewport: { width: 1280, height: 900 } },
    });
    await gotoFrontendFixture(
      page,
      `${origin}/`,
      page.locator(".dashboard .project-column").first(),
    );
    await check.poll(() => masonryViolations(page)).toEqual([]);

    const archive = page.locator(".project-column .project-archive").first();
    await archive.locator("summary").click();
    await check(archive.locator(".orb-entry").first()).toBeVisible();
    await check.poll(() => masonryViolations(page)).toEqual([]);

    const draft = page.locator(".new-project input").first();
    await draft.fill("draft survives reflow");
    for (const width of [900, 631, 1700]) {
      await page.setViewportSize({ width, height: 900 });
      await check.poll(() => masonryViolations(page)).toEqual([]);
    }
    await check(draft).toHaveValue("draft survives reflow");
    await check(archive).toHaveAttribute("open", "");
  },
);
