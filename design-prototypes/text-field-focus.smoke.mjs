import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const file = new URL('./text-field-focus.html', import.meta.url);
const url = process.env.STUDY_URL ?? pathToFileURL(file.pathname).href;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.goto(`${url}?variant=regular`);
await page.waitForFunction(() => document.activeElement?.getAttribute('data-field') === 'personal-markdown');
assert.equal(await page.locator('[data-scene-panel="personal"]').isVisible(), true);
const initialField = page.locator('[data-field="personal-markdown"]');
await page.locator('a[data-variant="inverted"]').click();
assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-field')), 'personal-markdown');
assert.deepEqual(await initialField.evaluate(element => ({
  background: getComputedStyle(element).backgroundColor,
  foreground: getComputedStyle(element).color,
})), { background: 'rgb(0, 0, 0)', foreground: 'rgb(255, 255, 255)' });
await page.locator('a[data-variant="regular"]').click();
assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-field')), 'personal-markdown');

const inventory = {
  personal: ['personal-markdown'],
  composer: ['composer'],
  rename: ['orb-rename'],
  search: ['search'],
  dashboard: ['project-name', 'repository-url'],
  general: ['config-name', 'config-url'],
  instructions: ['project-markdown'],
  secrets: ['secret-name', 'secret-value'],
  mcps: ['mcp-name', 'mcp-url', 'mcp-description'],
};
assert.equal(await page.locator('[data-field]').count(), 14, 'field inventory changed');

const colors = locator => locator.evaluate(element => {
  const style = getComputedStyle(element);
  const placeholder = getComputedStyle(element, '::placeholder');
  return {
    background: style.backgroundColor,
    foreground: style.color,
    caret: style.caretColor,
    shadow: style.boxShadow,
    placeholder: placeholder.color,
  };
});

for (const variant of ['regular', 'inverted']) {
  await page.locator(`a[data-variant="${variant}"]`).click();
  assert.equal(await page.locator('#study').getAttribute('data-variant'), variant);
  assert.match(page.url(), new RegExp(`variant=${variant}`));
  for (const [scene, fields] of Object.entries(inventory)) {
    await page.locator(`[data-scene="${scene}"]`).click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator(`[data-scene-panel="${scene}"]`).isVisible(), true);
    assert.match(page.url(), new RegExp(`scene=${scene}`));
    for (const name of fields) {
      const field = page.locator(`[data-field="${name}"]`);
      await field.evaluate(element => element.blur());
      assert.deepEqual((({ background, foreground, caret }) => ({ background, foreground, caret }))(await colors(field)), {
        background: 'rgb(255, 255, 255)',
        foreground: 'rgb(0, 0, 0)',
        caret: 'rgb(0, 0, 0)',
      }, `${variant}/${name} blur colors`);
      await field.focus();
      const focused = await colors(field);
      if (variant === 'regular') {
        assert.equal(focused.background, 'rgb(255, 255, 255)', `${name} regular background`);
        assert.equal(focused.foreground, 'rgb(0, 0, 0)', `${name} regular foreground`);
        assert.equal(focused.caret, 'rgb(0, 0, 0)', `${name} regular caret`);
        assert.notEqual(focused.shadow, 'none', `${name} regular inset indicator`);
      } else {
        assert.equal(focused.background, 'rgb(0, 0, 0)', `${name} inverted background`);
        assert.equal(focused.foreground, 'rgb(255, 255, 255)', `${name} inverted foreground`);
        assert.equal(focused.caret, 'rgb(255, 255, 255)', `${name} inverted caret`);
        if (await field.getAttribute('placeholder'))
          assert.equal(focused.placeholder, 'rgb(187, 187, 187)', `${name} inverted placeholder`);
      }
    }
  }
}

// Scene and variant changes retain in-memory drafts.
await page.locator('[data-scene="personal"]').click();
const personal = page.locator('[data-field="personal-markdown"]');
await personal.fill('# retained\n\nAcross scene and variant changes.');
await page.locator('[data-scene="dashboard"]').click();
await page.locator('a[data-variant="regular"]').click();
await page.locator('[data-scene="personal"]').click();
assert.equal(await personal.inputValue(), '# retained\n\nAcross scene and variant changes.');

// Forms never submit or navigate, and Config tabs switch the simulated scene.
await page.locator('[data-scene="general"]').click();
const configName = page.locator('[data-field="config-name"]');
await configName.fill('local draft');
await page.evaluate(() => { window.__prototypeSentinel = 'alive'; });
await configName.press('Enter');
await page.locator('[data-scene-panel="general"] .actions button').click();
assert.equal(await page.evaluate(() => window.__prototypeSentinel), 'alive');
assert.equal(await configName.inputValue(), 'local draft');
assert.match(page.url(), /scene=general/);
await page.locator('[data-scene-panel="general"] [data-config-scene="instructions"]').click();
assert.equal(await page.locator('[data-scene-panel="instructions"]').isVisible(), true);
assert.match(page.url(), /scene=instructions/);
await page.locator('[data-scene-panel="instructions"] [data-config-scene="secrets"]').click();
assert.equal(await page.locator('[data-scene-panel="secrets"]').isVisible(), true);

for (const width of [320, 390, 1440]) {
  await page.setViewportSize({ width, height: width === 1440 ? 900 : 760 });
  for (const variant of ['regular', 'inverted']) {
    await page.locator(`a[data-variant="${variant}"]`).click();
    for (const scene of Object.keys(inventory)) {
      await page.locator(`[data-scene="${scene}"]`).click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${variant}/${scene} overflows at ${width}px`);
    }
    await page.locator('[data-scene="personal"]').click();
    await personal.focus();
    const geometry = await page.evaluate(() => {
      const variants = document.querySelector('.variants').getBoundingClientRect();
      const scenes = document.querySelector('.scene-nav').getBoundingClientRect();
      const active = document.querySelector('.scene.active').getBoundingClientRect();
      return { variantBottom: variants.bottom, sceneTop: scenes.top, activeBottom: active.bottom, viewport: innerHeight };
    });
    assert.ok(geometry.variantBottom <= geometry.sceneTop, `variant controls overlap scenes at ${width}px`);
    assert.ok(geometry.activeBottom >= geometry.viewport, `active scene does not fill ${width}px viewport`);
    await page.screenshot({ path: `/tmp/text-field-focus-${variant}-${width}.png`, fullPage: true });
  }
}

assert.deepEqual(errors, []);
await browser.close();
console.log('14 fields × 2 variants; focus/drafts retained, submissions blocked, Config tabs wired, 320/390/1440 geometry, and 6 screenshots passed.');
