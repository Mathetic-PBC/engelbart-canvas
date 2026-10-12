'use strict';

// npm run build && npx electron scripts/smoke-import-context.cjs
// Runs the real app, hidden, against disposable data in test mode (a data root with no MEMORY.md and no Connect session),
// and checks "Import Context" (2026-10-12, src/renderer/ui/GuidedSetup.jsx ImportContextOffer): it appears over the
// workspace a person opens; Import opens Connect your library's tick-and-import screen over that workspace and nothing
// else (no onboarding, no welcome screen, no Welcome workspace); closing that popup leaves the offer away for this launch;
// a later launch offers it again; Not now dismisses it for good.
// ENGELBART_IMPORT_SHOTS=<dir> saves pictures.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-import-smoke-'));
app.setPath('userData', path.join(root, 'electron'));
process.env.ENGELBART_HOME_DIR = root;
process.env.ENGELBART_SUMMARIES = 'off';
delete process.env.ENGELBART_CONNECT_OFFER; // the offer is what this smoke is about
process.env.ENGELBART_TOOLS_FAKE = JSON.stringify({ claude: '2.1.300', codex: '0.155.1' });
process.env.ENGELBART_WEB_PDFS = 'off';
process.env.ENGELBART_BART_FAKE = '1';
process.env.ENGELBART_BUILD_FAKE = '1';
process.env.ENGELBART_CONNECT_FAKE = process.env.ENGELBART_CONNECT_FAKE || '1';
process.env.ENGELBART_HEADLESS = '1';
require('../src/main/index.cjs');

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
const spot = (wc, selector) => js(wc, `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;const r=el.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
const press = async (wc, selector) => { const at = await until(() => spot(wc, selector), selector); await click(wc, at); };
const has = (wc, selector) => js(wc, `!!document.querySelector(${JSON.stringify(selector)})`);
const text = (wc, selector) => js(wc, `(document.querySelector(${JSON.stringify(selector)})||{}).textContent||''`);
const SHOTS = process.env.ENGELBART_IMPORT_SHOTS;
async function shot(wc, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  const picture = await wc.capturePage(undefined, { stayHidden: true, stayAwake: true });
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), picture.toPNG());
}
// A fresh launch of the window, as Engelbart opening again: the page reloads and the workspace opens again.
async function relaunch(wc) {
  wc.reload();
  await until(() => js(wc, `!!document.querySelector(${JSON.stringify(ED)})`).catch(() => false), 'the workspace document');
}

app.whenReady().then(async () => {
  try {
    const win = await until(() => BrowserWindow.getAllWindows()[0], 'app window');
    win.setFocusable(false); // synthetic input only; do not capture the user's typing
    assert.equal(win.isVisible(), false, 'smoke runs must not show a desktop window');
    const wc = win.webContents;
    wc.setBackgroundThrottling(false);
    await until(() => js(wc, '!!window.engelbartAPI && !!document.querySelector("button")').catch(() => false), 'app bootstrap');

    /* ------------------------------------------------ test mode, a data root with nothing imported */
    const config = await js(wc, 'window.engelbartAPI.setTestMode(true)');
    assert.equal(config.testMode, true, 'test mode');
    const dataRoot = config.dataRoot;
    assert.ok(dataRoot.endsWith(`${path.sep}test`), dataRoot);
    assert.equal(fs.existsSync(path.join(dataRoot, 'MEMORY.md')), false, 'no MEMORY.md');
    assert.deepEqual(await js(wc, 'window.engelbartAPI.contextImported()'), { imported: false });
    const made = await js(wc, `window.engelbartAPI.createProjectWithWelcome({name:'Import smoke', directory:${JSON.stringify(root)}})`);
    const projectId = made.project.id;
    const workspacesBefore = (await js(wc, `window.engelbartAPI.loadProject(${JSON.stringify(projectId)})`)).workspaces.map((w) => w.id);
    await relaunch(wc);

    /* ------------------------------------------------ the popup appears over the workspace */
    await until(() => has(wc, '[data-import-offer]'), 'Import Context over the workspace');
    assert.equal(await text(wc, '#import-offer-title'), 'Import Context');
    assert.equal(await text(wc, '[data-import-offer] p'), 'Import your AI chats, papers, notes, and local files into Engelbart');
    assert.equal(await has(wc, ED), true, 'the workspace is under it');
    await shot(wc, '1-offer');

    /* ------------------------------------------------ Import: the tick-and-import screen over the workspace, nothing else */
    await press(wc, '[data-import-offer-import] button');
    await until(() => has(wc, '[data-connect-popup="offer"] [data-connect-library="choose"]'), 'Connect your library\'s tick-and-import screen');
    assert.equal(await has(wc, '[data-import-offer]'), false, 'the offer is gone');
    assert.equal(await has(wc, ED), true, 'the workspace is still open under it');
    assert.equal(await has(wc, '[data-onboarding]'), false, 'no onboarding');
    assert.equal(await js(wc, 'document.querySelectorAll("[data-connect-popup]").length'), 1, 'one popup');
    assert.equal(await js(wc, 'document.querySelectorAll("[role=dialog]").length'), 1, 'one dialog: Connect your library');
    assert.equal(await js(wc, '/Shown once/.test(document.body.textContent)'), false, 'no "Shown once" line');
    assert.equal(await js(wc, '/Welcome to Engelbart|guided setup/i.test(document.querySelector("[data-connect-popup]").textContent)'), false);
    const after = (await js(wc, `window.engelbartAPI.loadProject(${JSON.stringify(projectId)})`)).workspaces.map((w) => w.id);
    assert.deepEqual(after, workspacesBefore, 'no Welcome workspace added');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataRoot, '.guided-setup.json'), 'utf8')).how, 'started');
    await shot(wc, '2-choose');

    /* ------------------------------------------------ closed before an import: away for this launch, back on the next */
    await press(wc, '[data-connect-close]');
    await until(() => js(wc, '!document.querySelector("[data-connect-popup]")'), 'closed');
    await pause(1800);
    assert.equal(await has(wc, '[data-import-offer]'), false, 'not offered again in this launch');
    assert.deepEqual(await js(wc, 'window.engelbartAPI.guidedOffer()'), { show: true }, 'still due');
    await relaunch(wc);
    await until(() => has(wc, '[data-import-offer]'), 'offered again on a later launch');

    /* ------------------------------------------------ Not now: for good */
    await press(wc, '[data-import-offer-dismiss] button');
    await until(() => js(wc, '!document.querySelector("[data-import-offer]")'), 'dismissed');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataRoot, '.guided-setup.json'), 'utf8')).how, 'dismissed');
    assert.deepEqual(await js(wc, 'window.engelbartAPI.guidedOffer()'), { show: false });
    await relaunch(wc);
    await pause(1800);
    assert.equal(await has(wc, '[data-import-offer]'), false, 'not after Not now');

    console.log('import context smoke: ok');
    app.exit(0);
  } catch (failure) {
    console.error(failure);
    app.exit(1);
  }
});
