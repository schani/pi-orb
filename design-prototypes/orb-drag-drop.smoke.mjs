import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const url = process.env.STUDY_URL || new URL('./orb-drag-drop.html', import.meta.url).href;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  assert.equal(await page.locator('.candidate').count(), 5);
  assert.equal(await page.locator('.candidate:visible').count(), 5);
  assert.equal(await page.locator('[data-design="1"] .transcript .drop-treatment:visible').count(), 1);
  assert.equal(await page.locator('#preview').innerText(), 'Simulate drop');
  assert.equal(await page.locator('.feedback:not(:empty)').count(), 0);
  assert.equal(await page.locator('.user-turn small, .orb-turn small, textarea[placeholder]').count(), 0);
  assert.equal(await page.locator('#compare').getAttribute('aria-pressed'), 'true');
  const controls = async (target, kind, state = 'running') => {
    await page.locator('#target').selectOption(target);
    await page.locator('#kind').selectOption(kind);
    await page.locator('#orb-state').selectOption(state);
  };
  const transfer = specs => page.evaluateHandle(specs => {
    const dt = new DataTransfer();
    for (const [name, type] of specs) dt.items.add(new File(['sample'], name, { type }));
    return dt;
  }, specs);
  const gesture = async (design, target, event, specs) => page.locator(`[data-design="${design}"] .${target}`).dispatchEvent(event, { dataTransfer: await transfer(specs) });
  const drop = (design, target, specs) => gesture(design, target, 'drop', specs);
  for (let design = 1; design <= 5; design++) {
    await page.locator(`[data-focus="${design}"]`).click();
    assert.equal(await page.locator('.candidate:visible').count(), 1);
    const card = page.locator(`[data-design="${design}"]`);
    const draft = card.locator('textarea');
    await draft.fill('Keep my draft');
    await controls('transcript', 'files');
    assert.ok(await card.locator('.transcript .drop-treatment').isVisible());
    await controls('composer', 'images');
    assert.match(await card.locator('.composer .drop-treatment').innerText(), /Attach images to message/);
    await controls('composer', 'files');
    assert.match(await card.locator('.composer .drop-treatment').innerText(), /Non-images can only be uploaded as files to the orb\./);
    assert.equal(await card.locator('.feedback').innerText(), '');
    if (design === 2) {
      assert.equal(await card.locator('.drop-treatment:visible').count(), 2);
      assert.match(await card.locator('.transcript .drop-treatment').innerText(), /workspace/i);
      assert.match(await card.locator('.composer .drop-treatment').innerText(), /Non-images/);
      assert.equal(await card.locator('.composer .drop-treatment').getAttribute('data-selected'), 'true');
      assert.equal(await card.locator('.transcript .drop-treatment').getAttribute('data-selected'), 'false');
    }
    await page.locator('#reset').click();
    assert.equal(await draft.inputValue(), 'Keep my draft');
    await drop(design, 'transcript', [['<img src=x onerror=alert(1)>.txt', 'text/plain']]);
    assert.match(await card.locator('.feedback').innerText(), /Simulated workspace upload/);
    assert.equal(await card.locator('.drop-treatment:visible').count(), 0);
    assert.equal(await card.locator('img[src="x"]').count(), 0);
    assert.equal(await draft.inputValue(), 'Keep my draft');
    await drop(design, 'composer', [['photo.png', 'image/png']]);
    assert.match(await card.locator('.feedback').innerText(), /attached to message/);
    assert.match(await card.locator('.attachments').innerText(), /photo\.png/);
    assert.equal(await card.locator('.drop-treatment:visible').count(), 0);
    await drop(design, 'composer', [['notes.txt', 'text/plain']]);
    assert.match(await card.locator('.feedback').innerText(), /Non-images can only be uploaded as files to the orb\./);
    await drop(design, 'composer', [['more.webp', 'image/webp'], ['notes.txt', 'text/plain']]);
    assert.match(await card.locator('.feedback').innerText(), /more\.webp.*Non-images/);
    assert.match(await card.locator('.attachments').innerText(), /more\.webp/);
    await drop(design, 'composer', [['<svg onload=alert(1)>.png', 'image/png']]);
    assert.equal(await card.locator('svg').count(), 0);
    await controls('composer', 'mixed', 'stopped');
    assert.match(await card.locator('.composer .drop-treatment').innerText(), /uploads need a running orb/i);
    await drop(design, 'composer', [['stopped.png', 'image/png']]);
    assert.match(await card.locator('.feedback').innerText(), /uploads need a running orb/i);
    await drop(design, 'transcript', [['stopped.txt', 'text/plain']]);
    assert.match(await card.locator('.feedback').innerText(), /uploads need a running orb/i);
    await controls('transcript', 'files', 'stopped');
    assert.match(await card.locator('.transcript .drop-treatment').innerText(), /uploads need a running orb/i);
    assert.equal(await draft.inputValue(), 'Keep my draft');
  }
  await page.locator('#compare').click();
  assert.equal(await page.locator('.candidate:visible').count(), 5);
  await controls('composer', 'mixed');
  assert.equal(await page.locator('.candidate .composer .drop-treatment:visible').count(), 5);
  assert.equal(await page.locator('.candidate .feedback').evaluateAll(nodes => nodes.every(el => !el.textContent)), false, 'prior drop outcomes remain until reset');
  await page.locator('#reset').click();
  assert.equal(await page.locator('.feedback:not(:empty)').count(), 0);
  await controls('composer', 'mixed');
  await page.locator('#preview').click();
  assert.match(await page.locator('[data-design="1"] .feedback').innerText(), /sample\.png.*Non-images/);
  assert.equal(await page.locator('[data-design="1"] .drop-treatment:visible').count(), 0);
  await controls('transcript', 'files');
  await page.locator('#preview').click();
  assert.match(await page.locator('[data-design="2"] .feedback').innerText(), /Simulated workspace upload.*sample\.txt/);
  await controls('composer', 'images', 'stopped');
  await page.locator('#preview').click();
  assert.match(await page.locator('[data-design="5"] .feedback').innerText(), /Uploads need a running orb/);
  await controls('composer', 'files');
  const dragResult = await page.locator('[data-design="1"] .composer').evaluate(el => {
    const dt = new DataTransfer();
    dt.effectAllowed = 'all';
    dt.items.add(new File(['a'], 'native.png', { type: 'image/png' }));
    let effect;
    el.addEventListener('dragover', () => { effect = dt.dropEffect; }, { once: true });
    const cancelled = !el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    return { cancelled, effect };
  });
  assert.equal(dragResult.cancelled, true);
  assert.match(await page.locator('[data-design="1"] .composer .drop-treatment').innerText(), /Attach images/);
  await gesture(1, 'composer', 'dragover', [['native.txt', 'text/plain']]);
  assert.match(await page.locator('[data-design="1"] .composer .drop-treatment').innerText(), /Non-images/);
  await gesture(1, 'composer', 'dragover', [['unknown.bin', '']]);
  assert.match(await page.locator('[data-design="1"] .composer .drop-treatment').innerText(), /Other files go to the workspace/);
  await page.locator('[data-design="1"] .composer').dispatchEvent('dragleave', { relatedTarget: await page.locator('[data-design="1"] textarea').elementHandle() });
  assert.equal(await page.locator('[data-design="1"] .drop-treatment:visible').count(), 1);
  await page.locator('#orb-state').selectOption('stopped');
  const rejectedEffect = await page.locator('[data-design="1"] .composer').evaluate(el => {
    const dt = new DataTransfer(); dt.effectAllowed = 'all'; dt.items.add(new File(['a'], 'native.png', { type: 'image/png' }));
    let effect;
    el.addEventListener('dragover', () => { effect = dt.dropEffect; }, { once: true });
    el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    return effect;
  });
  assert.equal(rejectedEffect, 'none');
  assert.match(await page.locator('[data-design="1"] .composer .drop-treatment').innerText(), /Uploads need a running orb/);
  await page.locator('#orb-state').selectOption('running');
  await page.locator('[data-design="1"] .composer').dispatchEvent('dragleave', { relatedTarget: await page.locator('body').elementHandle() });
  assert.equal(await page.locator('[data-design="1"] .drop-treatment:visible').count(), 0);
  await drop(1, 'composer', [['native.png', 'image/png']]);
  assert.match(await page.locator('[data-design="1"] .attachments').innerText(), /native\.png/);
  assert.equal(await page.locator('[data-design="1"] .drop-treatment:visible').count(), 0);
  assert.equal(new URL(page.url()).pathname, new URL(url).pathname);
  await page.reload();
  const heads = await page.locator('[data-design="1"] .candidate-head, [data-design="2"] .candidate-head').evaluateAll(nodes => nodes.map(el => Math.round(el.getBoundingClientRect().height)));
  assert.equal(heads[0], heads[1]);
  const opacity = await page.locator('[data-design="1"] .drop-treatment').first().evaluate(el => getComputedStyle(el).backgroundColor);
  assert.match(opacity, /0\.7[0-9]/);
  await page.screenshot({ path: '/tmp/orb-drag-drop-desktop.png', fullPage: true });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}px`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/orb-drag-drop-mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: five designs, split destinations, simulation, native hover/drop/leave, stopped, mixed, XSS, draft, mobile, no browser errors');
  console.log('Screenshots: /tmp/orb-drag-drop-desktop.png /tmp/orb-drag-drop-mobile.png');
} finally {
  await browser.close();
}
