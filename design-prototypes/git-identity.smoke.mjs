import { runStudy } from "./study-browser.mjs";
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';

// Static presentation study only; no production routes or runtime calls.
// Serve design-prototypes/ (e.g. python3 -m http.server 5173 --bind 127.0.0.1) and run with node.
const url = process.env.STUDY_URL ?? 'http://127.0.0.1:5173/git-identity.html';
await runStudy("git-identity", async ({ browser, artifact }) => {
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });

const FAILED = 'Save failed: service unavailable';
const SAVED = 'Saved · next orb start';
const names = ['Git tab', '~/.gitconfig', 'Pick a source', 'Signature', 'Project override'];
const fail = page.getByLabel('Fail next save', { exact: true });
const hold = page.getByLabel('Hold saves', { exact: true });
const release = page.getByRole('button', { name: 'Release', exact: true });
const github = page.getByLabel('GitHub connected', { exact: true });
const settings = page.getByRole('dialog', { name: 'Settings' });
const gitPanel = settings.getByRole('tabpanel', { name: 'Git' });
const feedback = gitPanel.locator('.personal-instructions-feedback > span');
const save = gitPanel.getByRole('button', { name: 'Save', exact: true });
const gear = page.getByRole('button', { name: 'Settings', exact: true });
const field = (scope, label) => scope.getByLabel(label, { exact: true });
const box = async locator => (await locator.boundingBox()) ?? assert.fail('missing box');
let width = 1440;

async function shot(index, label) {
  await page.screenshot({ path: artifact(`git-identity-${index + 1}-${width}-${label}.png`), fullPage: true });
}

/** Failure keeps the draft; a held save locks the dialog; release completes once. */
async function failHoldSave(saveButton, status, assertDraft, closeButton) {
  await fail.check();
  await saveButton.click();
  await expect(status).toHaveText(FAILED);
  assert.equal(await fail.isChecked(), false, 'fail toggle is one-shot');
  await assertDraft();
  await hold.check();
  await saveButton.click();
  await expect(status).toHaveText(/Saving…|saving…/);
  await expect(closeButton).toBeDisabled();
  await expect(page.locator('#frame [role="dialog"] :is(input,textarea):not(:disabled)')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('#frame [role="dialog"]')).toHaveCount(1);
  await release.click();
  await hold.uncheck();
  await expect(status).toHaveText(SAVED);
  await assertDraft();
}

/** Backdrop never dismisses; Escape closes to the gear; reopen lands on Instructions and Git retains the draft. */
async function dismissAndReopen(assertDraft) {
  await page.locator('#frame [data-backdrop]').click({ position: { x: 4, y: 4 } });
  await expect(settings).toBeVisible();
  await assertDraft();
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
  await expect(gear).toBeFocused();
  await gear.click();
  await expect(settings.getByRole('tab', { name: 'Instructions' })).toHaveAttribute('aria-selected', 'true');
  await expect(settings.getByRole('button', { name: 'Close settings' })).toBeFocused();
  await settings.getByRole('tab', { name: 'Git' }).click();
  await assertDraft();
}

async function phoneTargets(locators) {
  if (width > 600) return;
  for (const locator of locators) {
    const { height } = await box(locator);
    assert.ok(height >= 48, `${await locator.evaluate(element => element.outerHTML.slice(0, 80))} is ${height}px tall at ${width}`);
  }
}
async function phoneInputs(locators) {
  if (width > 600) return;
  for (const locator of locators) assert.equal(await locator.evaluate(element => getComputedStyle(element).fontSize), '16px');
  await phoneTargets(locators);
}

const scenarios = [
  async function gitTab() {
    const name = field(gitPanel, 'user.name'), email = field(gitPanel, 'user.email');
    await expect(name).toHaveValue('Mark Probst');
    await expect(save).toBeDisabled();
    await phoneInputs([name, email]);
    await phoneTargets([save, settings.getByRole('button', { name: 'Close settings' }), settings.getByRole('tab', { name: 'Git' })]);
    await email.fill('');
    await expect(feedback).toHaveText('user.email missing');
    await expect(save).toBeDisabled();
    await email.fill('mark@probst.example');
    await expect(feedback).toHaveText('Unsaved');
    const draft = async () => { await expect(name).toHaveValue('Mark Probst'); await expect(email).toHaveValue('mark@probst.example'); };
    await failHoldSave(save, feedback, draft, settings.getByRole('button', { name: 'Close settings' }));
    await expect(save).toBeDisabled();
    await shot(0, 'saved');
    await name.fill(`Mark Probst ${width}`);
    await dismissAndReopen(async () => expect(name).toHaveValue(`Mark Probst ${width}`));
    await name.fill('');
    await email.fill('');
    await expect(save).toBeEnabled();
    await save.click();
    await expect(feedback).toHaveText(SAVED);
    await expect(name).toHaveValue('');
  },
  async function gitconfigFile() {
    const editor = gitPanel.getByRole('textbox', { name: '~/.gitconfig' });
    await expect(editor).toHaveValue('[user]\n\tname = Mark Probst\n\temail = mark@glideapps.com\n');
    await expect(save).toBeDisabled();
    await phoneInputs([editor]);
    await phoneTargets([save]);
    const broken = '[user]\n\tname = Mark Probst\n\temail = mark@glideapps.com\n[alias\n\tst = status\n';
    await editor.fill(broken);
    await save.click();
    await expect(feedback).toHaveText('bad config line 4');
    assert.equal(await feedback.getAttribute('role'), 'alert');
    assert.equal(await feedback.evaluate(element => getComputedStyle(element).color), 'rgb(180, 35, 24)');
    await expect(editor).toHaveValue(broken);
    await shot(1, 'bad-line');
    const fixed = broken.replace('[alias\n', '[alias]\n') + '[pull]\n\trebase = true\n';
    await editor.fill(fixed);
    await failHoldSave(save, feedback, async () => expect(editor).toHaveValue(fixed), settings.getByRole('button', { name: 'Close settings' }));
    await editor.fill(`${fixed}# unsaved ${width}\n`);
    await dismissAndReopen(async () => expect(editor).toHaveValue(`${fixed}# unsaved ${width}\n`));
  },
  async function pickSource() {
    const radio = label => gitPanel.getByRole('radio', { name: new RegExp(`^${label}`) });
    const row = label => gitPanel.locator('label.git-source', { hasText: label });
    await expect(radio('Google')).toBeChecked();
    await expect(save).toBeDisabled();
    await expect(field(gitPanel, 'user.name')).toHaveCount(0);
    await phoneTargets([row('Google'), row('GitHub'), row('Custom')]);
    await row('GitHub').click();
    await expect(radio('GitHub')).toBeChecked();
    await page.mouse.move(0, 0);
    assert.deepEqual(await row('GitHub').evaluate(element => [getComputedStyle(element).color, getComputedStyle(element).backgroundColor]), ['rgb(255, 255, 255)', 'rgb(0, 0, 0)']);
    await expect(row('GitHub')).toContainText('schani <123456+schani@users.noreply.github.com>');
    await row('Custom').click();
    const name = field(gitPanel, 'user.name'), email = field(gitPanel, 'user.email');
    await expect(name).toHaveValue('');
    await phoneInputs([name, email]);
    await name.fill('Mark Probst');
    await expect(feedback).toHaveText('user.email missing');
    await email.fill('mark@probst.example');
    const draft = async () => { await expect(radio('Custom')).toBeChecked(); await expect(name).toHaveValue('Mark Probst'); await expect(email).toHaveValue('mark@probst.example'); };
    await failHoldSave(save, feedback, draft, settings.getByRole('button', { name: 'Close settings' }));
    await shot(2, 'custom');
    await row('Google').click();
    await expect(field(gitPanel, 'user.name')).toHaveCount(0);
    await github.uncheck();
    await expect(radio('GitHub')).toBeDisabled();
    await expect(row('GitHub')).not.toContainText('schani');
    assert.equal(await row('GitHub').evaluate(element => getComputedStyle(element).color), 'rgb(153, 153, 153)');
    await row('GitHub').click({ force: true });
    await expect(radio('Google')).toBeChecked();
    await radio('Google').focus();
    await page.keyboard.press('ArrowDown');
    await expect(radio('Custom')).toBeChecked();
    await expect(name).toHaveValue('Mark Probst');
    await page.keyboard.press('ArrowUp');
    await expect(radio('Google')).toBeChecked();
    await shot(2, 'github-disconnected');
    await dismissAndReopen(async () => { await expect(radio('Google')).toBeChecked(); await expect(feedback).toHaveText('Unsaved'); });
    await github.check();
    await expect(radio('GitHub')).toBeEnabled();
  },
  async function signature() {
    await expect(settings).toHaveCount(0);
    await gear.click();
    assert.deepEqual(await settings.getByRole('tab').allTextContents(), ['Instructions', 'Claude']);
    await page.keyboard.press('Escape');
    await expect(gear).toBeFocused();
    const value = page.getByRole('button', { name: 'Mark Probst <mark@glideapps.com>', exact: true });
    const input = page.getByRole('textbox', { name: 'Git identity', exact: true });
    const note = page.locator('.git-signature-note');
    await phoneTargets([value]);
    await value.click();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('Mark Probst <mark@glideapps.com>');
    await phoneInputs([input]);
    await input.fill('Mark Probst');
    await input.press('Enter');
    await expect(note).toHaveText('missing <email>');
    assert.equal(await note.evaluate(element => getComputedStyle(element).color), 'rgb(180, 35, 24)');
    await shot(3, 'parse-error');
    await input.press('Escape');
    await expect(input).toHaveCount(0);
    await expect(value).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(input).toBeFocused();
    await input.fill('Mark Probst <mark@probst.example>');
    await fail.check();
    await input.press('Enter');
    await expect(note).toHaveText(FAILED);
    await expect(input).toHaveValue('Mark Probst <mark@probst.example>');
    await hold.check();
    await input.focus();
    await input.press('Enter');
    await expect(note).toHaveText('Saving…');
    await expect(input).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(input).toHaveValue('Mark Probst <mark@probst.example>');
    await release.click();
    await hold.uncheck();
    const saved = page.getByRole('button', { name: 'Mark Probst <mark@probst.example>', exact: true });
    await expect(saved).toBeVisible();
    await expect(note).toHaveText(SAVED);
    await shot(3, 'saved');
    await saved.click();
    await input.fill('');
    await input.press('Enter');
    const pen = page.getByRole('button', { name: 'Git identity', exact: true });
    await expect(pen).toBeVisible();
    await expect(page.locator('.git-signature')).toHaveCount(0);
    await phoneTargets([pen]);
    await shot(3, 'unset');
    await pen.click();
    await expect(input).toHaveValue('');
    await input.fill('schani <123456+schani@users.noreply.github.com>');
    await input.press('Enter');
    await expect(page.getByRole('button', { name: 'schani <123456+schani@users.noreply.github.com>', exact: true })).toBeFocused();
  },
  async function projectOverride() {
    const name = field(gitPanel, 'user.name');
    await name.fill('Mark P. Probst');
    await failHoldSave(save, feedback, async () => expect(name).toHaveValue('Mark P. Probst'), settings.getByRole('button', { name: 'Close settings' }));
    await dismissAndReopen(async () => expect(name).toHaveValue('Mark P. Probst'));
    await page.keyboard.press('Escape');
    const opener = page.getByRole('button', { name: 'Open pi-orb Config', exact: true });
    await opener.click();
    const config = page.getByRole('dialog', { name: 'Config for pi-orb' });
    const close = config.getByRole('button', { name: 'Close project config' });
    const userName = field(config, 'user.name'), userEmail = field(config, 'user.email');
    const projectSave = config.getByRole('button', { name: /^save|saving…$/ });
    await expect(userName).toHaveValue('');
    await expect(userName).toHaveAttribute('placeholder', 'Mark P. Probst');
    await expect(userEmail).toHaveAttribute('placeholder', 'mark@glideapps.com');
    assert.equal(await userName.evaluate(element => getComputedStyle(element, '::placeholder').color), 'rgb(153, 153, 153)');
    await phoneInputs([userName, userEmail, field(config, 'Name')]);
    await phoneTargets([projectSave]);
    await shot(4, 'inherit');
    await userEmail.fill('mark@work.example');
    await fail.check();
    await projectSave.click();
    await expect(config.getByRole('alert')).toHaveText(FAILED);
    await expect(userEmail).toHaveValue('mark@work.example');
    await hold.check();
    await projectSave.click();
    await expect(projectSave).toHaveText('saving…');
    await expect(close).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(config).toBeVisible();
    await release.click();
    await hold.uncheck();
    await expect(config.getByRole('status')).toHaveText(SAVED);
    await expect(userEmail).toHaveValue('mark@work.example');
    await expect(userName).toHaveValue('');
    assert.equal(await userEmail.evaluate(element => getComputedStyle(element).color), 'rgb(0, 0, 0)');
    await shot(4, 'override');
    await page.locator('#frame [data-backdrop]').click({ position: { x: 4, y: 4 } });
    await expect(config).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(config).toHaveCount(0);
    await expect(opener).toBeFocused();
    const projectGear = page.getByRole('button', { name: 'Configure pi-orb', exact: true });
    await projectGear.click();
    await expect(userEmail).toHaveValue('mark@work.example');
    await userEmail.fill('');
    await projectSave.click();
    await expect(config.getByRole('status')).toHaveText(SAVED);
    await expect(userEmail).toHaveValue('');
    await expect(userEmail).toHaveAttribute('placeholder', 'mark@glideapps.com');
    await page.keyboard.press('Escape');
    await expect(projectGear).toBeFocused();
    await gear.click();
    await settings.getByRole('tab', { name: 'Git' }).click();
  },
];

for (width of [1440, 390]) {
  await page.setViewportSize({ width, height: 1000 });
  await page.goto(url);
  await page.reload();
  for (const [index, name] of names.entries()) {
    await page.getByRole('button', { name: `${index + 1}. ${name}`, exact: true }).click();
    await expect(page.locator('#rationale')).not.toBeEmpty();
    if (index !== 3) await expect(settings.getByRole('tab', { name: 'Git' })).toHaveAttribute('aria-selected', 'true');
    await scenarios[index]();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} overflows at ${width}`);
    await shot(index, 'final');
  }
}
assert.deepEqual(errors, []);

console.log('Five proposals × 1440/390: edit, validation, failed save + draft retention, held save locks dialog, success receipt, backdrop/Escape/focus, reopen retention, source switching incl. disabled GitHub, signature Enter/Escape/parse/unset, project inherit/override, 16px/48px phone targets, no overflow, no console or script errors.');

});
