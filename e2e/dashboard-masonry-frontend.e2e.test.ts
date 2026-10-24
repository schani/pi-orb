import { expect as check, type Page } from "@playwright/test";
import { it } from "vitest";
import { gotoFrontendFixture } from "./testkit/frontend-fixture.ts";
import { createFrontendFixture } from "./testkit/frontend-owned.ts";

interface Geometry {
  boardWidth: number;
  boardHeight: number;
  boxes: { id: string; left: number; top: number; width: number; height: number }[];
  errors: string[];
  traces: { outcome?: string; recordCount?: number }[];
}

// Reads the board in page coordinates; a string keeps DOM types out of the Node test program.
const readGeometry = `(() => {
  const board = document.querySelector(".dashboard");
  const origin = board.getBoundingClientRect();
  return {
    boardWidth: document.querySelector(".dashboard-probe").getBoundingClientRect().width,
    boardHeight: origin.height,
    boxes: [...board.children].map((box) => {
      const rect = box.getBoundingClientRect();
      return {
        id: box.id || box.className,
        left: rect.left - origin.left,
        top: rect.top - origin.top,
        width: rect.width,
        height: rect.height,
      };
    }),
    errors: window.__masonryErrors,
    traces: window.piOrbDebug.dump().trace.filter((entry) => entry.event === "masonry"),
  };
})()`;

/** Replays the shortest-column rule over the measured heights and returns every mismatch. */
function masonryViolations(geometry: Geometry): string[] {
  const count = Math.max(1, Math.floor(geometry.boardWidth / 316));
  const width = Math.floor(geometry.boardWidth / count);
  const bottoms = Array.from({ length: count }, () => 0);
  const violations: string[] = [];
  for (const box of geometry.boxes) {
    const column = bottoms.indexOf(Math.min(...bottoms));
    const top = bottoms[column] ?? 0;
    bottoms[column] = top + box.height;
    if (Math.abs(box.width - width) > 0.5) violations.push(`${box.id} width ${box.width}`);
    if (Math.abs(box.left - column * width) > 0.5) violations.push(`${box.id} left ${box.left}`);
    if (Math.abs(box.top - top) > 0.5) violations.push(`${box.id} top ${box.top} != ${top}`);
  }
  if (geometry.boardHeight + 0.5 < Math.max(...bottoms)) {
    violations.push(`board ${geometry.boardHeight} shorter than ${Math.max(...bottoms)}`);
  }
  return violations;
}

async function expectMasonry(page: Page): Promise<Geometry> {
  await check
    .poll(async () => masonryViolations(await page.evaluate<Geometry>(readGeometry)))
    .toEqual([]);
  return page.evaluate<Geometry>(readGeometry);
}

it.each(["chromium", "webkit"] as const)(
  "%s: dashboard packs each project box into the shortest column across widths and reflows",
  async (engine) => {
    const fixture = await createFrontendFixture(engine, {
      page: { viewport: { width: 1280, height: 900 } },
    });
    const { page, origin } = fixture;
    await page.addInitScript(`
      window.__masonryErrors = [];
      window.addEventListener("error", (event) => window.__masonryErrors.push(String(event.message)));
    `);
    await gotoFrontendFixture(
      page,
      `${origin}/`,
      page.locator(".dashboard .project-column").first(),
    );
    await page.evaluate("document.fonts.ready");

    const initial = await expectMasonry(page);
    check(initial.boxes.at(-1)?.id).toBe("new-project");
    // Four columns at 1280px with more boxes than columns: at least one box stacks.
    check(new Set(initial.boxes.map((box) => box.left)).size).toBe(4);
    check(initial.boxes.some((box) => box.top > 0)).toBe(true);

    const archive = page.locator(".project-column .project-archive").first();
    const before = await archive.boundingBox();
    await archive.locator("summary").click();
    await check(archive.locator(".orb-entry").first()).toBeVisible();
    check((await archive.boundingBox())?.height).toBeGreaterThan(before?.height ?? 0);
    await expectMasonry(page);

    const typed = page.locator(".new-project input").first();
    await typed.fill("draft survives reflow");
    for (const width of [900, 631, 1700]) {
      await page.setViewportSize({ width, height: 900 });
      const geometry = await expectMasonry(page);
      check(new Set(geometry.boxes.map((box) => box.left)).size).toBe(
        Math.min(geometry.boxes.length, Math.max(1, Math.floor(geometry.boardWidth / 316))),
      );
    }
    await check(typed).toHaveValue("draft survives reflow");
    await check(archive).toHaveAttribute("open", "");

    const final = await page.evaluate<Geometry>(readGeometry);
    check(final.errors).toEqual([]);
    // Shape edges only: item-count edges repeat a column count, never a steady state.
    const outcomes = final.traces.map((trace) => trace.outcome);
    check(outcomes.filter((outcome, index) => outcome !== outcomes[index - 1])).toEqual([
      "columns=4",
      "columns=2",
      "columns=1",
      "columns=5",
    ]);
  },
);
