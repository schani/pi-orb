import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

const url = process.env.STUDY_URL || pathToFileURL(new URL('./token-usage.html', import.meta.url).pathname).href;
const executablePath = process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
const externalRequests = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => {
  if (/^https?:/.test(request.url()) && !request.url().startsWith(new URL(url).origin + '/')) externalRequests.push(request.url());
});
const sum = rows => rows.reduce((a, r) => {
  for (const field of ['input', 'output', 'cache_read', 'cache_write']) a[field] += r[field];
  a.calls++;
  return a;
}, { input: 0, output: 0, cache_read: 0, cache_write: 0, calls: 0 });
const contained = async label => assert.ok(
  await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  `${label}: page overflow`,
);
async function metrics() {
  const rows = await page.evaluate(() => window.__usageStudy.currentRows());
  const expected = sum(rows);
  const totals = await page.locator('[data-view]:visible [data-total]').evaluateAll(nodes =>
    nodes.map(node => ({ field: node.dataset.total, value: Number(node.dataset.value) })));
  assert.ok(totals.length >= 1, 'visible view exposes a derived metric');
  for (const { field, value } of totals) {
    if (field === 'cache_share') {
      const prompt = expected.input + expected.cache_read + expected.cache_write;
      assert.ok(Math.abs(value - (prompt ? expected.cache_read / prompt : 0)) < 1e-10, 'cache share is ratio of sums');
    } else {
      assert.equal(value, expected[field], `displayed ${field}`);
    }
  }
  return expected;
}
async function select(proposal) {
  await page.locator(`[data-proposal="${proposal}"]`).click();
  assert.ok(await page.locator('[data-dashboard]').isVisible(), 'starts on dashboard');
  assert.equal(await page.locator('[data-view]:visible').count(), 0, 'no pre-opened usage panel');
}
async function open(proposal) {
  const access = page.locator(`[data-access="${proposal}"]`).first();
  await access.focus();
  await page.keyboard.press('Enter');
  assert.ok(await page.locator(`[data-view="${proposal}"]`).isVisible(), 'keyboard opens access point');
  return access;
}
try {
  await page.goto(url);
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.evaluate(() => document.fonts.check('13px "Iosevka Etoile"')), true);
  assert.equal(await page.evaluate(() => [...document.fonts].some(f => f.family.includes('Iosevka Etoile') && f.status === 'loaded')), true);
  assert.equal(await page.locator('[data-proposal]').count(), 5);
  assert.match(await page.locator('[data-study]').innerText(), /sample data/i);
  const ledger = await page.evaluate(() => window.__usageStudy.ledger);
  assert.ok(ledger.length > 30);
  assert.deepEqual([...new Set(ledger.map(r => r.use))].sort(),
    ['compaction', 'headline', 'orb_name', 'root', 'subagent', 'turn_summary']);
  assert.ok(ledger.some(r => r.outcome === 'error'));
  assert.ok(ledger.some(r => r.duration_ms === null));
  const orbs = await page.evaluate(() => window.__usageStudy.orbs);
  assert.ok(ledger.some(r => !orbs[r.orb_id]), 'deleted orb retained');
  assert.ok(ledger.every(r => !('cost' in r) && !('project_id' in r) && !('parent_id' in r)), 'only recorded call fields');
  const all = sum(ledger);
  const apiTotals = await page.evaluate(() => window.__usageStudy.aggregate(window.__usageStudy.ledger));
  for (const field of Object.keys(all)) assert.equal(apiTotals[field], all[field], `aggregate ${field}`);
  assert.equal(apiTotals.cache_share, all.cache_read / (all.input + all.cache_read + all.cache_write));
  const sevenDayTotals = [];
  for (let proposal = 1; proposal <= 5; proposal++) {
    await select(proposal);
    const access = await open(proposal);
    const range = page.locator('[data-view]:visible [data-range]');
    await range.selectOption('7d');
    const baseline = await metrics();
    sevenDayTotals.push(baseline);
    await range.selectOption('today');
    const today = await metrics();
    assert.ok(today.calls > 0 && today.calls < baseline.calls, 'date filter changes data');
    const filteredRows = await page.evaluate(() => window.__usageStudy.currentRows());
    assert.ok(filteredRows.every(r => r.at.startsWith('2026-10-12')), 'today uses recording day in study timezone');
    await range.selectOption('7d');
    const model = page.locator('[data-view]:visible [data-model]');
    if (await model.count()) {
      await model.selectOption('gpt-6-astra');
      const filtered = await metrics();
      assert.ok(filtered.calls > 0 && filtered.calls < baseline.calls, 'model filter changes data');
      assert.ok((await page.evaluate(() => window.__usageStudy.currentRows())).every(r => r.model === 'gpt-6-astra'));
      await model.selectOption('all');
    }
    const use = page.locator('[data-view]:visible [data-use]');
    if (await use.count()) {
      await use.selectOption('subagent');
      assert.ok((await metrics()).calls < baseline.calls);
      assert.ok((await page.evaluate(() => window.__usageStudy.currentRows())).every(r => r.use === 'subagent'));
      await use.selectOption('all');
    }
    await page.locator('[data-coverage]:visible').click();
    assert.ok(await page.locator('[data-coverage-details]').isVisible());
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('[data-coverage-details]:visible').count(), 0);
    assert.ok(await page.locator('[data-view]:visible').isVisible(), 'Escape closes details first');
    if (proposal === 3) {
      const rows = await page.evaluate(() => window.__usageStudy.currentRows());
      assert.ok(rows.every(r => orbs[r.orb_id]?.project_id === 'pi-orb'), 'project join excludes deleted orbs');
      await page.locator('[data-orb-drilldown]').first().click();
      assert.ok(await page.locator('[data-orb-details]:visible').count());
    }
    if (proposal === 4) {
      assert.equal(await page.locator('[data-matrix] tbody tr').count(), 6);
      const cells = await page.locator('[data-matrix] [data-cell-input]').evaluateAll(nodes => nodes.map(n => Number(n.dataset.cellInput)));
      assert.equal(cells.reduce((a, b) => a + b, 0), baseline.input);
    }
    if (proposal === 5) {
      await page.locator('[data-outcome]').selectOption('error');
      const failed = await metrics();
      assert.ok(failed.calls > 0 && failed.calls < baseline.calls);
      assert.ok((await page.evaluate(() => window.__usageStudy.currentRows())).every(r => r.outcome === 'error'));
      await page.locator('[data-outcome]').selectOption('all');
      const times = await page.locator('[data-call-at]').evaluateAll(nodes => nodes.map(n => n.dataset.callAt));
      assert.deepEqual(times, [...times].sort().reverse(), 'ledger newest first');
      await page.locator('[data-row-detail]').first().click();
      assert.ok(await page.locator('[data-call-details]:visible').count());
    }
    await range.selectOption('empty');
    assert.equal((await metrics()).calls, 0);
    assert.ok(await page.locator('[data-empty]:visible').count());
    await range.selectOption('7d');
    await page.locator('[data-query]:visible').selectOption('error');
    assert.ok(await page.locator('[data-error]:visible').count());
    assert.equal(await page.locator('[data-view]:visible [data-total]').count(), 0, 'no stale metrics shown as valid');
    await page.locator('[data-retry]:visible').click();
    assert.deepEqual(await metrics(), baseline);
    await page.locator('[data-view]:visible [data-dismiss]').first().click();
    assert.equal(await page.locator('[data-view]:visible').count(), 0, 'back/close returns to dashboard');
    assert.ok(await access.evaluate(el => el === document.activeElement), 'focus returns to access point');
    await open(proposal);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('[data-view]:visible').count(), 0, 'Escape returns to dashboard');
  }
  for (const proposal of [1, 2, 4, 5]) assert.deepEqual(sevenDayTotals[proposal - 1], all, 'global views agree');

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    for (let proposal = 1; proposal <= 5; proposal++) {
      await select(proposal);
      await contained(`dashboard ${proposal}/${width}`);
      await open(proposal);
      await contained(`view ${proposal}/${width}`);
      if (width < 500) {
        const controls = await page.locator('button:visible, select:visible, input:visible, summary:visible').evaluateAll(nodes =>
          nodes.map(n => ({ tag: n.tagName, h: n.getBoundingClientRect().height, font: parseFloat(getComputedStyle(n).fontSize) })));
        assert.ok(controls.every(c => c.h >= 44), `44px controls ${proposal}/${width}: ${JSON.stringify(controls.filter(c => c.h < 44))}`);
        assert.ok(controls.filter(c => ['INPUT', 'SELECT'].includes(c.tag)).every(c => c.font >= 16), '16px phone inputs');
      }
      await page.screenshot({ path: `/tmp/token-usage-${proposal}-${width}.png`, fullPage: true });
    }
  }
  assert.deepEqual(externalRequests, [], 'no external dependencies');
  assert.deepEqual(errors, [], 'no JavaScript errors');
  console.log('PASS: five dashboard access points; keyboard, close/back/Escape; date/model/use/outcome filters; empty/error/retry; project joins; weighted cache share; matrix and ledger totals; details; embedded font; 1440/390/320 containment and phone controls.');
  console.log('Screenshots: /tmp/token-usage-{1..5}-{1440,390,320}.png');
} catch (error) {
  await page.screenshot({ path: '/tmp/token-usage-first-failure.png', fullPage: true }).catch(() => {});
  await import('node:fs/promises').then(fs => fs.writeFile('/tmp/token-usage-first-failure.txt', String(error.stack) + '\n' + JSON.stringify({ errors, externalRequests })));
  throw error;
} finally {
  await browser.close();
}
