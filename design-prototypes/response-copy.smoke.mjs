import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const url = process.env.STUDY_URL || 'http://127.0.0.1:8765/design-prototypes/response-copy.html';
const origin = new URL(url).origin;
const rich = '### I found two constraints:\n\n- Preserve the `stale_head` guard.\n- Copy the [raw response](https://example.test/runtime), not rendered text.\n\n```ts\nconst head = snapshot.head;\nawait socket.send({ head });\n```\n\nThe **snapshot gate** remains unchanged.';
const short = 'Done — the response source stays intact.';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);

  assert.equal(await page.locator('[data-focus]').count(), 5);
  assert.equal(await page.locator('.candidate:visible').count(), 5);
  assert.equal(await page.locator('.candidate').count(), 5);
  assert.equal(await page.locator('.response-copy').count(), 10);
  assert.equal(await page.locator('.code-copy').count(), 5);
  assert.equal(await page.locator('.candidate:last-child').evaluate(el => getComputedStyle(el).gridColumnEnd), '-1');
  assert.ok(await page.locator('.response[data-response="rich"]').evaluateAll(responses => responses.every(response => {
    const tool = response.querySelector('.activity');
    const finalParagraph = response.querySelector('p');
    return Boolean(tool && finalParagraph && (tool.compareDocumentPosition(finalParagraph) & Node.DOCUMENT_POSITION_FOLLOWING));
  })));
  assert.equal(await page.locator('[data-design="3"] [data-response="rich"]').evaluate(el => el.lastElementChild.classList.contains('response-end')), true);
  assert.equal(await page.locator('[data-design="4"] [data-response="rich"] p').evaluate(el => el.nextElementSibling.classList.contains('response-copy')), true);

  const cornerButton = page.locator('[data-design="2"] .response-copy').first();
  assert.equal(await cornerButton.evaluate(el => getComputedStyle(el).opacity), '0');
  await cornerButton.focus();
  assert.equal(await cornerButton.evaluate(el => getComputedStyle(el).opacity), '1');
  await page.locator('[data-design="1"] .response-copy[data-source="short"]').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), short);
  assert.equal(await page.locator('[data-design="1"] .response-copy[data-source="short"]').getAttribute('data-state'), 'copied');

  for (let design = 1; design <= 5; design++) {
    await page.locator(`[data-focus="${design}"]`).click();
    assert.equal(await page.locator('.candidate:visible').count(), 1);
    assert.ok(await page.locator(`[data-design="${design}"]`).isVisible());
    for (const [key, expected] of [['rich', rich], ['short', short]]) {
      const button = page.locator(`[data-design="${design}"] .response-copy[data-source="${key}"]`);
      await button.click();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), expected);
      assert.equal(await button.getAttribute('data-state'), 'copied');
      assert.equal(await button.getAttribute('aria-label'), 'Copied response Markdown');
      assert.equal(await page.locator(`[data-design="${design}"] [data-response="${key}"] .copy-status`).textContent(), 'copied');
    }
    await page.locator('#compare').click();
  }

  const richClipboard = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(richClipboard, short);
  assert.ok(rich.startsWith('### I found two constraints:'));
  assert.ok(rich.includes('```ts'));
  assert.ok(rich.includes('[raw response](https://example.test/runtime)'));
  assert.ok(rich.includes('**snapshot gate**'));
  assert.ok(!rich.includes('checking runtime ownership'));
  assert.ok(!rich.includes('runtime-socket.ts'));

  const codeButton = page.locator('[data-design="1"] .code-copy');
  assert.equal(await codeButton.getAttribute('aria-label'), 'Copy code block');
  await codeButton.click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'const head = snapshot.head;\nawait socket.send({ head });');

  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.equal(await page.locator('.candidate:visible').count(), 5);
    const sizes = await page.locator('.response-copy:visible, .code-copy:visible, [data-focus]:visible, #compare:visible, #phone:visible').evaluateAll(elements => elements.map(el => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height })));
    assert.ok(sizes.every(size => size.width >= 44 && size.height >= 44), `undersized target at ${width}px: ${JSON.stringify(sizes.filter(size => size.width < 44 || size.height < 44))}`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('#phone').click();
  assert.equal(await page.locator('#gallery').evaluate(el => Math.round(el.getBoundingClientRect().width)), 390);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.locator('#phone').click();

  await page.reload();
  assert.ok(await page.locator('.response-copy').evaluateAll(buttons => buttons.every(button => button.getAttribute('aria-label') === 'Copy response Markdown' && !button.hasAttribute('data-state'))));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: '/tmp/response-copy-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/response-copy-mobile-390.png', fullPage: true });
  await page.setViewportSize({ width: 320, height: 740 });
  await page.screenshot({ path: '/tmp/response-copy-mobile-320.png', fullPage: true });
  assert.deepEqual(errors, []);
  await context.close();

  const deniedContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await deniedContext.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => { throw new DOMException('Denied', 'NotAllowedError'); } },
    });
  });
  const denied = await deniedContext.newPage();
  const deniedErrors = [];
  denied.on('pageerror', error => deniedErrors.push(error.message));
  await denied.goto(url);
  for (let design = 1; design <= 5; design++) {
    const failedButton = denied.locator(`[data-design="${design}"] .response-copy[data-source="rich"]`);
    await failedButton.click();
    assert.equal(await failedButton.getAttribute('data-state'), 'failed');
    assert.equal(await failedButton.getAttribute('aria-label'), 'Clipboard blocked; raw Markdown shown below');
    assert.equal(await denied.locator(`[data-design="${design}"] [data-response="rich"] .copy-status`).textContent(), 'copy failed');
    const manual = denied.locator(`[data-design="${design}"] [data-response="rich"] .manual`);
    assert.ok(await manual.isVisible());
    assert.equal(await manual.locator('textarea').inputValue(), rich);
    assert.equal(await manual.locator('textarea').evaluate(el => el.selectionStart === 0 && el.selectionEnd === el.value.length), true);
    assert.equal(await denied.locator(`[data-design="${design}"] [data-response="rich"]`).evaluate(response => {
      const manualBox = response.querySelector('.manual').getBoundingClientRect();
      const buttonBox = response.querySelector('.response-copy').getBoundingClientRect();
      return !(manualBox.right <= buttonBox.left || manualBox.left >= buttonBox.right || manualBox.bottom <= buttonBox.top || manualBox.top >= buttonBox.bottom);
    }), false, `manual fallback overlaps design ${design} copy action`);
  }
  assert.ok(await denied.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await denied.screenshot({ path: '/tmp/response-copy-blocked.png', fullPage: true });
  assert.deepEqual(deniedErrors, []);
  await deniedContext.close();

  const unavailableContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await unavailableContext.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }));
  const unavailable = await unavailableContext.newPage();
  const unavailableErrors = [];
  unavailable.on('pageerror', error => unavailableErrors.push(error.message));
  await unavailable.goto(url);
  const unavailableButton = unavailable.locator('[data-design="3"] .response-copy[data-source="short"]');
  await unavailableButton.focus();
  await unavailable.keyboard.press('Enter');
  assert.equal(await unavailableButton.getAttribute('data-state'), 'failed');
  assert.equal(await unavailable.locator('[data-design="3"] [data-response="short"] .manual textarea').inputValue(), short);
  assert.deepEqual(unavailableErrors, []);
  await unavailableContext.close();

  console.log('PASS: five selectors, ten exact response copies, keyboard, raw Markdown, code distinction, denied/unavailable fallback, 320/390px, feedback, no browser errors');
  console.log('Screenshots: /tmp/response-copy-desktop.png /tmp/response-copy-mobile-390.png /tmp/response-copy-mobile-320.png /tmp/response-copy-blocked.png');
} finally {
  await browser.close();
}
