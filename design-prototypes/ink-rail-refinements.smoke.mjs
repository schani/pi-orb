import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { pathToFileURL } from 'node:url';

const local = pathToFileURL(new URL('./ink-rail-refinements.html', import.meta.url).pathname).href;
const url = process.env.STUDY_URL || local;
const slugs = ['detached', 'short', 'heavy', 'open', 'bracket'];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));

try {
  await page.goto(url);
  assert.equal(await page.locator('.candidate').count(), 5);
  assert.equal(await page.locator('.candidate:visible').count(), 5);
  assert.equal(await page.locator('input[data-draft=name]').count(), 5);
  assert.equal(await page.locator('textarea[data-draft=instructions]').count(), 5);
  assert.equal(await page.locator('textarea[data-draft=composer]').count(), 5);
  assert.equal(await page.locator('#preview-toggle').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.annotation').textContent(), 'Rails sit outside the field boundary.');
  assert.match(await page.locator('.footer-note').textContent(), /production is unchanged/);
  assert.equal(await page.locator('[placeholder]').count(), 0);

  // Explicit preview paints only the five name rows; the toggle supplies a blurred comparison.
  assert.equal(await page.locator('.name-row .focus-frame').evaluateAll(frames => frames.filter(frame => getComputedStyle(frame, '::before').content === '""').length), 5);
  assert.equal(await page.locator('.instructions .focus-frame, .composer .focus-frame').evaluateAll(frames => frames.filter(frame => getComputedStyle(frame, '::before').content === '""').length), 0);
  await page.locator('#preview-toggle').click();
  assert.equal(await page.locator('.focus-frame').evaluateAll(frames => frames.filter(frame => getComputedStyle(frame, '::before').content === '""').length), 0);
  assert.equal(await page.locator('#preview-toggle').getAttribute('aria-pressed'), 'false');

  // Every real focus mark ends before the field's outer left edge, including bracket ticks.
  for (const slug of slugs) {
    for (const kind of ['name', 'instructions', 'composer']) {
      const field = page.locator(`[data-variant="${slug}"] [data-draft="${kind}"]`);
      const result = await field.evaluate(el => {
        const frame = el.parentElement;
        const box = () => {
          const rect = el.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        };
        const blurred = box();
        const blurBefore = getComputedStyle(frame, '::before').content;
        el.focus({ preventScroll: true });
        const focused = box();
        const frameRect = frame.getBoundingClientRect();
        const pseudo = name => {
          const style = getComputedStyle(frame, name);
          if (style.content !== '""') return null;
          return frameRect.left + parseFloat(style.left) + parseFloat(style.width);
        };
        return {
          blurred,
          focused,
          inputLeft: focused.x,
          beforeRight: pseudo('::before'),
          afterRight: pseudo('::after'),
          colors: { color: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor },
          blurBefore,
        };
      });
      assert.deepEqual(result.focused, result.blurred, `${slug}/${kind} focus changed field bounds`);
      assert.equal(result.blurBefore, 'none', `${slug}/${kind} rail remained while blurred`);
      assert.ok(result.beforeRight < result.inputLeft, `${slug}/${kind} rail overlaps field`);
      if (result.afterRight !== null) assert.ok(result.afterRight < result.inputLeft, `${slug}/${kind} ticks overlap field`);
      assert.deepEqual(result.colors, { color: 'rgb(0, 0, 0)', background: 'rgb(255, 255, 255)' }, `${slug}/${kind} is not black on white`);
      await field.blur();
      assert.equal(await field.evaluate(el => getComputedStyle(el.parentElement, '::before').content), 'none', `${slug}/${kind} rail survived blur`);
    }
  }

  const bracket = page.locator('[data-variant=bracket] [data-draft=name]');
  await bracket.focus();
  assert.equal(await bracket.evaluate(el => getComputedStyle(el.parentElement, '::after').content), '""');
  await bracket.blur();
  assert.equal(await bracket.evaluate(el => getComputedStyle(el.parentElement, '::after').content), 'none');

  // Visible labels use explicit associations and align above the field border, after the rail gutter.
  for (const slug of slugs) {
    assert.equal(await page.locator(`label[for="${slug}-name"]`).count(), 1);
    assert.equal(await page.locator(`label[for="${slug}-instructions"]`).count(), 1);
    for (const kind of ['name', 'instructions']) {
      const alignment = await page.locator(`[data-variant="${slug}"] [data-draft="${kind}"]`).evaluate(el => {
        const label = document.querySelector(`label[for="${el.id}"]`);
        const labelStyle = getComputedStyle(label);
        return {
          fieldX: el.getBoundingClientRect().x,
          labelX: label.getBoundingClientRect().x,
          labelColor: labelStyle.color,
          labelWeight: labelStyle.fontWeight,
        };
      });
      assert.equal(alignment.labelX, alignment.fieldX, `${slug}/${kind} label is not aligned to its field`);
      assert.equal(alignment.labelColor, 'rgb(85, 85, 85)');
      assert.equal(alignment.labelWeight, '400');
    }
    assert.equal(await page.locator(`#${slug}-name`).evaluate(el => getComputedStyle(el).fontWeight), '400');
    assert.equal(await page.locator(`#${slug}-name`).getAttribute('placeholder'), null);
    assert.match(await page.locator(`[data-variant="${slug}"] [data-draft=composer]`).getAttribute('aria-label'), /message$/);
  }
  assert.equal(await page.locator('[data-variant=detached] [data-draft=instructions]').evaluate(el => el.getBoundingClientRect().height), 80);
  assert.equal(await page.locator('[data-variant=detached] [data-draft=composer]').evaluate(el => el.getBoundingClientRect().height), 80);
  assert.ok(await page.locator('.name-hero, .instructions').evaluateAll(elements => elements.every(el => getComputedStyle(el).backgroundColor === 'rgb(255, 255, 255)')));

  // Tab enters a true field focus and turns off a restored synthetic preview.
  await page.locator('#preview-toggle').click();
  await page.locator('[data-select=bracket]').focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-draft')), 'name');
  assert.equal(await page.locator('#preview-toggle').getAttribute('aria-pressed'), 'false');
  assert.equal(await page.evaluate(() => document.activeElement?.parentElement && getComputedStyle(document.activeElement.parentElement, '::before').content), '""');

  // Selector, full-width single view, query state, and drafts all remain local.
  const draft = page.locator('[data-variant=heavy] [data-draft=instructions]');
  await draft.fill('Retained local instructions.');
  for (const slug of slugs) {
    await page.locator(`[data-select="${slug}"]`).click();
    assert.equal(await page.locator('.candidate:visible').count(), 1);
    assert.ok((await page.locator(`[data-variant="${slug}"]`).boundingBox()).width > 1000, `${slug} is not full-width`);
    assert.equal(new URL(page.url()).searchParams.get('variant'), slug);
  }
  await page.locator('[data-select=all]').click();
  assert.equal(await page.locator('.candidate:visible').count(), 5);
  assert.equal(await draft.inputValue(), 'Retained local instructions.');
  assert.equal(new URL(page.url()).searchParams.has('variant'), false);

  const deep = await browser.newPage({ viewport: { width: 760, height: 900 } });
  const deepErrors = [];
  deep.on('pageerror', error => deepErrors.push(error.message));
  await deep.goto(`${url}?variant=open`);
  assert.equal(await deep.locator('.candidate:visible').count(), 1);
  assert.equal(await deep.locator('[data-variant=open]').isVisible(), true);
  assert.equal(await deep.locator('[data-select=open]').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(deepErrors, []);
  await deep.close();

  for (const width of [320, 390, 760, 1440]) {
    await page.setViewportSize({ width, height: width < 760 ? 780 : 1000 });
    for (const slug of ['all', ...slugs]) {
      await page.locator(`[data-select="${slug}"]`).click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${slug} overflows at ${width}px`);
    }
    if (width <= 760) {
      const targets = await page.locator('#preview-toggle, .variant-nav button').evaluateAll(elements => elements.map(el => el.getBoundingClientRect().height));
      assert.ok(targets.every(height => height >= 44), `undersized mobile target at ${width}px`);
      assert.ok(await page.locator('.study-field:visible').evaluateAll(fields => fields.every(el => getComputedStyle(el).fontSize === '16px')), `field text is not 16px at ${width}px`);
      assert.ok(await page.locator('textarea.study-field:visible').evaluateAll(fields => fields.every(el => el.getBoundingClientRect().height === 88)), `textarea is not 88px at ${width}px`);
      assert.equal(await page.locator('.composer-line:visible').first().evaluate(el => getComputedStyle(el).columnGap), '12px');
      assert.ok(await page.locator('.field-line:visible').evaluateAll(lines => lines.every(line => {
        const label = line.querySelector('label');
        const field = line.querySelector('.study-field');
        return label.getBoundingClientRect().x === field.getBoundingClientRect().x;
      })), `labels are not field-aligned at ${width}px`);
    }
  }

  // Reload discards drafts and leaves a clean, initially focused-name comparison for screenshots.
  await page.locator('[data-select=all]').click();
  await page.reload();
  assert.equal(await page.locator('[data-variant=heavy] [data-draft=instructions]').inputValue(), 'White field. Focus mark stays outside.');
  assert.equal(await page.locator('#preview-toggle').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.candidate:visible').count(), 5);
  const capture = async (width, height, path) => {
    await page.setViewportSize({ width, height });
    for (const card of await page.locator('.candidate:visible').all()) {
      await card.scrollIntoViewIfNeeded();
      await page.waitForTimeout(20);
    }
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path, fullPage: true });
  };
  await capture(1440, 1000, '/tmp/ink-rail-refinements-desktop.png');
  await capture(390, 844, '/tmp/ink-rail-refinements-mobile-390.png');
  await capture(320, 740, '/tmp/ink-rail-refinements-mobile-320.png');
  assert.deepEqual(errors, []);
  console.log('PASS: five external rails, painted bounds, stable geometry, blur, contrast, labels, keyboard focus, drafts, queries, 44px targets, and 320/390/760/1440 containment');
  console.log('Screenshots: /tmp/ink-rail-refinements-desktop.png /tmp/ink-rail-refinements-mobile-390.png /tmp/ink-rail-refinements-mobile-320.png');
} finally {
  await browser.close();
}
