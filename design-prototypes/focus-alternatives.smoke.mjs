import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { pathToFileURL } from 'node:url';

const local = pathToFileURL(new URL('./focus-alternatives.html', import.meta.url).pathname).href;
const url = process.env.STUDY_URL || local;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));

try {
  await page.goto(url);
  const slugs = ['ink', 'crop', 'ledger', 'carbon', 'graphite'];
  assert.equal(await page.locator('.candidate').count(), 5);
  assert.equal(await page.locator('.candidate:visible').count(), 5);
  assert.equal(await page.locator('.composer-field').count(), 5);
  assert.equal(await page.locator('input.study-field').count(), 5);
  assert.equal(await page.locator('textarea[data-draft="instructions"]').count(), 5);
  assert.equal(await page.locator('#preview-toggle').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.candidate.is-preview').count(), 5);

  const previewContracts = await page.locator('.candidate').evaluateAll(cards => Object.fromEntries(cards.map(card => {
    const slug = card.dataset.variant;
    const shell = card.querySelector('.composer-shell');
    const style = getComputedStyle(shell);
    return [slug, {
      before: getComputedStyle(shell, '::before').content,
      beforeWidth: getComputedStyle(shell, '::before').width,
      after: getComputedStyle(shell, '::after').content,
      background: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      borderBottom: style.borderBottomWidth,
      shadow: style.boxShadow,
      text: getComputedStyle(card.querySelector('.composer-field')).color,
    }];
  })));
  assert.equal(previewContracts.ink.before, '""');
  assert.equal(previewContracts.ink.beforeWidth, '2px');
  assert.equal(await page.locator('[data-variant="ink"] .composer-shell').evaluate(shell => getComputedStyle(shell, '::before').left), '-5px');
  assert.equal(previewContracts.crop.after, '""');
  assert.notEqual(previewContracts.ledger.backgroundImage, 'none');
  assert.notEqual(previewContracts.ledger.shadow, 'none');
  assert.notEqual(previewContracts.carbon.shadow, 'none');
  assert.equal(previewContracts.graphite.background, 'rgb(237, 237, 237)');
  assert.ok(Object.values(previewContracts).every(contract => contract.text === 'rgb(0, 0, 0)'));
  assert.deepEqual(await page.locator('[data-variant="ink"] .composer-line').evaluate(line => {
    const style = getComputedStyle(line);
    return { columns: style.gridTemplateColumns.split(' ')[0], gap: style.columnGap };
  }), { columns: '32px', gap: '12px' });
  assert.equal(await page.locator('[data-variant="ink"] .composer-field').evaluate(el => el.getBoundingClientRect().height), 80);

  // Focus decoration cannot move or resize any field.
  await page.locator('#preview-toggle').click();
  for (const slug of slugs) {
    for (const kind of ['composer', 'name', 'instructions']) {
      const field = page.locator(`[data-variant="${slug}"] [data-draft="${kind}"]`);
      const boxes = await field.evaluate(el => {
        el.blur();
        const shell = el.parentElement;
        const rect = () => {
          const box = shell.getBoundingClientRect();
          return { x: box.x, y: box.y, width: box.width, height: box.height };
        };
        const before = rect();
        el.focus({ preventScroll: true });
        return { before, after: rect() };
      });
      assert.deepEqual(boxes.after, boxes.before, `${slug}/${kind} focus changed geometry`);
    }
  }
  await page.locator('#preview-toggle').click();

  // Keyboard traversal replaces the simultaneous study preview with one true focus.
  await page.locator('[data-select="graphite"]').focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-draft')), 'composer');
  assert.equal(await page.locator('#preview-toggle').getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator('.candidate.is-preview').count(), 0);
  const actual = page.locator('[data-variant="ink"] .composer-field');
  await actual.type(' Typed.');
  assert.equal(await actual.evaluate(el => getComputedStyle(el).color), 'rgb(0, 0, 0)');
  assert.notEqual(await actual.evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(0, 0, 0)');
  await actual.blur();
  assert.equal(await page.locator('#preview-toggle').getAttribute('aria-pressed'), 'false');
  await page.locator('#preview-toggle').click();
  assert.equal(await page.locator('#preview-toggle').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.candidate.is-preview').count(), 5);

  // Every option expands through the selector, deep-links, and retains local drafts.
  const draft = page.locator('[data-variant="carbon"] [data-draft="instructions"]');
  await draft.fill('Retained carbon instructions.');
  for (const slug of slugs) {
    await page.locator(`[data-select="${slug}"]`).click();
    assert.equal(await page.locator('.candidate:visible').count(), 1);
    const visibleCard = page.locator(`.candidate[data-variant="${slug}"]`);
    assert.equal(await visibleCard.isVisible(), true);
    assert.ok((await visibleCard.boundingBox()).width > 1000, `${slug} does not fill the desktop gallery`);
    assert.equal(await page.locator(`[data-select="${slug}"]`).getAttribute('aria-pressed'), 'true');
    assert.match(page.url(), new RegExp(`variant=${slug}`));
  }
  await page.locator('[data-select="all"]').click();
  assert.equal(await page.locator('.candidate:visible').count(), 5);
  assert.equal(await draft.inputValue(), 'Retained carbon instructions.');
  assert.equal(new URL(page.url()).searchParams.has('variant'), false);

  const deepLink = await browser.newPage({ viewport: { width: 760, height: 900 } });
  const deepErrors = [];
  deepLink.on('pageerror', error => deepErrors.push(error.message));
  await deepLink.goto(`${url}?variant=ledger`);
  assert.equal(await deepLink.locator('.candidate:visible').count(), 1);
  assert.equal(await deepLink.locator('[data-variant="ledger"]').isVisible(), true);
  assert.equal(await deepLink.locator('[data-select="ledger"]').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(deepErrors, []);
  await deepLink.close();

  // Enter in a single-line field and forms cannot submit or navigate.
  await page.locator('[data-select="ink"]').click();
  const name = page.locator('[data-variant="ink"] input');
  await name.fill('local name');
  await page.evaluate(() => { window.__studyAlive = true; });
  await name.press('Enter');
  assert.equal(await page.evaluate(() => window.__studyAlive), true);
  assert.equal(await name.inputValue(), 'local name');

  for (const width of [320, 390, 760, 1440]) {
    await page.setViewportSize({ width, height: width < 760 ? 780 : 1000 });
    for (const slug of ['all', ...slugs]) {
      await page.locator(`[data-select="${slug}"]`).click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${slug} overflows at ${width}px`);
    }
    if (width <= 760) {
      const targets = await page.locator('#preview-toggle, .variant-nav button').evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().height));
      assert.ok(targets.every(height => height >= 44), `undersized mobile control at ${width}px`);
      assert.equal(await page.locator('.composer-field:visible').first().evaluate(el => el.getBoundingClientRect().height), 88);
    }
    await page.locator('[data-select="all"]').click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `all overflows at ${width}px`);
  }

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  assert.equal(await page.locator('#preview-toggle').getAttribute('aria-pressed'), 'true');
  await page.screenshot({ path: '/tmp/focus-alternatives-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/focus-alternatives-mobile-390.png', fullPage: true });
  await page.setViewportSize({ width: 320, height: 740 });
  await page.screenshot({ path: '/tmp/focus-alternatives-mobile-320.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: five variants, baseline geometry, non-layout focus, preview, real focus/blur and Tab, drafts, deep links, 44px mobile controls, 320/390/760/1440 containment, no page errors');
  console.log('Screenshots: /tmp/focus-alternatives-desktop.png /tmp/focus-alternatives-mobile-390.png /tmp/focus-alternatives-mobile-320.png');
} finally {
  await browser.close();
}
