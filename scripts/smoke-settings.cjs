'use strict';

// npm run build && npx electron scripts/smoke-settings.cjs
// Runs the real app, hidden, against disposable data and the fake @bart, and drives Settings (src/renderer/ui/Settings.jsx,
// 2026-10-06, MATH-53) with real (synthetic) input: a pick by hand on an @bart line, then the gear, its "Using your last
// pick" line, a default set in a cell's grid, Fable then Sonnet keeping the ladder whole, the next question on it with no
// restart; a pick by hand after that winning, a pick on Codex that @brainstorm and @discover follow and a save of Claude
// Code's default leaves alone, "Use default", Build's default provider, @discover's Advanced, Escape and a press outside, and in test mode the Test data
// section's Reset everything… (confirmed by ENGELBART_CONFIRM_ALL). ENGELBART_SETTINGS_SHOTS=<dir> saves pictures.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-settings-smoke-'));
app.setPath('userData', path.join(root, 'electron'));
process.env.ENGELBART_HOME_DIR = root;
process.env.ENGELBART_SUMMARIES = 'off';
process.env.ENGELBART_TOOLS = 'off';
process.env.ENGELBART_WEB_PDFS = 'off';
process.env.ENGELBART_BART_FAKE = '1';
process.env.ENGELBART_BUILD_FAKE = '1';
process.env.ENGELBART_HEADLESS = '1';
process.env.ENGELBART_CONFIRM_ALL = '1'; // Reset everything… without the native confirmation
require('../src/main/index.cjs');
const { MODELS_FILE } = require('../src/main/bart/models.cjs');
const { CHOICES_FILE } = require('../src/main/bart/choices.cjs');

const pause = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, tries = 300) {
  for (let i = 0; i < tries; i++) { const result = await fn(); if (result) return result; await pause(); }
  throw new Error(`Timed out: ${label}`);
}
const js = (wc, expression) => wc.executeJavaScript(expression, true);
const ED = 'main [data-editor]';
const click = async (wc, { x, y }) => {
  wc.focus();
  await pause();
  wc.sendInputEvent({ type: 'mouseMove', x, y });
  wc.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x, y });
  wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x, y });
  await pause(150);
};
const key = async (wc, keyCode, { ch = null, modifiers = [] } = {}) => {
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  if (ch) wc.sendInputEvent({ type: 'char', keyCode: ch, modifiers });
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await pause(30);
};
const typeKeys = async (wc, text) => { for (const ch of text) { if (ch === '\n') await key(wc, 'Enter', { ch: '\r' }); else await key(wc, ch === ' ' ? 'Space' : ch, { ch }); } await pause(150); };
const rows = (wc) => js(wc, `[...document.querySelectorAll(${JSON.stringify(`${ED} [data-line]`)})].map((d) => d.dataset.raw)`);
const spot = (wc, selector) => js(wc, `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();return{x:Math.round(r.x+Math.min(r.width/2,40)),y:Math.round(r.y+r.height/2)}})()`);
const press = async (wc, selector) => { const at = await until(() => spot(wc, selector), selector); await click(wc, at); };
const has = (wc, selector) => js(wc, `!!document.querySelector(${JSON.stringify(selector)})`);
const textOf = (wc, selector) => js(wc, `(document.querySelector(${JSON.stringify(selector)})||{}).textContent||''`);
const settled = (wc) => until(async () => !(await rows(wc)).some((line) => /^bart~> /.test(line)), 'the runs answer', 400);
const file = (name) => { try { return JSON.parse(fs.readFileSync(path.join(root, '.engelbart', name), 'utf8')); } catch { return null; } };
const SHOTS = process.env.ENGELBART_SETTINGS_SHOTS;
async function shot(wc, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  const picture = await wc.capturePage(undefined, { stayHidden: true, stayAwake: true });
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), picture.toPNG());
}
// Asks on a new line under the first and waits for the answer; → the foot line of that answer ("bart> *Sonnet · high · 1s*").
async function ask(wc, line) {
  await press(wc, `${ED} [data-line="0"] .t`);
  await key(wc, 'End');
  await typeKeys(wc, `\n${line}\n`);
  await settled(wc);
  const after = await rows(wc), question = line.replace(/^@bart (--\S+ )*/, '');
  const at = after.findIndex((text) => text.includes(`FAKE ANSWER to "${question}"`));
  assert.ok(at > 0, `answered: ${line}`);
  return after.slice(at).find((text) => /^bart> \*.* · .*\*$/.test(text)) || '';
}
// The centre of the button whose text starts with `words`.
const pressText = async (wc, words) => click(wc, await until(() => js(wc, `(()=>{const el=[...document.querySelectorAll('button')].find((b)=>b.textContent.trim().startsWith(${JSON.stringify(words)}));if(!el)return null;const r=el.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`), words));
const GEAR = '[data-settings] button[aria-label="Settings"]';
const PANEL = '[data-settings-panel]';

app.whenReady().then(async () => {
  try {
    const win = await until(() => BrowserWindow.getAllWindows()[0], 'app window');
    win.setFocusable(false); // synthetic input only; do not capture the user's typing
    assert.equal(win.isVisible(), false, 'smoke runs must not show a desktop window');
    const wc = win.webContents;
    wc.setBackgroundThrottling(false);
    await until(() => js(wc, '!!window.engelbartAPI && !!document.querySelector("button")').catch(() => false), 'app bootstrap');
    await js(wc, `window.engelbartAPI.createProjectWithWelcome({name:'Settings smoke', directory:${JSON.stringify(root)}})`);
    wc.reload();
    await until(() => js(wc, `!!document.querySelector(${JSON.stringify(ED)})`).catch(() => false), 'the workspace document');
    await pause(400);
    assert.equal(await js(wc, 'document.querySelectorAll("[data-window-controls] button[aria-label=Settings]").length'), 1, 'one gear');
    await press(wc, `${ED} [data-line="0"] .t`);
    await key(wc, 'A', { modifiers: ['meta'] });
    await key(wc, 'Backspace');
    await until(async () => (await rows(wc)).join('\n').trim() === '', 'an empty document');
    await typeKeys(wc, 'Notes');

    /* ------------------------------------------------ a pick by hand, then a default set in Settings */
    assert.match(await ask(wc, '@bart first question'), /Sonnet · high/, 'the shipped default');
    assert.match(await ask(wc, '@bart --opus --max picked by hand'), /Opus · max/);
    assert.match(await ask(wc, '@bart starts on the pick'), /Opus · max/, 'a pick by hand is where the next one starts');
    assert.deepEqual(file(CHOICES_FILE).bart, { provider: 'anthropic', model: 'opus', effort: 'max' });

    await press(wc, GEAR);
    await until(() => has(wc, PANEL), 'the panel');
    assert.equal(await has(wc, '[data-settings-section="test"]'), false, 'test mode is off: no Test data');
    await until(() => has(wc, '[data-settings-cell="bart:anthropic:standard"]'), 'the rows');
    assert.match(await textOf(wc, '[data-last-pick="bart"]'), /Using your last pick: Opus Max/);
    await shot(wc, '1-settings');
    await press(wc, '[data-settings-cell="bart:anthropic:standard"]');
    await until(() => has(wc, '[data-settings-grid="bart:anthropic:standard"] [data-model-grid]'), 'the cell\'s grid');
    await shot(wc, '2-settings-grid');
    // Extra high, on Sonnet (the model the grid starts on).
    await press(wc, '[data-settings-grid="bart:anthropic:standard"] [aria-label="Effort"] [role="option"]:nth-child(3)');
    await until(() => { const held = file(MODELS_FILE); return held && held.providers.anthropic.ladder[0].effort === 'xhigh'; }, 'the default written');
    assert.deepEqual(file(MODELS_FILE).providers.anthropic.ladder, [{ model: 'sonnet', effort: 'xhigh' }, { model: 'opus', effort: 'high' }, { model: 'fable', effort: 'xhigh' }]);
    await until(async () => !(await has(wc, '[data-last-pick="bart"]')), 'the last pick forgotten');
    assert.equal(file(CHOICES_FILE).bart, undefined);
    assert.match(await textOf(wc, '[data-settings-cell="bart:anthropic:standard"]'), /Sonnet Extra high/);
    // Fable, then Sonnet: the ladder is the built-in one from Sonnet up again, not Sonnet alone.
    const MODEL = '[data-settings-grid="bart:anthropic:standard"] [aria-label="Model"] [role="option"]';
    await press(wc, `${MODEL}:nth-child(3)`);
    await until(() => file(MODELS_FILE).providers.anthropic.ladder[0].model === 'fable', 'Fable written');
    assert.deepEqual(file(MODELS_FILE).providers.anthropic.ladder, [{ model: 'fable', effort: 'xhigh' }]);
    await press(wc, `${MODEL}:nth-child(1)`);
    await until(() => file(MODELS_FILE).providers.anthropic.ladder[0].model === 'sonnet', 'Sonnet written');
    assert.deepEqual(file(MODELS_FILE).providers.anthropic.ladder, [{ model: 'sonnet', effort: 'xhigh' }, { model: 'opus', effort: 'high' }, { model: 'fable', effort: 'xhigh' }]);
    await key(wc, 'Escape');
    await until(async () => !(await has(wc, PANEL)), 'Escape closes the panel');
    await pause(200);
    assert.ok(await has(wc, ED), 'and only the panel: the workspace stays open');
    assert.match(await ask(wc, '@bart after the save'), /Sonnet · xhigh/, 'the next question is on the saved default, with no restart');
    assert.match(await ask(wc, '@bart --fable --high picked again'), /Fable · high/);
    assert.match(await ask(wc, '@bart the pick wins again'), /Fable · high/, 'a pick by hand after the save wins');
    // A pick on Codex: @brainstorm and @discover follow it there, and say so.
    assert.match(await ask(wc, '@bart --astra --xhigh on Codex'), /Astra · xhigh/);
    await press(wc, GEAR);
    await until(() => has(wc, '[data-last-pick="brainstorm"]'), '@brainstorm follows the pick');
    assert.match(await textOf(wc, '[data-last-pick="bart"]'), /Using your last pick: Astra Extra high/);
    assert.match(await textOf(wc, '[data-last-pick="brainstorm"]'), /Using your last pick: Codex\s*·\s*Use default/);
    assert.match(await textOf(wc, '[data-last-pick="discover"]'), /Using your last pick: Codex\s*·\s*Use default/);
    // Claude Code's @bart default saved: the pick on Codex stays.
    await press(wc, '[data-settings-cell="bart:anthropic:standard"]');
    await press(wc, '[data-settings-grid="bart:anthropic:standard"] [aria-label="Effort"] [role="option"]:nth-child(3)');
    await pause(300);
    assert.deepEqual(file(CHOICES_FILE).bart, { provider: 'openai', model: 'astra', effort: 'xhigh' });
    await shot(wc, '3-settings-followed');
    await key(wc, 'Escape');
    await until(async () => !(await has(wc, PANEL)), 'Escape closes the panel');

    /* ------------------------------------------------ Use default, Build's provider, Advanced, a press outside */
    await press(wc, GEAR);
    await until(() => has(wc, '[data-use-default="bart"]'), 'the last pick again');
    await press(wc, '[data-use-default="bart"]');
    await until(async () => !(await has(wc, '[data-last-pick="bart"]')), 'Use default');
    assert.equal(file(CHOICES_FILE).bart, undefined);
    await press(wc, '[data-settings-provider="build"] [data-provider="openai"]');
    await until(() => (file(MODELS_FILE).build || {}).provider === 'openai', 'Build\'s default provider written');
    assert.equal(file(MODELS_FILE).provider, 'anthropic', '@bart\'s stays');
    await press(wc, '[data-settings-advanced]');
    await until(() => has(wc, '[data-settings-cell="discover:anthropic:deep"]'), 'Advanced opens quick and deep');
    await press(wc, '[data-settings-cell="discover:openai:deep"]');
    await until(() => has(wc, '[data-settings-grid="discover:openai:deep"]'), 'deep\'s grid');
    await shot(wc, '4-settings-advanced');
    await press(wc, '[data-settings-grid="discover:openai:deep"] [aria-label="Model"] [role="option"]:nth-child(2)'); // Sol
    await until(() => file(MODELS_FILE).discover.providers.openai.deep.model === 'sol', '@discover\'s deep level written');
    await click(wc, await spot(wc, `${ED} [data-line="0"] .t`));
    await until(async () => !(await has(wc, PANEL)), 'a press outside closes it');
    assert.match(await ask(wc, '@bart Use default went back'), /Sonnet · xhigh/);
    const build = await js(wc, 'window.engelbartAPI.buildModels("build")');
    assert.deepEqual([build.provider, build.providers.openai.ladder[0]], ['openai', { model: 'sol', effort: 'high' }], 'a Build panel opened now starts on Codex');

    /* ------------------------------------------------ test mode: the Test data section, and Reset everything… from it */
    await pressText(wc, 'Test ·');
    await until(() => js(wc, '!!document.querySelector("[data-window-controls]") && /Test · on/.test(document.querySelector("[data-window-controls]").textContent)'), 'test mode on');
    await pause(400);
    await press(wc, GEAR);
    await until(() => has(wc, '[data-settings-section="test"]'), 'the Test data section');
    await shot(wc, '5-settings-test');
    const testRoot = path.join(root, '.engelbart', 'test');
    fs.writeFileSync(path.join(testRoot, 'marker'), 'x');
    await press(wc, '[data-settings-section="test"] [role="menuitem"]:nth-child(3)');
    await until(() => !fs.existsSync(path.join(testRoot, 'marker')), 'Reset everything… ran');
    await until(async () => !(await has(wc, PANEL)), 'and closed the panel');
    console.log('settings smoke: ok');
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
