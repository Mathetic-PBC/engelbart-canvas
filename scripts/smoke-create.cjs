'use strict';

// npm run build && npx electron scripts/smoke-create.cjs
// Runs the real app, hidden, against disposable project/user data, and drives an @create exchange (2026-10-14): while it
// runs, its line on what it is making (2026-10-15) and a row with a spinner, what it is doing, m:ss and Stop; once done, the sentence and a
// row per file (icon, name, ✓ Saved, ⌄), each already in the library under Assets (2026-10-15: saved as the run ends);
// ⌄ opens a file inline; its name opens it in a Stage tab, which reads "✓ Saved" and the address
// "Library / Assets / <name>".
// The fake agents (src/main/bart/ask.cjs fakeCreate) by default; ENGELBART_CREATE_REAL=1 runs the real Create (it needs the
// model's sign-in on this Mac) on "make an SVG diagram of the agent prompts". ENGELBART_CREATE_SHOTS=<dir> saves pictures.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const REAL = process.env.ENGELBART_CREATE_REAL === '1';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-create-smoke-'));
app.setPath('userData', path.join(root, 'electron'));
process.env.ENGELBART_HOME_DIR = root;
process.env.ENGELBART_SUMMARIES = 'off';
process.env.ENGELBART_CONNECT_OFFER = 'off';
process.env.ENGELBART_TOOLS = 'off';
process.env.ENGELBART_WEB_PDFS = 'off';
if (!REAL) process.env.ENGELBART_BART_FAKE = '1';
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
const key = async (wc, keyCode, { ch = null, modifiers = [] } = {}) => {
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  if (ch) wc.sendInputEvent({ type: 'char', keyCode: ch, modifiers });
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await pause(30);
};
const typeKeys = async (wc, text) => { for (const ch of text) { if (ch === '\n') await key(wc, 'Enter', { ch: '\r' }); else await key(wc, ch === ' ' ? 'Space' : ch, { ch }); } await pause(150); };
const rows = (wc) => js(wc, `[...document.querySelectorAll(${JSON.stringify(`${ED} [data-line]`)})].map((d) => d.dataset.raw)`);
const spot = (wc, selector) => js(wc, `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return{x:Math.round(r.x+Math.min(r.width/2,40)),y:Math.round(r.y+r.height/2)}})()`);
const press = async (wc, selector) => { const at = await until(() => spot(wc, selector), selector); await click(wc, at); };
const SHOTS = process.env.ENGELBART_CREATE_SHOTS;
async function shot(wc, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  const picture = await wc.capturePage(undefined, { stayHidden: true, stayAwake: true });
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), picture.toPNG());
}
// Where a run's files are once saved (ENGELBART_CREATE_SHOTS gets after-save.json): every
// file under the disposable home but the database's own, the run's saved list, the workspace's meta.json and the library
// rows @create made.
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (!/\.pglite$|^electron$/.test(entry.name)) walk(full, out); } else out.push(path.relative(root, full));
  }
  return out;
}
async function dump(wc, name) {
  if (!SHOTS) return;
  const files = walk(root).sort();
  const json = (rel) => { try { return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')); } catch { return null; } };
  const library = (await js(wc, 'window.engelbartAPI.library()').catch(() => [])) || [];
  const out = {
    home: root,
    createdFiles: files.filter((rel) => rel.includes(`${path.sep}.created${path.sep}`) || rel.startsWith(`.created${path.sep}`)),
    keptCopies: files.filter((rel) => rel.startsWith(path.join('assets', 'files'))),
    savedList: Object.fromEntries(files.filter((rel) => rel.endsWith('.engelbart-saved.json')).map((rel) => [rel, json(rel)])),
    workspaceMeta: Object.fromEntries(files.filter((rel) => rel.endsWith(`${path.sep}meta.json`)).map((rel) => [rel, json(rel)])),
    libraryRowsFromCreate: library.filter((row) => row.source === 'create'),
    libraryCount: library.length,
  };
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(path.join(SHOTS, `${name}.json`), `${JSON.stringify(out, null, 2)}\n`);
}
const made = (wc) => js(wc, `[...document.querySelectorAll('${ED} [data-made-row]')].map((r)=>({key:r.dataset.madeRow,name:(r.querySelector('.made-name')||{}).textContent,thumb:!!r.querySelector('img'),save:(r.querySelector('[data-act="madesave"],[data-made-saved]')||{}).textContent,bg:getComputedStyle(r).backgroundColor}))`);

app.whenReady().then(async () => {
  try {
    const win = await until(() => BrowserWindow.getAllWindows()[0], 'app window');
    win.setFocusable(false);
    win.setContentSize(1440, 900);
    const wc = win.webContents;
    wc.setBackgroundThrottling(false);
    await until(() => js(wc, '!!window.engelbartAPI && !!document.querySelector("button")').catch(() => false), 'app bootstrap');
    await js(wc, `window.engelbartAPI.createProjectWithWelcome({name:'Create smoke', directory:${JSON.stringify(root)}})`);
    wc.reload();
    await until(() => js(wc, `!!document.querySelector(${JSON.stringify(ED)})`).catch(() => false), 'the workspace document');
    await pause(400);
    const before = (await js(wc, 'window.engelbartAPI.library()').catch(() => [])) || [];

    /* ------------------------------------------------ running */
    await press(wc, `${ED} [data-line="0"] .t`);
    await key(wc, 'A', { modifiers: ['meta'] });
    await key(wc, 'Backspace');
    await until(async () => (await rows(wc)).join('\n').trim() === '', 'an empty document');
    await typeKeys(wc, '@create make an SVG diagram of the agent prompts\n');
    await until(() => js(wc, `!!document.querySelector('${ED} [data-create-pending]')`), 'the running row');
    const running = await until(() => js(wc, `(()=>{const r=document.querySelector('${ED} [data-create-pending]');if(!r)return null;const t=r.innerText;return ${REAL ? "/^Creating /" : '/Creating a fake report, a chart page and its data/'}.test(t)&&/Stop/.test(t)&&r.querySelector('[data-made-clock]')?t:null})()`), 'its line, the clock and Stop', 600);
    console.log('running:', JSON.stringify(running));
    await until(() => js(wc, `/\\S/.test((document.querySelector('${ED} [data-create-pending]')||{}).innerText||'') && !!document.querySelector('${ED} [data-create-pending] > div:first-child:not([style*="display:flex"])')`), 'its sentence', REAL ? 2400 : 300).catch(() => console.log('(no sentence before the shot)'));
    await shot(wc, '1-running');

    /* ------------------------------------------------ done */
    const done = await until(async () => { const list = await made(wc); return list.length && list.every((one) => one.save) ? list : null; }, 'the made rows', REAL ? 12000 : 600);
    console.log('done:', JSON.stringify(done));
    assert.ok(done.length >= 1 && done.length <= 5, 'a row per file, up to five');
    await until(async () => (await made(wc)).every((one) => /Saved/.test(one.save)), 'each row reads Saved', 400);
    assert.ok(!(await rows(wc)).some((line) => /@\[[^\]]*\]\(made:/.test(line) && !/^bart> @\[[^\]]*\]\(made:[^)]*\)$/.test(line)), 'no @mention shown as text');
    await until(async () => (await made(wc)).some((one) => one.thumb), 'a thumbnail', 200).catch(() => console.log('(no thumbnail drawn)'));
    await pause(400);
    await shot(wc, '2-done');
    const library = (await js(wc, 'window.engelbartAPI.library()').catch(() => null));
    if (Array.isArray(library)) assert.equal(library.length, before.length + done.length, 'each file went into the library as the run ended');

    /* ------------------------------------------------ peek: a small card over the page; nothing in the document moves */
    const peekAt = await spot(wc, `${ED} [data-made-row="${done[0].key}"] .made-name`);
    const layout = () => js(wc, `[...document.querySelectorAll('${ED} [data-line]')].map((d)=>Math.round(d.getBoundingClientRect().top)).join(',')`);
    const still = await layout();
    wc.sendInputEvent({ type: 'mouseMove', x: peekAt.x, y: peekAt.y });
    const card = await until(() => js(wc, `(()=>{const c=document.querySelector('[data-made-peek-card]');if(!c)return null;const r=c.getBoundingClientRect();return{w:Math.round(r.width),h:Math.round(r.height),overlay:c.getAttribute('data-overlay')}})()`), 'the peek', 100);
    console.log('peek:', JSON.stringify(card));
    assert.ok(card.w === 280 && card.overlay === '1', JSON.stringify(card));
    assert.equal(await layout(), still, 'nothing in the document moved');
    assert.equal(await js(wc, `document.querySelectorAll('${ED} [data-made-frame]').length`), 0, 'no frame opened in the document');
    await pause(300);
    await shot(wc, '2b-peek');
    wc.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 });
    await until(() => js(wc, `!document.querySelector('[data-made-peek-card]')`), 'the peek gone', 100);

    /* ------------------------------------------------ expanded */
    const pick = done.find((one) => /\.svg$/i.test(one.name)) || done.find((one) => /\.html$/i.test(one.name)) || done[0];
    await press(wc, `${ED} [data-made-row="${pick.key}"] [data-act="madeexpand"]`);
    await until(() => js(wc, `!!document.querySelector('${ED} [data-made-frame="${pick.key}"]')`), 'the inline frame');
    await pause(600);
    await js(wc, `document.querySelector('${ED} [data-made-frame="${pick.key}"]').scrollIntoView({block:'center'})`);
    await pause(200);
    await shot(wc, '3-expanded');
    await press(wc, `${ED} [data-made-frame="${pick.key}"] [data-act="madeexpand"]`);
    await until(() => js(wc, `!!document.querySelector('${ED} [data-made-row="${pick.key}"]')`), 'folded again');

    /* ------------------------------------------------ open in Stage */
    await press(wc, `${ED} [data-made-row="${pick.key}"] .made-name`);
    await until(() => js(wc, `!!document.querySelector('[data-page-save="made-saved"]')`), '✓ Saved in the Stage', 400);
    await pause(800);
    await shot(wc, '4-stage');

    /* ------------------------------------------------ saved */
    const crumb = await until(() => js(wc, `(document.querySelector('[data-stage-crumb]')||{}).textContent`), 'the address crumb');
    console.log('crumb:', crumb);
    assert.equal(crumb, `Library / Assets / ${crumb.split(' / ').pop()}`);
    await dump(wc, 'after-save');

    /* ------------------------------------------------ collapse */
    const collapse = await spot(wc, `[data-fold-all="collapse"]`);
    if (collapse) {
      await click(wc, collapse);
      await pause(400);
      await shot(wc, '6-collapsed');
    }
    console.log('smoke-create: ok');
    app.exit(0);
  } catch (error) {
    console.error(error);
    try { await shot(BrowserWindow.getAllWindows()[0].webContents, 'failed'); } catch { /* none */ }
    app.exit(1);
  }
});
