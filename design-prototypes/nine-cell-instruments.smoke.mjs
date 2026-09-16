import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(pathToFileURL(resolve('design-prototypes/nine-cell-instruments.html')).href);
  for (const width of [1440, 760, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.locator('.candidate:visible').count(), 10);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.ok(await page.locator('.marker-line svg').evaluateAll(nodes => nodes.every(node => {
      const rect = node.getBoundingClientRect();
      return rect.width === 16 && rect.height === 16;
    })));
    for (let i = 1; i <= 10; i++) {
      await page.locator(`[data-focus="${i}"]`).click();
      assert.equal(await page.locator('.candidate:visible').count(), 1);
      assert.ok(await page.locator(`[data-id="${i}"]`).isVisible());
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.locator('#compare').click();
    }
    for (const state of ['finished', 'disconnected', 'working']) {
      await page.locator('#state').selectOption(state);
      assert.equal(await page.locator('.marker-line .live:visible').count(), state === 'working' ? 10 : 0);
      if (state !== 'working') assert.equal(await page.locator(state === 'finished' ? '.done:visible' : '.lost:visible').count(), 10);
    }
  }
  await page.locator('#pause').click();
  assert.ok(await page.locator('rect').evaluateAll(nodes => nodes.every(node => getComputedStyle(node).animationPlayState === 'paused')));
  await page.locator('#pause').click();
  await page.locator('#tempo').selectOption('1.5');
  assert.equal(await page.locator('rect').first().evaluate(node => getComputedStyle(node).animationDuration), '3.15s');
  await page.locator('#tempo').selectOption('1');
  // Seek CSS animations explicitly: no sleep, randomness, or snapshot races.
  const patterns = await page.locator('.marker-line svg').evaluateAll(instruments => instruments.map(instrument => {
    const animations = instrument.getAnimations({ subtree: true });
    const samples = [0, 350, 800, 1400, 2100].map(time => {
      animations.forEach(animation => { animation.pause(); animation.currentTime = time; });
      const cells = [...instrument.querySelectorAll('rect')];
      return cells.map(cell => {
        const style = getComputedStyle(cell);
        const bounds = cell.getBoundingClientRect();
        return { opacity: style.opacity, transform: style.transform, fill: style.fill, width: bounds.width, height: bounds.height };
      });
    });
    return samples;
  }));
  for (const samples of patterns) {
    assert.ok(new Set(samples.map(sample => JSON.stringify(sample))).size > 1, 'each design must animate');
    for (const sample of samples) {
      assert.ok(sample.some(cell => Number(cell.opacity) > 0.4 && cell.width > 0 && cell.height > 0), 'each pose retains visible ink');
      assert.ok(sample.every(cell => ['rgb(0, 0, 0)', 'rgb(255, 255, 255)'].includes(cell.fill)), 'black and white fills only');
    }
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.ok(await page.locator('rect').evaluateAll(nodes => nodes.every(node => getComputedStyle(node).animationName === 'none')));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.evaluate(() => document.getAnimations().forEach(animation => { animation.pause(); animation.currentTime = 800; }));
  await page.screenshot({ path: '/tmp/nine-cell-instruments.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 850 });
  await page.screenshot({ path: '/tmp/nine-cell-instruments-mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: ten animated monochrome designs, actual-size geometry, focus/compare, lifecycle previews, four widths, tempo, pause, reduced motion');
} finally {
  await browser.close();
}
