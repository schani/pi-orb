import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(pathToFileURL(resolve('design-prototypes/aperture-ascii.html')).href);
  for (const width of [1440, 760, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.locator('.candidate:visible').count(), 10);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.ok(await page.locator('.marker-line .instrument').evaluateAll(nodes => nodes.every(node => node.getBoundingClientRect().height === 16)));
    assert.ok(await page.locator('.marker-line svg').evaluateAll(nodes => nodes.every(node => {
      const rect = node.getBoundingClientRect();
      return rect.width === 16 && rect.height === 16;
    })));
    for (const family of ['aperture', 'ascii', 'all']) {
      await page.locator(`[data-family="${family}"]`).click();
      assert.equal(await page.locator('.candidate:visible').count(), family === 'all' ? 10 : 5);
      assert.equal(await page.locator(`[data-family="${family}"]`).getAttribute('aria-pressed'), 'true');
    }
    for (const id of ['A1', 'A2', 'A3', 'A4', 'A5', 'T1', 'T2', 'T3', 'T4', 'T5']) {
      await page.locator(`[data-focus="${id}"]`).click();
      assert.equal(await page.locator('.candidate:visible').count(), 1);
      assert.ok(await page.locator(`[data-id="${id}"]`).isVisible());
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.locator('[data-family="all"]').click();
    }
    for (const state of ['finished', 'disconnected', 'working']) {
      await page.locator('#state').selectOption(state);
      assert.equal(await page.locator('.marker-line .live:visible').count(), state === 'working' ? 10 : 0);
      if (state !== 'working') assert.equal(await page.locator(state === 'finished' ? '.done:visible' : '.lost:visible').count(), 10);
    }
  }
  await page.locator('#pause').click();
  assert.ok(await page.locator('.pose').evaluateAll(nodes => nodes.every(node => getComputedStyle(node).animationPlayState === 'paused')));
  await page.locator('#pause').click();
  await page.locator('#tempo').selectOption('1.5');
  assert.equal(await page.locator('.pose').first().evaluate(node => getComputedStyle(node).animationDuration), '4.2s');
  await page.locator('#tempo').selectOption('1');
  // Seek every pose, including the loop boundary. No wall-clock waits.
  const sequences = await page.locator('.marker-line .instrument').evaluateAll(instruments => instruments.map(instrument => {
    const poses = [...instrument.querySelectorAll('.pose')];
    const animations = instrument.getAnimations({ subtree: true });
    const duration = Number(animations[0].effect.getTiming().duration);
    return Array.from({ length: poses.length + 1 }, (_,i) => {
      animations.forEach(animation => { animation.pause(); animation.currentTime = (i + 0.1) * duration / poses.length; });
      return poses.map(pose => Number(getComputedStyle(pose).opacity));
    });
  }));
  for (const sequence of sequences) {
    const count = sequence[0].length;
    sequence.forEach((pose, i) => {
      assert.equal(pose.filter(opacity => opacity === 1).length, 1, 'exactly one pose visible');
      assert.equal(pose[i % count], 1, 'expected deterministic frame');
      assert.ok(pose.every(opacity => opacity === 0 || opacity === 1), 'no fades or ghost frames');
    });
  }
  assert.ok(await page.locator('.ascii .pose').evaluateAll(poses => poses.every(pose => /^[\x20-\x7E]+$/.test(pose.textContent))), 'literal ASCII only');
  assert.ok(await page.locator('.marker-line .ascii').evaluateAll(instruments => [...instruments].every(instrument => {
    const width = instrument.getBoundingClientRect().width;
    return [...instrument.querySelectorAll('.pose')].every(pose => pose.scrollWidth <= Math.ceil(width));
  })), 'all character poses fit fixed-width slots');
  assert.equal(await page.getByRole('status', { name: 'Agent working' }).count(), 10);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.ok(await page.locator('.pose').evaluateAll(nodes => nodes.every(node => getComputedStyle(node).animationName === 'none')));
  assert.ok(await page.locator('.marker-line .instrument').evaluateAll(instruments => instruments.every(instrument => {
    const visible = [...instrument.querySelectorAll('.pose')].filter(pose => getComputedStyle(pose).opacity === '1');
    return visible.length === 1;
  })), 'reduced motion retains one stable pose');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  // Keep all specimens in the viewport when seeking screenshot poses; Chromium
  // can defer offscreen animation paint during a full-page capture.
  for (const [width, path] of [[1440, '/tmp/aperture-ascii.png'], [390, '/tmp/aperture-ascii-mobile.png']]) {
    await page.setViewportSize({ width, height: 850 });
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width, height });
    await page.evaluate(() => document.getAnimations().forEach(animation => { animation.pause(); animation.currentTime = 800; }));
    await page.screenshot({ path, fullPage: true });
  }
  assert.deepEqual(errors, []);
  console.log('PASS: ten variants, four widths, family/focus controls, states, pause/tempo, every animation pose, ASCII geometry, reduced motion');
} finally {
  await browser.close();
}
