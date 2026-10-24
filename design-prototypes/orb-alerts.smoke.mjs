import { runStudy } from "./study-browser.mjs";
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';

const url = pathToFileURL(fileURLToPath(new URL('./orb-alerts.html', import.meta.url))).href;
await runStudy("orb-alerts", async ({ browser, artifact, outputDir }) => {

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  assert.equal(await page.locator('.candidate').count(), 5);
  assert.equal(await page.locator('.candidate:visible').count(), 5);
  assert.equal(await page.locator('.candidate .alert-message').count(), 5);
  assert.equal(await page.locator('.candidate .alert-message').first().textContent(), 'The migration is ready. Approve the production run.');
  assert.equal(await page.locator('.candidate .alert-icon').count(), 10, 'sidebar and header both show alert');
  assert.ok(await page.locator('.candidate .alert-icon').evaluateAll(icons => icons.every(icon => icon.getBoundingClientRect().width === 16 && icon.getBoundingClientRect().height === 16)));
  assert.equal(await page.locator('.candidate .alert-icon svg').count(), 10);
  assert.equal(await page.locator('.candidate .badge').count(), 10);
  assert.equal(await page.locator('.candidate .alert-turn').count(), 5);
  const states = ['neutral','running','busy','sleeping','stopped','failed','transitional','archiving','archived','deleting'];
  assert.deepEqual(await page.locator('#lifecycle option').evaluateAll(options => options.map(option => option.value)), states);
  for (const state of states) {
    await page.locator('#lifecycle').selectOption(state);
    assert.equal(await page.locator('.candidate .badge').count(), 10, `alert overrides ${state}`);
    assert.equal(await page.locator('.candidate .state-icon').count(), 0);
    await page.locator('[data-design="1"] .header-link').click();
    assert.equal(await page.locator('.candidate .badge').count(), 0, 'opening header clears alert');
    assert.equal(await page.locator('.candidate .alert-turn').count(), 5, 'clearing badge preserves transcript styling');
    assert.equal(await page.locator(`.candidate .state-icon[data-state="${state}"]`).count(), 10);
    const actual = await readFile(new URL(`../apps/web/public/favicons/${state}.svg`, import.meta.url), 'utf8');
    const sources = await page.locator('.candidate .state-icon img').evaluateAll(images => images.map(image => decodeURIComponent(image.src.split(',')[1])));
    assert.ok(sources.every(source => source === actual), `${state} icon must match repo favicon SVG exactly`);
    await page.locator('#raise').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.candidate .badge').count(), 10);
  }
  await page.locator('[data-design="1"] .orb-link').click();
  assert.equal(await page.locator('.candidate .badge').count(), 0, 'opening sidebar clears alert');
  await page.locator('#raise').click();
  for (let n = 1; n <= 5; n++) {
    await page.locator(`[data-focus="${n}"]`).focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.candidate:visible').count(), 1);
    assert.ok(await page.locator(`[data-design="${n}"]`).isVisible());
    await page.locator('#compare').click();
  }
  const hostile = '<img src=x onerror=alert(1)>\n' + 'unbroken'.repeat(70);
  await page.locator('#message').fill(hostile);
  assert.equal(await page.locator('.candidate .alert-message').first().textContent(), hostile);
  assert.equal(await page.locator('.candidate .alert-message img').count(), 0);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.locator('.candidate:visible').count(), 5);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}`);
    if (width <= 390) {
      assert.equal(await page.locator('.candidate .sidebar:visible').count(), 0, 'phone hides sidebar');
      assert.equal(await page.locator('.candidate .header-link:visible').count(), 5);
      assert.ok(await page.locator('.candidate .alert-icon:visible').evaluateAll(icons => icons.every(icon => icon.closest('.orb-header'))));
    }
    await page.screenshot({ path: artifact(`orb-alerts-${width}.png`), fullPage: true });
  }
  await page.locator('#message').fill('The migration is ready. Approve the production run.');
  await page.locator('#lifecycle').selectOption('running');
  await page.locator('#message').blur();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: artifact('orb-alerts-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: artifact('orb-alerts-phone.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: five styles, exact favicon assets, ten lifecycle overrides, header/sidebar entry, keyboard, literal unsafe text, phone layout, 320/390/desktop containment');
  console.log(`Screenshots: ${outputDir}`);

});
