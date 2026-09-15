import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

// Static presentation study only; no production routes or runtime calls.
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.goto(process.env.STUDY_URL ?? 'http://127.0.0.1:5184');
const editor = page.getByRole('textbox', { name: 'Personal AGENTS.md', exact: true });
const variants = ['Home gear', 'Footer folio', 'Personal fold', 'Scope switch', 'Margin sheet'];
for (const width of [1440, 390]) {
  await page.setViewportSize({ width, height: 1000 });
  for (const [index, name] of variants.entries()) {
    await page.getByRole('button', { name: `${index + 1}. ${name}`, exact: true }).click();
    await editor.waitFor({ state: 'visible' });
    if (index === 4) {
      await page.getByRole('button', { name: 'Show entry point', exact: true }).click();
      await page.getByRole('textbox', { name: 'Message draft' }).fill(`Separate message draft at ${width}`);
      await page.getByRole('button', { name: 'Personal instructions', exact: true }).filter({ visible: true }).click();
    }
    const draft = `# ${name}\n\nPrefer simplicity. Width ${width}.`;
    await editor.fill(draft);
    await page.getByLabel('Simulate failed save').check();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    assert.equal(await page.getByRole('status').textContent(), 'Save failed. Draft retained.');
    assert.equal(await editor.inputValue(), draft);
    await page.getByLabel('Simulate failed save').uncheck();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    assert.equal(await page.getByRole('status').textContent(), 'Saved · next orb start');
    assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).isDisabled(), true);
    await editor.fill(`${draft}\nAn unsaved line.`);
    await editor.press('Escape');
    assert.equal(await editor.count(), 0);
    if (index === 0) await page.getByRole('button', { name: 'Personal instructions', exact: true }).click();
    if (index === 1) await page.getByRole('button', { name: '~/AGENTS.md', exact: true }).click();
    if (index === 2) await page.getByRole('button', { name: '▸ ~/AGENTS.md', exact: true }).click();
    if (index === 3) {
      await page.getByRole('button', { name: 'Configure pi-orb', exact: true }).click();
      assert.equal(await editor.count(), 0);
      await page.getByRole('button', { name: 'Me', exact: true }).click();
    }
    if (index === 4) await page.getByRole('button', { name: 'Personal instructions', exact: true }).filter({ visible: true }).click();
    assert.equal(await editor.inputValue(), `${draft}\nAn unsaved line.`);
    if (index === 4) assert.equal(await page.getByRole('textbox', { name: 'Message draft' }).inputValue(), `Separate message draft at ${width}`);
    if (index === 2) {
      await page.getByRole('button', { name: '▾ ~/AGENTS.md', exact: true }).hover();
      const colors = await page.getByRole('button', { name: '▾ ~/AGENTS.md', exact: true }).evaluate(element => ({ foreground: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor }));
      assert.deepEqual(colors, { foreground: 'rgb(255, 255, 255)', background: 'rgb(0, 0, 0)' });
      await page.mouse.move(0, 0);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} overflow at ${width}`);
    await page.screenshot({ path: `/tmp/user-agents-${index + 1}-${width}.png`, fullPage: true });
  }
}
assert.deepEqual(errors, []);
await browser.close();
console.log('Five proposals × desktop/phone: entry, edit, failed save, successful save, dismissal, draft retention, scope, width, script errors passed.');
