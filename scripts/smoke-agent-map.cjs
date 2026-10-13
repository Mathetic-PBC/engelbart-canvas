'use strict';

// npm run build && npx electron scripts/smoke-agent-map.cjs
// Runs the real app, hidden, against disposable project/user data and the fake @bart (src/main/bart/ask.cjs, which records
// to the run log as the real one does), opens the Agent map from the Agents button (2026-10-12; src/main/agent-map), asks
// one @bart question by typing it, and checks the run shows in the map while it runs, then done with its steps and what
// was written. ENGELBART_MAP_SHOTS=<dir> saves pictures of the map.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-map-smoke-'));
app.setPath('userData', path.join(root, 'electron'));
process.env.ENGELBART_HOME_DIR = root;
process.env.ENGELBART_SUMMARIES = 'off';
process.env.ENGELBART_CONNECT_OFFER = 'off';
process.env.ENGELBART_TOOLS = 'off';
process.env.ENGELBART_WEB_PDFS = 'off';
process.env.ENGELBART_BART_FAKE = '1';
process.env.ENGELBART_BUILD_FAKE = '1';
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
const SHOTS = process.env.ENGELBART_MAP_SHOTS;
async function shot(wc, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  const picture = await wc.capturePage(undefined, { stayHidden: true, stayAwake: true });
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), picture.toPNG());
}
const mapOf = () => BrowserWindow.getAllWindows().find((win) => /\?view=agent-map$/.test(win.webContents.getURL()));

app.whenReady().then(async () => {
  try {
    const win = await until(() => BrowserWindow.getAllWindows()[0], 'app window');
    win.setFocusable(false);
    const wc = win.webContents;
    wc.setBackgroundThrottling(false);
    await until(() => js(wc, '!!window.engelbartAPI && !!document.querySelector("button")').catch(() => false), 'app bootstrap');
    await js(wc, `window.engelbartAPI.createProjectWithWelcome({name:'Map smoke', directory:${JSON.stringify(root)}})`);
    wc.reload();
    await until(() => js(wc, `!!document.querySelector(${JSON.stringify(ED)})`).catch(() => false), 'the workspace document');
    await pause(400);

    /* ------------------------------------------------ the Agents button opens the map, once */
    const clickAgents = `(()=>{const b=[...document.querySelectorAll('button')].find((el)=>el.textContent.trim()==='Agents');if(!b)return false;b.click();return true})()`;
    assert.ok(await until(() => js(wc, clickAgents), 'the Agents button'), 'the Agents button is there in a developer\'s copy');
    const map = await until(mapOf, 'the map window');
    assert.equal(map.isVisible(), false, 'smoke runs show no desktop window');
    const mc = map.webContents;
    mc.setBackgroundThrottling(false);
    await until(() => js(mc, `document.body.innerText.includes('Runs') && document.body.innerText.includes('Design')`).catch(() => false), 'the map page');
    await js(wc, clickAgents);
    await pause(300);
    assert.equal(BrowserWindow.getAllWindows().filter((w) => /\?view=agent-map$/.test(w.webContents.getURL())).length, 1, 'one map per app');
    console.log('PASS the Agents button opens the map, and a second click opens no second one');

    /* ------------------------------------------------ one @bart question, seen in the map while it runs */
    await press(wc, `${ED} [data-line="0"] .t`);
    await key(wc, 'A', { modifiers: ['meta'] });
    await key(wc, 'Backspace');
    await until(async () => (await rows(wc)).join('\n').trim() === '', 'an empty document');
    await typeKeys(wc, 'Notes\n@bart what does the map show\n');
    // Bart (the router, 2026-10-12) answers first, then hands the line to @chat; the fake answers in a few ms, so the runs
    // are caught as they show up, running or done.
    const live = await until(() => js(mc, `(()=>{const t=document.body.innerText;return t.includes('@bart → @chat')&&t.includes('@chat · via Bart')&&t.includes('what does the map show')?t:null})()`).catch(() => null), 'the router\'s run and the one it handed to, in the map', 200);
    await shot(mc, '1-running');
    console.log('PASS the @bart line shows in the map as Bart\'s pick and the @chat run it handed to');
    assert.match(live, /what does the map show/);

    await until(async () => !(await rows(wc)).some((line) => /^bart~> /.test(line)), 'the answer', 400);
    // The @chat run selected (the list starts on the first run it saw, Bart's).
    await js(mc, `[...document.querySelectorAll('div')].filter((d)=>d.onclick||d.getAttribute('style')?.includes('cursor: pointer')).find((d)=>d.innerText.startsWith(' @chat · via Bart')||d.innerText.trim().startsWith('@chat · via Bart'))?.click()`);
    const done = await until(() => js(mc, `(()=>{const t=document.body.innerText;return /\\bdone\\b/.test(t)&&t.includes('FAKE ANSWER')?t:null})()`).catch(() => null), 'the run done in the map', 200);
    assert.match(done, /3 Steps/);
    assert.match(done, /step 1/);
    await js(mc, `window.dispatchEvent(new KeyboardEvent('keydown',{key:'4'}))`);
    await until(() => js(mc, `document.body.innerText.includes('bart> FAKE ANSWER')`), 'Written');
    await js(mc, `window.dispatchEvent(new KeyboardEvent('keydown',{key:'2'}))`);
    await until(() => js(mc, `document.body.innerText.includes('<engelbart>') && document.body.innerText.includes('documents')`), 'Context');
    await shot(mc, '2-done');
    console.log('PASS done in the map with its steps, its context blocks and what was written');

    /* ------------------------------------------------ Design */
    await js(mc, `[...document.querySelectorAll('button')].find((b)=>b.textContent==='Design').click()`);
    const design = await until(() => js(mc, `(()=>{const t=document.body.innerText;return t.includes('@discover')&&t.includes('mcp__papers__*')?t:null})()`), 'the Design tab');
    assert.match(design, /@brainstorm/);
    await shot(mc, '3-design');
    console.log('PASS the Design tab lists the three agents');
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
