import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { statSync, readFileSync } from 'node:fs';

assert.ok(statSync(new URL('./programming-fonts.html', import.meta.url)).size < 8 * 1024 * 1024, 'HTML exceeds 8 MiB');

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  const remote = [];
  page.on('pageerror', error => errors.push(error.message));
  let invalidFontDecode = false;
  const decoderDiagnostics = [];
  page.on('console', message => {
    if (message.type() !== 'error' && message.type() !== 'warning') return;
    if (invalidFontDecode && /^(Failed to decode downloaded font:|OTS parsing error:)/.test(message.text())) decoderDiagnostics.push(message.text());
    else if (message.type() === 'error') errors.push(message.text());
  });
  await page.addInitScript(() => {
    const NativeFontFace = window.FontFace;
    window.FontFace = class extends NativeFontFace {
      constructor(family, source, descriptors) {
        super(family, source, descriptors);
        this.blockBerkeleyLocal = typeof source === 'string' && /local\(["']Berkeley/.test(source);
      }
      load() { return this.blockBerkeleyLocal ? Promise.reject(new DOMException('Local Berkeley disabled for smoke', 'NetworkError')) : super.load(); }
    };
  });
  page.on('request', request => { if (!['data:', 'file:', 'http://127.0.0.1:'].some(prefix => request.url().startsWith(prefix))) remote.push(request.url()); });
  const url = process.env.STUDY_URL || new URL('./programming-fonts.html', import.meta.url).href;
  await page.goto(url);
  await page.evaluate(() => window.fontsReady);
  const fonts = await page.evaluate(() => window.FONT_MANIFEST.fonts);
  const manifest = await page.evaluate(() => window.FONT_MANIFEST);
  assert.equal(manifest.reputationDate, '2026-10-04');
  assert.equal(manifest.reputationTimezone, 'America/Los_Angeles');
  assert.equal(manifest.reputationScope, 'Family-level reputation; not separate variant rankings');
  const berkeley = manifest.berkeley;
  const allFonts = [...fonts, berkeley];
  const expectedScores = [5, 5, 4, 4, 4, 4, 4, 4, 4, 3, 4, 4, 4, 4, 4];
  assert.deepEqual(allFonts.map(font => font.reputation.score), expectedScores);
  assert.ok(allFonts.every(font => Number.isInteger(font.reputation.score) && font.reputation.score >= 1 && font.reputation.score <= 5 && font.reputation.rationale && font.reputation.sources.length && font.reputation.family));
  assert.ok(allFonts.every(font => font.reputation.sources.every(source => source.url.startsWith('https://') && source.publisher && source.evidence)));
  assert.equal(await page.locator('#reputation-label').textContent(), 'Reputation · editorial, not a formal ranking');
  assert.ok((await page.locator('.licenses').textContent()).includes('Family-level reputation; not separate variant rankings'));
  assert.ok((await page.locator('.licenses').textContent()).includes('interest, not quality'));
  const assertRating = async (selector, score) => {
    const rating = page.locator(selector);
    assert.equal(await rating.textContent(), '★'.repeat(score) + '☆'.repeat(5 - score));
    assert.equal(await rating.getAttribute('aria-label'), `${score} out of 5; editorial reputation`);
    assert.ok(await rating.isVisible());
  };
  await assertRating('#selected-reputation', 5);
  await assertRating('#code-reputation', 5);
  await assertRating('.berkeley .reputation', 4);
  for (let index = 0; index < fonts.length; index++) {
    await assertRating(`#comparisons .card:nth-child(${index + 1}) .card-head .reputation`, expectedScores[index]);
    const entry = page.locator('#licenses .license-entry').nth(index);
    assert.ok((await entry.textContent()).includes(fonts[index].reputation.rationale));
    for (const source of fonts[index].reputation.sources) assert.ok(await entry.locator(`a[href="${source.url}"]`).count());
  }
  for (const family of ['Iosevka', 'Recursive', 'Monaspace']) {
    const variants = fonts.filter(font => font.reputation.family === family);
    assert.ok(variants.length >= 2);
    assert.ok(variants.every(font => JSON.stringify(font.reputation) === JSON.stringify(variants[0].reputation)));
  }
  const codeIndices = ['0', '1', '2', '3', '8', '9', '10', '11', '12', '13'];
  const codeOptions = [
    'Fira Code', 'JetBrains Mono', 'Cascadia Code', 'Iosevka', 'Victor Mono', 'Lilex',
    'Monaspace Neon', 'Monaspace Argon', 'Monaspace Radon', 'Monaspace Xenon',
  ].map(name => `${name} · Monospace`);
  assert.deepEqual(await page.locator('#code-font option').allTextContents(), codeOptions);
  assert.deepEqual(await page.locator('#code-font option').evaluateAll(nodes => nodes.map(node => node.value)), codeIndices);
  assert.equal(await page.locator('#code-font').inputValue(), '0');
  const codeStyle = () => page.locator('.orb code, .orb .tool-output').evaluateAll(nodes => nodes.map(node => [getComputedStyle(node).fontFamily, getComputedStyle(node).fontFeatureSettings]));
  const initialCode = await codeStyle();
  await page.selectOption('#font', '3');
  assert.deepEqual(await codeStyle(), initialCode, 'UI selection must not change code');
  const initialUI = await page.locator('.orb textarea, .orb .prose').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).fontFamily));
  for (const index of codeIndices) {
    await page.selectOption('#code-font', index);
    assert.ok((await codeStyle()).every(([face]) => face === `StudyFont${index}`));
    await assertRating('#code-reputation', expectedScores[Number(index)]);
    assert.deepEqual(await page.locator('.orb textarea, .orb .prose').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).fontFamily)), initialUI, 'Code selection must not change UI');
    assert.ok(await page.locator('.orb code, .orb .tool-output').evaluateAll(nodes => nodes.every(node => {
      const s = getComputedStyle(node), c = document.createElement('canvas').getContext('2d');
      c.font = `${s.fontSize} ${s.fontFamily}`;
      return Math.abs(c.measureText('iiiiiiii').width - c.measureText('WWWWWWWW').width) < 0.1;
    })), `${fonts[index].name} must be monospace`);
    for (const enabled of [false, true]) {
      await page.locator('#ligatures').setChecked(enabled);
      const font = fonts[index];
      const expected = { ...font.independentFeatures, ...(enabled ? font.ligatureFeatures : font.ligatureFeaturesOff) };
      assert.ok((await codeStyle()).every(([, features]) => {
        const actual = Object.fromEntries(features.split(',').map(feature => {
          const [, tag, value] = feature.trim().match(/^"([^"]+)"(?: (\d+))?$/);
          return [tag, Number(value ?? 1)];
        }));
        return Object.keys(actual).length === Object.keys(expected).length && Object.entries(expected).every(([tag, value]) => actual[tag] === value);
      }), `${font.name} code features ${enabled ? 'ON' : 'OFF'}`);
    }
  }
  for (const specimen of ['1lIi', '0O', '1 l I i |', '0 O o', '2 Z z', '5 S s', '8 B', 'rn m', 'cl d', '{} [] () <>']) {
    assert.ok((await page.locator('#selected .glyph-probe').textContent()).includes(specimen));
    assert.ok((await page.locator('#selected pre code').textContent()).includes(specimen));
    assert.ok((await page.locator('#selected textarea').inputValue()).includes(specimen));
  }
  await page.selectOption('#font', '0');
  await page.selectOption('#code-font', '0');
  assert.ok((await page.locator('#berkeley-status').textContent()).match(/unavailable|local/i));
  const berkeleyOption = page.locator('#font option[value="berkeley"]');
  assert.ok(await berkeleyOption.evaluate(option => option.disabled));
  assert.ok((await page.locator('#berkeley-status').textContent()).includes('unavailable'));
  assert.deepEqual(fonts.map(font => font.name), [
    'Fira Code', 'JetBrains Mono', 'Cascadia Code', 'Iosevka', 'Iosevka Aile', 'Iosevka Etoile',
    'Recursive Sans Linear', 'Recursive Sans Casual', 'Victor Mono', 'Lilex',
    'Monaspace Neon', 'Monaspace Argon', 'Monaspace Radon', 'Monaspace Xenon',
  ]);
  assert.ok(fonts.filter(font => font.name.startsWith('Recursive')).every(font => font.category === 'Proportional' && font.ligatureFeatures.dlig === 1 && font.ligatureFeaturesOff.dlig === 0));
  assert.ok(fonts.filter(font => font.name.startsWith('Monaspace')).every(font => font.ligatureFeatures.liga === 1 && font.ligatureFeaturesOff.liga === 0 && font.independentFeatures.calt === 1 && Array.from({ length: 10 }, (_, i) => `ss${String(i + 1).padStart(2, '0')}`).every(tag => font.ligatureFeatures[tag] === 1 && font.ligatureFeaturesOff[tag] === 0)));
  assert.equal(await page.locator('#comparisons .orb').count(), fonts.length);
  assert.equal(await page.locator('#font option').count(), fonts.length + 1);
  assert.equal(await page.locator('#licenses .license-entry').count(), fonts.length);
  assert.ok(fonts.every(font => font.sourceUrl && font.licenseUrl && font.licenseText.toUpperCase().includes('FONT LICENSE')));
  assert.ok(await page.locator('#comparisons textarea').evaluateAll(nodes => nodes.every(node => node.value === nodes[0].value)));
  assert.ok(await page.locator('#comparisons .prose').evaluateAll(nodes => nodes.every(node => node.innerHTML === nodes[0].innerHTML)));
  // CSS.enable refetches source through a forbidden file-origin request; the demo itself does not.
  const cdp = new URL(url).protocol === 'file:' ? null : await page.context().newCDPSession(page);
  let root;
  if (cdp) {
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    ({ root } = await cdp.send('DOM.getDocument', { depth: -1 }));
  }
  for (let index = 0; index < fonts.length; index++) {
    await page.selectOption('#font', String(index));
    await assertRating('#selected-reputation', expectedScores[index]);
    await page.evaluate(() => document.fonts.ready);
    const style = await page.locator('#selected .orb').evaluate(orb => {
      const prose = getComputedStyle(orb.querySelector('.prose'));
      const prompt = getComputedStyle(orb.querySelector('textarea'));
      return { prose: [prose.fontFamily, prose.fontSize], prompt: [prompt.fontFamily, prompt.fontSize], loaded: document.fonts.check(`13px ${prose.fontFamily}`) };
    });
    assert.deepEqual(style.prompt, style.prose);
    assert.equal(style.prose[1], '13px');
    assert.ok(style.loaded);
    if (cdp) {
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: `#comparisons [data-font-index="${index}"] .glyph-probe` });
      const actual = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
      const expectedName = (fonts[index].embeddedFamilyName || fonts[index].name).toLowerCase().replace(/[^a-z]/g, '');
      assert.ok(actual.fonts.some(font => font.isCustomFont && font.glyphCount > 0 && font.familyName.toLowerCase().replace(/[^a-z]/g, '').includes(expectedName)), `wrong embedded font: ${fonts[index].name}: ${JSON.stringify(actual.fonts)}`);
    }
    const editor = page.locator('#selected textarea');
    const on = await editor.screenshot({ caret: 'hide' });
    await page.locator('#ligatures').uncheck();
    const off = await editor.screenshot({ caret: 'hide' });
    assert.ok(!on.equals(off), `no native textarea shaping change: ${fonts[index].name}`);
    await page.locator('#ligatures').check();
    if (/Monaspace|Fira Code|Recursive/.test(fonts[index].name)) {
      await editor.screenshot({ path: `/tmp/programming-fonts-shaping-${index}-on.png`, caret: 'hide' });
      await page.locator('#ligatures').uncheck();
      await editor.screenshot({ path: `/tmp/programming-fonts-shaping-${index}-off.png`, caret: 'hide' });
      await page.locator('#ligatures').check();
    }
  }
  const widths = await page.locator('#comparisons .glyph-probe').evaluateAll(nodes => nodes.map(node => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    const style = getComputedStyle(node);
    context.font = `${style.fontSize} ${style.fontFamily}`;
    return { category: window.FONT_MANIFEST.fonts[node.closest('.orb').dataset.fontIndex].category, kind: node.closest('.orb').dataset.kind, i: context.measureText('iiiiiiii').width, w: context.measureText('WWWWWWWW').width };
  }));
  for (const category of ['Proportional', 'Quasi-proportional']) {
    const samples = widths.filter(item => item.category === category);
    assert.equal(samples.length, 2);
    assert.ok(samples.every(item => Math.abs(item.i - item.w) > 10), `${category} must have unequal Latin widths`);
  }
  assert.ok(widths.some(item => item.kind === 'monospace' && Math.abs(item.i - item.w) < 0.1));
  await page.locator('#ligatures').uncheck();
  assert.ok(await page.locator('.orb textarea, .orb .prose').evaluateAll(nodes => nodes.every(node => {
    const font = window.FONT_MANIFEST.fonts[Number(node.closest('.orb').dataset.fontIndex)];
    const css = getComputedStyle(node).fontFeatureSettings;
    const actual = Object.fromEntries(css.split(',').map(feature => { const [, tag, value] = feature.trim().match(/^"([^"]+)"(?: (\d+))?$/); return [tag, Number(value ?? 1)]; }));
    return Object.entries({ ...font.independentFeatures, ...font.ligatureFeaturesOff }).every(([tag, value]) => actual[tag] === value);
  })));
  await page.locator('#ligatures').check();
  assert.ok(await page.locator('.orb textarea, .orb .prose').evaluateAll(nodes => nodes.every(node => {
    const font = window.FONT_MANIFEST.fonts[Number(node.closest('.orb').dataset.fontIndex)];
    const css = getComputedStyle(node).fontFeatureSettings;
    const actual = Object.fromEntries(css.split(',').map(feature => { const [, tag, value] = feature.trim().match(/^"([^"]+)"(?: (\d+))?$/); return [tag, Number(value ?? 1)]; }));
    return Object.entries({ ...font.independentFeatures, ...font.ligatureFeatures }).every(([tag, value]) => actual[tag] === value);
  })));
  await page.locator('#size').fill('16');
  await page.locator('#size').dispatchEvent('input');
  assert.ok(await page.locator('.orb textarea, .orb .prose').evaluateAll(nodes => nodes.every(node => getComputedStyle(node).fontSize === '16px')));
  await page.locator('#size').fill('13');
  await page.locator('#size').dispatchEvent('input');
  await page.selectOption('#font', '0');
  const prompt = page.locator('#selected textarea');
  await prompt.fill('Editable: >= == != => -> === <= && || ++ **');
  assert.ok((await prompt.inputValue()).startsWith('Editable:'));
  await prompt.focus();
  await page.keyboard.press('End');
  await page.keyboard.type(' native');
  assert.ok((await prompt.inputValue()).endsWith(' native'));
  assert.equal(await page.locator('#comparisons .prose table').count(), fonts.length);
  assert.equal(await page.locator('#comparisons .prose pre').count(), fonts.length);
  await page.screenshot({ path: '/tmp/programming-fonts-desktop.png' });
  await page.locator('#comparisons').screenshot({ path: '/tmp/programming-fonts-comparisons.png' });
  await page.locator('#comparisons .card').first().screenshot({ path: '/tmp/programming-fonts-card-fira.png' });
  await page.locator('#comparisons .card').nth(fonts.findIndex(font => font.kind === 'proportional')).screenshot({ path: '/tmp/programming-fonts-card-proportional.png' });
  await page.locator('#comparisons .card').nth(fonts.findIndex(font => font.category === 'Proportional')).screenshot({ path: '/tmp/programming-fonts-card-recursive.png' });
  await page.evaluate(() => document.activeElement.blur());
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `document overflow at ${width}`);
    assert.ok(await page.locator('.orb').evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth)), `orb overflow at ${width}`);
    await assertRating('#selected-reputation', 5);
    await assertRating('#code-reputation', 5);
    await assertRating('.berkeley .reputation', 4);
    await page.locator('.licenses').evaluate(node => { node.open = true; });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Sources overflow at ${width}`);
    await page.locator('.licenses').evaluate(node => { node.open = false; });
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: `/tmp/programming-fonts-mobile-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  const html = readFileSync(new URL('./programming-fonts.html', import.meta.url), 'utf8');
  const fixture = Buffer.from(html.match(/data:font[^,]+,([^"\)]+)/)[1], 'base64');
  invalidFontDecode = true;
  await page.locator('#berkeley-file').setInputFiles({ name: 'invalid.woff2', mimeType: 'font/woff2', buffer: Buffer.from('not a font') });
  await page.waitForFunction(() => document.querySelector('#berkeley-status').textContent.includes('could not be loaded'));
  assert.ok(await berkeleyOption.evaluate(option => option.disabled));
  assert.equal(await page.locator('#berkeley-card').count(), 0);
  invalidFontDecode = false;
  await page.locator('#berkeley-file').setInputFiles({ name: 'uploaded-test-fixture.woff2', mimeType: 'font/woff2', buffer: fixture });
  await page.waitForFunction(() => !document.querySelector('#font option[value="berkeley"]').disabled);
  await page.selectOption('#font', 'berkeley');
  assert.ok((await page.locator('#selected-name').textContent()).includes('Uploaded font'));
  assert.equal(await page.locator('#selected-reputation').count(), 0, 'Unverified upload must not inherit Berkeley reputation');
  assert.equal(await page.locator('#berkeley-card .reputation').count(), 0);
  assert.ok((await page.locator('#berkeley-status').textContent()).includes('not verified'));
  assert.ok(!(await page.locator('#berkeley-status').textContent()).match(/unavailable|could not be loaded/));
  assert.ok(await page.locator('#selected textarea').evaluate(node => getComputedStyle(node).fontFamily.includes('BerkeleyPreview')));
  assert.ok((await codeStyle()).every(([face]) => face === 'StudyFont0'));
  assert.deepEqual(await page.locator('#code-font option').allTextContents(), codeOptions);
  assert.deepEqual(remote, []);
  assert.deepEqual(errors, []);
  console.log(`PASS: ${fonts.length} embedded fonts loaded${cdp ? ' and rendered (CDP)' : ' from standalone file'}, native textarea shaping pixel changes, matching transcript/prompt, editing, size/ligature controls, proportional widths, Markdown, 320/390px, independent monospace code picker with per-font ON/OFF features, confusables, editorial family ratings with dated sources and accessible stars, optional licensed-font file mechanics (fixture identity unverified, no inherited reputation), no remote requests or browser errors`);
} finally {
  await browser.close();
}
