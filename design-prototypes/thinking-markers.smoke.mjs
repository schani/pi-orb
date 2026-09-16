import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.STUDY_URL || 'http://127.0.0.1:8765/design-prototypes/thinking-markers.html');
  for (const width of [1440, 760, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.locator('.candidate:visible').count(), 5);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    for (let i = 1; i <= 5; i++) {
      await page.locator(`[data-focus="${i}"]`).click();
      assert.equal(await page.locator('.candidate:visible').count(), 1);
      assert.ok(await page.locator(`[data-id="${i}"]`).isVisible());
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.locator('#compare').click();
    }
    for (const phase of ['streaming', 'finished', 'disconnected', 'thinking']) {
      await page.locator('#phase').selectOption(phase);
      assert.equal(await page.locator('.marker:visible').count(), ['thinking', 'streaming'].includes(phase) ? 5 : 0);
      if (phase === 'finished') assert.equal(await page.locator('.done:visible').count(), 5);
      if (phase === 'disconnected') assert.equal(await page.locator('.lost:visible').count(), 5);
    }
  }
  assert.ok(await page.locator('.matrix i').evaluateAll(cells => cells.every(cell => cell.getBoundingClientRect().height === 4 && cell.getBoundingClientRect().width === 4)));
  await page.locator('#motion').click();
  assert.equal(await page.locator('.margin-mark').evaluate(el => getComputedStyle(el, '::before').animationPlayState), 'paused');
  await page.locator('#motion').click();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.ok(await page.locator('.marker, .marker *').evaluateAll(elements => elements.every(el => getComputedStyle(el).animationName === 'none')));
  assert.equal(await page.locator('.margin-mark').evaluate(el => getComputedStyle(el, '::before').animationName), 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.screenshot({ path: '/tmp/thinking-markers.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: five designs, focus/compare, four phases, four widths, pause, reduced motion, no page errors');
} finally {
  await browser.close();
}
