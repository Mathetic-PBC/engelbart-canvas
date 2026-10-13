'use strict';

// npm run build && npx electron scripts/smoke-brainstorm.cjs
// Runs the real app, hidden, against disposable project/user data and the fake agents (src/main/bart/ask.cjs), and drives
// an @brainstorm exchange by typing (2026-10-13: a card drawn as any answer is): its card has no box, field or Submit of its
// own, its foot has Skip and Wrap up, and the follow-up field under it answers it; a row clicked (or words typed) is the
// answer, read back on the line under the card as said, and the turn before it collapses.
// ENGELBART_BRAINSTORM_SHOTS=<dir> saves pictures of the window.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-brainstorm-smoke-'));
app.setPath('userData', path.join(root, 'electron'));
process.env.ENGELBART_HOME_DIR = root;
process.env.ENGELBART_SUMMARIES = 'off';
process.env.ENGELBART_CONNECT_OFFER = 'off';
process.env.ENGELBART_TOOLS = 'off';
process.env.ENGELBART_WEB_PDFS = 'off';
process.env.ENGELBART_BART_FAKE = '1';
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
const settled = async (wc) => until(async () => !(await rows(wc)).some((line) => /^bart~> /.test(line)), 'the answers', 600);
const SHOTS = process.env.ENGELBART_BRAINSTORM_SHOTS;
async function shot(wc, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  const picture = await wc.capturePage(undefined, { stayHidden: true, stayAwake: true });
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), picture.toPNG());
}
// The last live card: its question line, whether it has rows to click, and whether anything of the old card is drawn.
const live = (wc) => js(wc, `(()=>{const f=[...document.querySelectorAll('${ED} [data-answers]')].pop();if(!f)return null;const q=f.dataset.answers,c=document.querySelector('${ED} [data-card="'+q+'"]');return{q:Number(q),rows:c?c.querySelectorAll('[data-act="cardopt"]').length:0,old:!!document.querySelector('${ED} [data-card-box], ${ED} [data-card-input], ${ED} .bs-submit'),skip:!!document.querySelector('${ED} [data-foot="'+q+'"] [data-act="cardskip"]'),wrap:!!document.querySelector('${ED} [data-foot="'+q+'"] [data-act="cardwrap"]'),rule:c?getComputedStyle(c.firstElementChild).borderLeftWidth:null}})()`);

app.whenReady().then(async () => {
  try {
    const win = await until(() => BrowserWindow.getAllWindows()[0], 'app window');
    win.setFocusable(false);
    const wc = win.webContents;
    wc.setBackgroundThrottling(false);
    await until(() => js(wc, '!!window.engelbartAPI && !!document.querySelector("button")').catch(() => false), 'app bootstrap');
    await js(wc, `window.engelbartAPI.createProjectWithWelcome({name:'Brainstorm smoke', directory:${JSON.stringify(root)}})`);
    wc.reload();
    await until(() => js(wc, `!!document.querySelector(${JSON.stringify(ED)})`).catch(() => false), 'the workspace document');
    await pause(400);

    /* ------------------------------------------------ the first card: drawn as an answer, answered under it */
    await press(wc, `${ED} [data-line="0"] .t`);
    await key(wc, 'A', { modifiers: ['meta'] });
    await key(wc, 'Backspace');
    await until(async () => (await rows(wc)).join('\n').trim() === '', 'an empty document');
    await typeKeys(wc, 'Retries loop when the lock frees.\n@brainstorm retries\n');
    await settled(wc);
    const first = await until(() => live(wc), 'the live card');
    assert.equal(first.old, false, 'no box, field or Submit of the old card');
    assert.equal(first.rule, '2px', 'inside an answer\'s rule');
    assert.deepEqual([first.skip, first.wrap], [true, true], 'Skip and Wrap up on its foot');
    await shot(wc, '1-card');
    console.log(`PASS the first card is drawn as an answer (${first.rows} rows to click), Skip and Wrap up on its foot, the field under it`);

    if (first.rows) await press(wc, `${ED} [data-card="${first.q}"] [data-act="cardopt"]`);
    else { await press(wc, `${ED} [data-follow-input]`); await typeKeys(wc, 'when two workers race\n'); }
    await settled(wc);
    const ls = await rows(wc), answered = ls.findIndex((l, i) => i > first.q && /^@brainstorm /.test(l));
    assert.ok(answered > first.q, `the answer under the card: ${JSON.stringify(ls)}`);
    const said = await js(wc, `document.querySelector('${ED} [data-line="${answered}"] .t').innerText`);
    assert.ok(!/picked|"/.test(said), `read as said: ${said}`);
    assert.ok(ls.slice(first.q + 1, answered).some((l) => /^bart\+> /.test(l)), 'the card\'s turn collapsed');
    await shot(wc, '2-answered');
    console.log(`PASS answered (${JSON.stringify(said)}), read back as said, the card before it collapsed`);

    /* ------------------------------------------------ Skip, on the next card's foot */
    const second = await until(() => live(wc), 'the next card');
    await press(wc, `${ED} [data-foot="${second.q}"] [data-act="cardskip"]`);
    await settled(wc);
    const after = await rows(wc);
    assert.ok(after.includes('@brainstorm (skipped)'), JSON.stringify(after.slice(-8)));
    await shot(wc, '3-skipped');
    console.log('PASS Skip on the foot answers the card with (skipped)');

    /* ------------------------------------------------ a choice: its options a list of rows, one clicked answers */
    // An @brainstorm line with nothing after it, in a workspace with something in it: the fake asks a focus card of areas.
    const end = (await rows(wc)).length - 1;
    await press(wc, `${ED} [data-line="${end}"]`);
    await typeKeys(wc, '\n@brainstorm\n'); // Enter picks Brainstorm in the @ menu,
    await typeKeys(wc, '\n'); // and asks it
    await settled(wc);
    const choice = await until(async () => { const c = await live(wc); return c && c.rows ? c : null; }, 'a card with rows to click');
    const look = await js(wc, `(()=>{const r=document.querySelector('${ED} [data-card="${choice.q}"] .bs-row');const s=getComputedStyle(r);return{border:s.borderTopWidth,bg:s.backgroundColor,mark:r.querySelector('.bs-mark').textContent}})()`);
    assert.deepEqual(look, { border: '0px', bg: 'rgba(0, 0, 0, 0)', mark: '•' }, 'a row of a list, not a boxed option');
    const label = await js(wc, `document.querySelector('${ED} [data-card="${choice.q}"] .bs-row .bs-label').innerText`);
    await shot(wc, '4-choice');
    await press(wc, `${ED} [data-card="${choice.q}"] [data-act="cardopt"]`);
    await settled(wc);
    const picked = await rows(wc);
    assert.ok(picked.includes(`@brainstorm picked "${label}"`), JSON.stringify(picked.slice(-8)));
    await shot(wc, '5-picked');
    console.log(`PASS a choice card's options are a list; a row clicked answers it (${label})`);
    app.exit(0);
  } catch (error) {
    console.error(error);
    try { const wc = BrowserWindow.getAllWindows()[0].webContents; console.error('The document then:', JSON.stringify(await rows(wc))); } catch { /* none */ }
    app.exit(1);
  }
});
