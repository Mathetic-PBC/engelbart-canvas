'use strict';

// npm run build && npx electron scripts/smoke-math-ask.cjs
// Runs the real app, hidden, against disposable data and the real @bart, asks one question that needs a formula, and
// reports how the answer was drawn (math tokens, display blocks, LaTeX KaTeX could not draw). ENGELBART_MATH_SHOTS=<dir>
// saves a picture of the answer.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-math-smoke-'));
app.setPath('userData', path.join(root, 'electron'));
process.env.ENGELBART_HOME_DIR = root;
process.env.ENGELBART_SUMMARIES = 'off';
process.env.ENGELBART_CONNECT_OFFER = 'off';
process.env.ENGELBART_WEB_PDFS = 'off';
process.env.ENGELBART_HEADLESS = '1';
require('../src/main/index.cjs');

const pause = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, tries = 300) {
  for (let i = 0; i < tries; i++) { const result = await fn(); if (result) return result; await pause(); }
  throw new Error(`Timed out: ${label}`);
}
const js = (wc, expression) => wc.executeJavaScript(expression, true);
const ED = 'main [data-editor]';
const key = async (wc, keyCode, { ch = null, modifiers = [] } = {}) => {
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  if (ch) wc.sendInputEvent({ type: 'char', keyCode: ch, modifiers });
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await pause(30);
};
const typeKeys = async (wc, text) => { for (const ch of text) { if (ch === '\n') await key(wc, 'Enter', { ch: '\r' }); else await key(wc, ch === ' ' ? 'Space' : ch, { ch }); } await pause(150); };
const rows = (wc) => js(wc, `[...document.querySelectorAll(${JSON.stringify(`${ED} [data-line]`)})].map((d) => d.dataset.raw)`);
const QUESTION = process.env.ENGELBART_MATH_QUESTION || "What is the formula for Cohen's kappa, and what does each term mean? Keep it short.";

app.whenReady().then(async () => {
  try {
    const win = await until(() => BrowserWindow.getAllWindows()[0], 'app window');
    win.setFocusable(false);
    win.setSize(1100, 1300);
    const wc = win.webContents;
    wc.setBackgroundThrottling(false);
    await until(() => js(wc, '!!window.engelbartAPI && !!document.querySelector("button")').catch(() => false), 'app bootstrap');
    await js(wc, `window.engelbartAPI.createProjectWithWelcome({name:'Math smoke', directory:${JSON.stringify(root)}})`);
    wc.reload();
    await until(() => js(wc, `!!document.querySelector(${JSON.stringify(ED)})`).catch(() => false), 'the workspace document');
    await pause(400);
    const at = await js(wc, `(()=>{const el=document.querySelector('${ED} [data-line="0"] .t');el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return{x:Math.round(r.x+10),y:Math.round(r.y+r.height/2)}})()`);
    wc.focus(); wc.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...at }); wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...at }); await pause(150);
    await key(wc, 'A', { modifiers: ['meta'] });
    await key(wc, 'Backspace');
    await until(async () => (await rows(wc)).join('\n').trim() === '', 'an empty document');
    await typeKeys(wc, `@bart ${QUESTION}\n`);
    await until(async () => (await rows(wc)).some((line) => /^bart~> /.test(line)), 'the run starts', 200);
    await until(async () => !(await rows(wc)).some((line) => /^bart~> /.test(line)), 'the answer', 6000);
    await pause(600);
    const lines = await rows(wc);
    const drawn = await js(wc, `(()=>{const ed=document.querySelector('${ED}');return{inline:ed.querySelectorAll('[data-math]:not([data-math-block])').length - ed.querySelectorAll('[data-math-block] [data-math]').length,katex:ed.querySelectorAll('.katex').length,display:ed.querySelectorAll('.katex-display').length,blocks:ed.querySelectorAll('[data-math-block] .katex-display').length,errors:ed.querySelectorAll('[data-math-error]').length,fontLoaded:document.fonts.check('16px KaTeX_Main')}})()`);
    console.log('ANSWER LINES\n' + lines.join('\n'));
    console.log('DRAWN ' + JSON.stringify(drawn));
    const SHOTS = process.env.ENGELBART_MATH_SHOTS;
    if (SHOTS) {
      fs.mkdirSync(SHOTS, { recursive: true });
      await js(wc, `document.querySelector('${ED} [data-line="0"]').scrollIntoView({block:'start'})`);
      await pause(300);
      fs.writeFileSync(path.join(SHOTS, 'answer.png'), (await wc.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
    }
    app.exit(0);
  } catch (err) {
    console.error('FAIL', err && err.stack || err);
    app.exit(1);
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* left for macOS */ }
  }
});
