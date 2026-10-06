'use strict';

// npm run build && npx electron scripts/smoke-settings.cjs
// Runs the real app, hidden, against disposable data and the fake @bart, and drives Settings (src/renderer/ui/Settings.jsx,
// 2026-10-06, MATH-53) with real (synthetic) input: the gear, the window's Model page (a level's model and effort
// saved to the models file as they change, each provider its own group), Escape closing the dialog and not the
// workspace, and in test mode the Test data page's Reset everything… (confirmed by ENGELBART_CONFIRM_ALL).
// ENGELBART_SETTINGS_SHOTS=<dir> saves pictures.
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
const file = (name) => { try { return JSON.parse(fs.readFileSync(path.join(root, '.engelbart', name), 'utf8')); } catch { return null; } };
const SHOTS = process.env.ENGELBART_SETTINGS_SHOTS;
async function shot(wc, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  const picture = await wc.capturePage(undefined, { stayHidden: true, stayAwake: true });
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), picture.toPNG());
}
// The centre of the button whose text starts with `words`.
const pressText = async (wc, words) => click(wc, await until(() => js(wc, `(()=>{const el=[...document.querySelectorAll('button')].find((b)=>b.textContent.trim().startsWith(${JSON.stringify(words)}));if(!el)return null;const r=el.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`), words));
const GEAR = '[data-settings] button[aria-label="Settings"]';
const DIALOG = '[data-levels-dialog]';
// A select's value set as a person's pick would set it (a native popup cannot be driven by synthetic input).
const choose = (wc, selector, value) => js(wc, `(()=>{const el=document.querySelector(${JSON.stringify(selector)});const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('change',{bubbles:true}));return el.value})()`);

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

    /* ------------------------------------------------ the gear opens the window at Model */
    await press(wc, GEAR);
    await until(() => has(wc, `${DIALOG} [data-level="anthropic:quick"]`), 'the window, at Model');
    assert.deepEqual(await js(wc, `[...document.querySelectorAll('${DIALOG} [data-settings-page]')].map((b)=>b.textContent)`), ['Model'], 'test mode is off: one page');
    await shot(wc, '2-levels');
    await choose(wc, '[data-level="anthropic:quick"] [data-level-field="model"]', 'opus');
    await until(() => (file(MODELS_FILE) || {}).discover && file(MODELS_FILE).discover.providers.anthropic.quick.model === 'opus', 'Quick on Opus saved');
    await choose(wc, '[data-level="anthropic:deep"] [data-level-field="effort"]', 'xhigh');
    await until(() => file(MODELS_FILE).discover.providers.anthropic.deep.effort === 'xhigh', 'Deep at Extra high saved');
    assert.equal(file(MODELS_FILE).discover.providers.anthropic.quick.model, 'opus', 'the first pick kept');
    await until(() => has(wc, '[data-level="openai:standard"]'), 'Codex\'s levels');
    await choose(wc, '[data-level="openai:standard"] [data-level-field="model"]', 'sol');
    await until(() => file(MODELS_FILE).discover.providers.openai.standard.model === 'sol', 'Codex Standard on Sol saved');
    await shot(wc, '3-codex');
    await key(wc, 'Escape');
    await until(async () => !(await has(wc, DIALOG)), 'Escape closes the dialog');
    assert.ok(await has(wc, ED), 'and not the workspace');

    /* ------------------------------------------------ test mode: the Test data section, and Reset everything… from it */
    await pressText(wc, 'Test ·');
    await until(() => js(wc, '!!document.querySelector("[data-window-controls]") && /Test · on/.test(document.querySelector("[data-window-controls]").textContent)'), 'test mode on');
    await pause(400);
    await press(wc, GEAR);
    await until(() => has(wc, '[data-settings-page="test-data"]'), 'the Test data page');
    await press(wc, '[data-settings-page="test-data"]');
    await until(() => has(wc, '[data-settings-item="reset"]'), 'the test data actions');
    await shot(wc, '4-test-data');
    const testRoot = path.join(root, '.engelbart', 'test');
    fs.writeFileSync(path.join(testRoot, 'marker'), 'x');
    await press(wc, '[data-settings-item="reset"]');
    await until(() => !fs.existsSync(path.join(testRoot, 'marker')), 'Reset everything… ran');
    await until(async () => !(await has(wc, DIALOG)), 'and closed the window');
    console.log('settings smoke: ok');
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
