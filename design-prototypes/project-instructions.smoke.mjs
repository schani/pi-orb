import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';

const browser = await chromium.launch({ headless: true });
await mkdir('/tmp/project-instructions-study', { recursive: true });
const errors = [];
let assertions = 0;
function check(value, message) { assert.ok(value, message); assertions++; }
try {
  for (const width of [1440, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 1100 } });
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto(process.env.STUDY_URL ?? pathToFileURL(`${process.cwd()}/design-prototypes/project-instructions.html`).href);
    const frame = page.locator('#frame');
    const editor = frame.getByRole('textbox', { name: 'Additional project instructions' });
    for (let variant = 0; variant < 5; variant++) {
      await page.locator(`[data-proposal="${variant}"]`).click();
      check(await editor.isVisible(), `${width}/${variant}: starts with editor`);
      await page.getByRole('button', { name: 'Show entry point', exact: true }).click();
      check(await editor.count() === 0, 'entry mode hides editor');
      if (variant === 4 && width <= 600) {
        await frame.getByRole('button', { name: 'Orb actions', exact: true }).click();
        await frame.getByRole('button', { name: 'Config for pi-orb', exact: true }).click();
      } else if (variant === 0 || variant === 1 || variant === 4) {
        await frame.getByRole('button', { name: 'Configure pi-orb', exact: true }).click();
      } else {
        await frame.locator('[data-action="entry"][data-project="0"]').click();
      }
      if (variant === 0) await frame.locator('[data-tab="Instructions"]').click();
      if (variant === 1) await frame.getByRole('button', { name: 'Additional instructions', exact: false }).click();
      check(await editor.isVisible(), 'actual entry opens editor');
      const draft = `# Project-specific ${variant}\n\n${width}px draft <tag> & text`;
      await editor.fill(draft);
      check(await editor.evaluate(el => getComputedStyle(el).backgroundColor) === 'rgb(255, 255, 255)', 'focused editor stays white');
      check(await frame.getByRole('status').textContent() === 'Unsaved', 'dirty feedback');
      await page.locator('#fail-save').check();
      await frame.locator('[data-action="save"]').click();
      check((await frame.getByRole('status').textContent()).startsWith('Save failed'), 'failure visible');
      check(await editor.inputValue() === draft, 'failure preserves draft');
      await editor.press('Escape');
      await page.getByRole('button', { name: 'Open editor', exact: true }).click();
      check(await editor.inputValue() === draft, 'close/reopen preserves draft');
      await page.locator('#fail-save').uncheck();
      await frame.locator('[data-action="save"]').click();
      check(await frame.getByRole('status').textContent() === 'Saved · next orb start', 'save receipt');
      check(await frame.locator('[data-action="save"]').isDisabled(), 'unchanged save disabled');
      if (variant === 0 || variant === 4) {
        await frame.locator('[data-tab="General"]').click();
        await frame.locator('[data-tab="Instructions"]').click();
        check(await editor.inputValue() === draft, 'tab switching preserves content');
      }
      if (variant === 4) {
        await frame.getByRole('textbox', { name: 'Message draft' }).fill('Independent message');
        check(await editor.inputValue() === draft, 'message draft is independent');
        const bounds = await frame.evaluate(el => {
          const a=el.querySelector('.margin-sheet').getBoundingClientRect();
          const b=el.querySelector('.compose').getBoundingClientRect();
          return { a: a.bottom, b: b.top };
        });
        check(bounds.a <= bounds.b, 'sheet leaves composer clear');
      }
      await page.screenshot({ path: `/tmp/project-instructions-study/${width}-${variant+1}.png`, fullPage: true });
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'page contained horizontally');
      check(await frame.evaluate(el => el.scrollWidth <= el.clientWidth), 'product frame contained horizontally');
      check(await frame.locator('img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0)), 'all tiles loaded');
      await editor.fill('');
      await frame.locator('[data-action="save"]').click();
      await editor.press('Escape');
      await page.getByRole('button', { name: 'Open editor', exact: true }).click();
      check(await editor.inputValue() === '', 'empty save clears document');
      // Other project content is neither copied from nor overwritten by the first project.
      await editor.press('Escape');
      if (variant < 4) {
        if (variant < 2) await frame.getByRole('button', { name: 'Configure field-notes', exact: true }).click();
        else await frame.locator('[data-action="entry"][data-project="1"]').click();
        if (variant === 0) await frame.locator('[data-tab="Instructions"]').click();
        if (variant === 1) await frame.getByRole('button', { name: 'Additional instructions', exact: false }).click();
        check((await editor.inputValue()).includes('field-notes'), 'project scope isolated');
      }
    }
    await page.close();
  }
  check(errors.length === 0, errors.join('\n'));
  console.log(`${assertions} assertions passed; screenshots: /tmp/project-instructions-study`);
} finally {
  await browser.close();
}
