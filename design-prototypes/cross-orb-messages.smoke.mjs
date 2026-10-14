import assert from 'node:assert/strict';
import { access, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const html = `${process.cwd()}/design-prototypes/cross-orb-messages.html`;
const url = process.env.STUDY_URL || pathToFileURL(html).href;
const shots = '/tmp/cross-orb-messages';
const senderPath = '/orbs/629e53de-a2c9-4f1b-87a6-437fd415e8de';
const short = 'The replacement socket accepts its snapshot before draining the queue. I reproduced the original first-message failure.';
const long = 'The regression passes with a deterministic gate between snapshot acceptance and queue drain. The stale_head rejection is unchanged.\n\nPlease keep these assertions:\n1. The first queued message is sent exactly once after reconnect.\n2. A message carrying the old head is still rejected.\n3. Closing the old socket cannot clear the replacement owner.\n\nThe fixture contains literal input, not markup:\n<script>globalThis.__peerInjected = true</script>\n<img src=x onerror="globalThis.__peerInjected = true"> & "quotes"\nhttps://example.test/reconnect/' + 'snapshot-'.repeat(18);
const human = 'Coordinate with the runtime handshake orb on the reconnect fix. Keep the stale-head guard, and wait for its regression results before committing.';
const responses = [
  'I’ll check queue ownership here while the runtime handshake orb exercises snapshot ordering.',
  'That matches the client-side trace. I’ll keep the queued message behind snapshot acceptance.',
  'I’ve checked all three assertions against the client change. I’ll run the browser handshake test before committing; the literal fixture stays plain text.',
];
if (!process.env.STUDY_URL) await access(html);
await mkdir(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('requestfailed', request => errors.push(`request failed: ${request.url()}`));
  await page.goto(url);
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.locator('.candidate').count(), 3);
  assert.equal(await page.locator('.candidate:visible').count(), 3);
  assert.equal(await page.locator('.peer').count(), 6);
  assert.equal(await page.locator('.peer-rail details[open]').count(), 0);
  assert.equal(await page.locator('.peer-rail .peer-body:visible').count(), 0);
  assert.equal(await page.locator('.correspondence .peer-body:visible, .dispatch .peer-body:visible').count(), 4);
  assert.equal(await page.locator('.correspondence details, .dispatch details').count(), 0);
  assert.equal(await page.locator('.peer-rail .activity-rail-headline').allTextContents().then(items => items.join('|')), 'Snapshot ordering reproduced|Regression ready · three invariants');
  for (const design of ['peer-rail', 'correspondence', 'dispatch']) {
    const card = page.locator(`.${design}`);
    assert.equal(await card.locator('.rec-you .rec-bd').textContent(), human);
    assert.deepEqual(await card.locator('.receiving .rec-bd').allTextContents(), responses);
    assert.deepEqual(await card.locator('.peer-body').allTextContents(), [short, long]);
    assert.deepEqual(await card.locator('.sender').allTextContents(), ['runtime handshake', 'runtime handshake']);
    assert.ok(await card.locator('.sender').evaluateAll((links, path) => links.every(link =>
      new URL(link.href).pathname === path && link.target === '_blank' && link.rel.includes('noopener')), senderPath));
    assert.equal(await card.locator('.history').evaluate(el => [...el.children].map(row => row.dataset.speaker).join(',')), 'human,receiver,peer,receiver,peer,receiver');
    assert.equal(await card.locator('.rec-you').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(0, 0, 0)');
    assert.equal(await card.locator('.rec-you').evaluate(el => getComputedStyle(el).color), 'rgb(255, 255, 255)');
    assert.ok(await card.locator('.receiving').evaluateAll(elements => elements.every(el => getComputedStyle(el).backgroundColor === 'rgb(255, 255, 255)')));
    assert.ok(await card.locator('.orb-header, .composer-input, .peer-body').evaluateAll(elements =>
      elements.every(el => getComputedStyle(el).fontFamily.includes('Iosevka Etoile') && getComputedStyle(el).fontSize === '13px')));
    assert.equal(await card.locator('.composer-input').getAttribute('placeholder'), 'Message the orb…');
  }
  assert.ok(await page.evaluate(() => document.fonts.check('13px "Iosevka Etoile"') && document.fonts.check('700 13px "Iosevka Etoile"') && [...document.fonts].every(face => face.status === 'loaded')));
  assert.ok(await page.locator('.correspondence .peer').evaluateAll(elements => elements.every(el => getComputedStyle(el).backgroundColor === 'rgb(242, 242, 242)')));
  assert.ok(await page.locator('.dispatch .peer').evaluateAll(elements => elements.every(el => {
    const css = getComputedStyle(el);
    return css.backgroundColor === 'rgb(255, 255, 255)' && css.borderTopColor === 'rgb(0, 0, 0)' && css.borderTopStyle === 'solid' && css.borderTopWidth === '1px';
  })));
  assert.ok(await page.locator('.candidate').evaluateAll(elements => new Set(elements.map(el => Math.round(el.getBoundingClientRect().top))).size === 1));
  await page.screenshot({ path: `${shots}/desktop.png`, fullPage: true });

  // Route the specimen link locally; never depend on a real orb or its server.
  await page.context().route(`**${senderPath}`, route => route.fulfill({ contentType: 'text/html', body: '<title>Sender orb fixture</title>' }));
  for (const design of ['peer-rail', 'correspondence', 'dispatch']) {
    const popupReady = page.waitForEvent('popup');
    await page.locator(`.${design} .sender`).first().click();
    const popup = await popupReady;
    await popup.waitForLoadState();
    assert.equal(new URL(popup.url()).pathname, senderPath);
    await popup.close();
  }
  assert.equal(await page.locator('.peer-rail details[open]').count(), 0, 'sender navigation must not toggle disclosure');

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await page.locator('[data-focus="all"]').click();
    assert.equal(await page.locator('.candidate:visible').count(), 3);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `page overflow at ${width}`);
    for (const summary of await page.locator('.peer-rail summary').all()) {
      await summary.focus();
      await page.keyboard.press('Enter');
    }
    assert.equal(await page.locator('.peer-rail details[open]').count(), 2);
    assert.equal(await page.locator('.peer-body:visible').count(), 6);
    assert.equal(await page.locator('.peer img, .peer script, .peer-body a').count(), 0);
    assert.equal(await page.evaluate(() => globalThis.__peerInjected), undefined);
    assert.ok(await page.locator('.peer-body').evaluateAll(elements => elements.every(el => {
      const rect = el.getBoundingClientRect();
      return el.scrollWidth <= el.clientWidth && rect.left >= 0 && rect.right <= innerWidth;
    })), `message clipping at ${width}`);
    assert.ok(await page.locator('.specimen').evaluateAll(elements => elements.every(el => el.scrollWidth <= el.clientWidth)), `frame overflow at ${width}`);
    assert.ok(await page.locator('.peer-body').evaluateAll(elements => elements.every(el => getComputedStyle(el).whiteSpace === 'pre-wrap')));
    if (width < 700) {
      assert.ok(await page.locator('.peer-rail summary, .study button').evaluateAll(elements => elements.every(el => el.getBoundingClientRect().height >= 44)));
    }
    await page.screenshot({ path: `${shots}/${width}-expanded.png`, fullPage: true });
    for (const summary of await page.locator('.peer-rail summary').all()) {
      await summary.focus();
      await page.keyboard.press('Space');
    }
    assert.equal(await page.locator('.peer-rail details[open]').count(), 0);
    await page.screenshot({ path: `${shots}/${width}-collapsed.png`, fullPage: true });

    for (const design of ['peer-rail', 'correspondence', 'dispatch']) {
      await page.locator(`[data-focus="${design}"]`).click();
      assert.equal(await page.locator('.candidate:visible').count(), 1);
      assert.ok(await page.locator(`.${design}`).isVisible());
      assert.equal(await page.locator(`[data-focus="${design}"]`).getAttribute('aria-pressed'), 'true');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const editor = page.locator(`.${design} .composer-input`);
      await editor.fill('<img src=x onerror=alert(1)> & unsent draft');
      assert.equal(await editor.inputValue(), '<img src=x onerror=alert(1)> & unsent draft');
      await editor.fill('');
      if (width === 1440) await page.screenshot({ path: `${shots}/desktop-${design}.png`, fullPage: true });
    }
  }
  await page.reload();
  assert.equal(await page.locator('.candidate:visible').count(), 3);
  assert.equal(await page.locator('.peer-rail details[open]').count(), 0);
  assert.ok(await page.locator('.composer-input').evaluateAll(editors => editors.every(el => el.value === '')));
  assert.deepEqual(errors, []);
  console.log('PASS: three alternatives; identical conversation; linked sender navigation; collapsed rail; keyboard disclosure; literal hostile text; embedded fonts; desktop/390/320px; no overflow or browser errors.');
  console.log(`Screenshots: ${shots}/`);
} finally {
  await browser.close();
}
