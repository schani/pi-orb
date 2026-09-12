// Run after npm ci, with the repository served by a static HTTP server.
// STUDY_URL may point to the published study; CHROMIUM_PATH selects an installed browser.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chromium } from "playwright";

const url = process.env.STUDY_URL ?? "http://localhost:8091/design-prototypes/all-projects-orb.html";
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto(url);
  assert.equal(
    createHash("sha256").update(await page.locator("#product-css").textContent()).digest("hex"),
    "0eb51755e13ad36cc84160794cdeceff69763717f4832b918aa455749834ddff",
    "The embedded product CSS must retain the researched pre-implementation snapshot",
  );
  for (let mode = 0; mode <= 5; mode++) {
    await page.locator(`[data-choice="${mode}"]`).click();
    assert.equal(await page.locator("[data-project]").count(), mode === 0 ? 1 : 5);
    assert.equal(await page.locator("[data-orb]").count(), mode === 0 ? 4 : 14);
    assert.equal(await page.locator('[aria-current="page"]').count(), 1);
    const metrics = await page.evaluate(() => {
      const style = (s) => getComputedStyle(document.querySelector(s));
      const height = (s) => document.querySelector(s).getBoundingClientRect().height;
      return {
        background: style("body").backgroundColor,
        color: style("body").color,
        fontSize: style("body").fontSize,
        lineHeight: style("body").lineHeight,
        projectSize: style(".project-name").fontSize,
        projectWeight: style(".project-name").fontWeight,
        projectLine: height(".project-head-name"),
        header: height(".orb-header"),
        composer: height(".composer-input"),
        prefix: style(".rec").gridTemplateColumns.split(" ")[0],
        tile: height(".glyph"),
        row: document.querySelector(".ix-row") ? height(".ix-row") : null,
        title: document.querySelector(".orb-entry-title") ? height(".orb-entry-title") : null,
        meta: document.querySelector(".orb-entry-meta") ? height(".orb-entry-meta") : null,
      };
    });
    assert.deepEqual(metrics, {
      background: "rgb(255, 255, 255)", color: "rgb(0, 0, 0)", fontSize: "13px",
      lineHeight: "20px", projectSize: "18px", projectWeight: "700", projectLine: 24,
      header: 24, composer: 80, prefix: "32px", tile: 16,
      row: [0, 1, 3].includes(mode) ? 20 : null,
      title: [2, 4, 5].includes(mode) ? 22 : null,
      meta: [2, 4, 5].includes(mode) ? 20 : null,
    }, `Native geometry in design ${mode}`);
    const loaded = await page.locator("#preview img").evaluateAll((images) =>
      images.every((image) => image.complete && image.naturalWidth > 0));
    assert(loaded, "All actual SVG assets load");
    if (mode === 1) {
      assert.equal(await page.locator('.project-new-orb-row').count(), 0);
      assert.equal(await page.locator('.new-orb-icon').count(), 5);
      const actions = await page.locator('.project-head-name').evaluateAll((heads) => heads.map((head) => {
        const group = head.querySelector('.project-head-actions');
        return {
          rightGap: head.getBoundingClientRect().right - group.getBoundingClientRect().right,
          labels: Array.from(group.children).map((action) => action.getAttribute('aria-label')),
          widths: Array.from(group.children).map((action) => action.getBoundingClientRect().width),
        };
      }));
      for (const action of actions) {
        assert.equal(action.rightGap, 0, 'All project title actions align to the right edge');
        assert.deepEqual(action.widths, [24, 24, 24]);
        assert(action.labels[0].startsWith('New orb in '));
        assert(action.labels[1].startsWith('Configure '));
        assert(action.labels[2].startsWith('Delete '));
      }
      await page.getByRole('link', { name: 'New orb in scratchpad', exact: true }).click();
      assert.match(await page.locator('#notice').textContent(), /New orb in scratchpad.*no action is sent/);
    } else {
      assert.equal(await page.locator('.new-orb-icon').count(), 0);
    }
    if (mode === 0) continue;
    await page.locator('[data-orb="1-0"]').click();
    assert.equal(await page.locator(".orb-name").textContent(), "Offline sync");
    await page.locator(".composer-input").fill(`draft ${mode}`);
    await page.locator('[data-orb="0-0"]').click();
    await page.goBack();
    assert.equal(await page.locator(".composer-input").inputValue(), `draft ${mode}`);
    await page.locator('[data-orb="0-0"]').click();
    await page.locator('[data-archive="0"] summary').first().click();
    await page.locator('[data-orb="0-a0"]').click();
    assert.equal(await page.locator(".orb-name").textContent(), "Old dashboard");
    assert(await page.locator(".composer").isHidden());
    await page.locator('[data-orb="0-0"]').click();
    await page.locator('.reasoning > summary').click();
    assert(await page.locator('.reasoning-body').isVisible());
    // Close before the next pass so each archive click has the same initial state.
    await page.locator('[data-archive="0"] summary').first().click();
  }
  await page.locator('#research-toggle').click();
  await page.locator('#research details summary').first().click();
  await page.locator('#research img').first().scrollIntoViewIfNeeded();
  await page.locator('#research img').first().evaluate((image) => image.decode());
  await page.locator('#research details summary').nth(1).click();
  await page.locator('#research img').nth(1).evaluate((image) => image.decode());
  await page.locator('#research-toggle').click();
  // On a narrower desktop, every design still exposes all projects through its canvas.
  await page.setViewportSize({ width: 1024, height: 768 });
  for (let mode = 1; mode <= 5; mode++) {
    await page.locator(`[data-choice="${mode}"]`).click();
    await page.locator('[data-orb="3-0"]').click();
    assert.equal(await page.locator('.orb-name').textContent(), 'Vector map tiles');
  }
  assert.deepEqual(errors, []);
  console.log("PASS: six layouts; exact product CSS/geometry; all projects/assets; navigation/Back; drafts; archives; disclosures; reference screenshots; 1024px canvas.");
} finally {
  await browser.close();
}
