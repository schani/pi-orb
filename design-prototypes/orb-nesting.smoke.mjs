import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  args: ['--no-sandbox'],
});
const errors = [];
const requests = [];
let page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push(request.url()));
  await page.goto(pathToFileURL(fileURLToPath(new URL('./orb-nesting.html', import.meta.url))).href);
  await page.evaluate(() => document.fonts.ready);
  assert.ok(await page.evaluate(() => document.fonts.check('13px "Iosevka Etoile"')));
  const typography = locator => locator.evaluate(element => {
    const style = getComputedStyle(element);
    return [style.fontFamily, style.fontSize, style.lineHeight];
  });
  assert.deepEqual(await typography(page.locator('body')), ['"Iosevka Etoile", monospace', '13px', '20px']);
  assert.deepEqual(await typography(page.locator('.orb-entry-link').first()), ['"Iosevka Etoile", monospace', '14px', '22px']);
  assert.equal(await page.locator('.dashboard .project-column').first().evaluate(element => element.getBoundingClientRect().width), 316);
  assert.equal(await page.locator('.dashboard-totals').evaluate(element => element.getBoundingClientRect().height), 24);
  assert.equal(await page.locator('.orb-entry-title').first().evaluate(element => element.getBoundingClientRect().height), 22);
  const working = page.locator('.working');
  const row = id => working.locator(`[data-select="${id}"]`);
  const node = id => working.locator(`[data-node="${id}"]`);
  const descendants = ['identity', 'identity-audit', 'diagnose', 'ipv6', 'apt-retry', 'audience'];
  async function reset() { await page.locator('#reset').click(); }
  async function assertTree() {
    assert.equal(await page.locator('[data-proposal], .options, .rationale, #proposal-number').count(), 0, 'single treatment without alternatives framing');
    assert.equal(await working.locator('button, summary, details, [aria-expanded], [data-toggle], .count').count(), 0, 'no tree disclosure or family counts');
    for (const id of descendants) assert.ok(await row(id).isVisible(), `always visible: ${id}`);
    assert.equal(await node('identity').locator('[data-node="identity-audit"]').count(), 1);
    assert.equal(await node('ipv6').locator('[data-node="apt-retry"]').count(), 1);
  }
  for (const view of ['dashboard', 'orb']) {
    await page.locator(`button[data-view="${view}"]`).click();
    await reset();
    assert.equal(await page.locator('#mock').getAttribute('data-view'), view);
    await assertTree();
    if (view === 'orb') {
      assert.equal(await page.locator('.index').evaluate(element => element.getBoundingClientRect().width), 236);
      assert.equal(await page.locator('.ix-row').first().evaluate(element => element.getBoundingClientRect().height), 20);
      assert.deepEqual(await typography(page.locator('.ix-row').first()), ['"Iosevka Etoile", monospace', '13px', '20px']);
    } else {
      await working.locator('[data-row="apt"] .orb-entry-meta').click();
      assert.equal(await row('apt').getAttribute('aria-current'), 'page', 'dashboard whole-row selection');
    }
    await row('identity-audit').click();
    assert.equal(await row('identity-audit').getAttribute('aria-current'), 'page');
    if (view === 'orb') assert.match(await page.locator('.orb-heading').textContent(), /Verify revoked identity/);
    await assertTree();
    await row('diagnose').focus();
    await page.keyboard.press('Enter');
    assert.equal(await row('diagnose').getAttribute('aria-current'), 'page', 'keyboard row selection');
    assert.equal(await row('diagnose').evaluate(element => element === document.activeElement), true);
    await assertTree();

    await row('alert').click();
    await page.locator('#archive').click();
    assert.equal(await node('identity').getAttribute('data-parent'), '');
    assert.equal(await node('diagnose').getAttribute('data-parent'), '');
    assert.equal(await node('identity').locator('[data-node="identity-audit"]').count(), 1);
    assert.ok(await row('identity-audit').isVisible());
    assert.equal(await node('alert').count(), 0);
    assert.ok(await page.locator('.archive [data-select="alert"]').isVisible());
    assert.match(await page.locator('#outcome').textContent(), /2 children promoted/);
    const shelf = page.locator('.archive');
    await shelf.locator('summary').click();
    assert.ok(!(await shelf.locator('[data-select="alert"]').isVisible()), 'archive retains its disclosure');
    await row('identity-audit').click();
    assert.equal(await shelf.getAttribute('open'), null, 'archive stays closed after selection');
    await shelf.locator('summary').click();
    assert.ok(await shelf.locator('[data-select="alert"]').isVisible());

    await row('identity').click();
    await page.locator('#delete').click();
    assert.equal(await node('identity-audit').getAttribute('data-parent'), '');
    assert.ok(await row('identity-audit').isVisible());
    assert.equal(await page.locator('[data-select="identity"]').count(), 0);
    await reset();
    await row('apt').click();
    await page.locator('#delete').click();
    assert.equal(await node('ipv6').getAttribute('data-parent'), '');
    assert.equal(await node('ipv6').locator('[data-node="apt-retry"]').count(), 1);
    assert.ok(await row('apt-retry').isVisible());
    assert.equal(await page.locator('[data-select="apt"]').count(), 0);
    await reset();
    await row('identity').click();
    await page.locator('#archive').click();
    assert.equal(await node('identity-audit').getAttribute('data-parent'), '');
    assert.ok(await row('identity-audit').isVisible());
    assert.equal(await node('diagnose').getAttribute('data-parent'), 'alert');
  }
  await reset();
  await row('identity-audit').click();
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const view of ['dashboard', 'orb']) {
      await page.locator(`button[data-view="${view}"]`).click();
      if (width <= 600 && view === 'orb') {
        assert.ok(!(await page.locator('.index').isVisible()), 'production phone view hides the index');
        assert.match(await page.locator('.orb-heading').textContent(), /Verify revoked identity/);
      } else {
        await assertTree();
        assert.equal(await row('identity-audit').getAttribute('aria-current'), 'page', 'selection survives view changes');
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow: ${width}/${view}`);
      await page.screenshot({ path: `/tmp/orb-nesting-${width}-${view}.png`, fullPage: true });
    }
  }
  assert.deepEqual(errors, []);
  assert.ok(requests.every(url => url.startsWith('file:') || url.startsWith('data:')), 'no network dependencies');
  console.log('PASS: production typography/dimensions; always-visible tree in both views; selection, archive/delete promotion, grandchild retention, keyboard, archive disclosure; 1440/768/390/320px containment; no network requests or page errors.');
} catch (error) {
  await page?.screenshot({ path: '/tmp/orb-nesting-first-failure.png', fullPage: true });
  throw error;
} finally {
  await browser.close();
}
