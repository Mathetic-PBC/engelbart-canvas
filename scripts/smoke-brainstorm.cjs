'use strict';

// npm run build && npx electron scripts/smoke-brainstorm.cjs
// Runs the real app, hidden, against disposable project/user data and the fake agents (src/main/bart/ask.cjs fakeThink),
// and holds an @brainstorm conversation by typing (2026-10-14: prose, as Chat's): its answer is drawn as an answer, with
// no card, Skip or Wrap up; Reply opens the follow-up field, and what is typed there goes through Bart and stays with
// Brainstorm, in the same thread and session, turn after turn with no count that ends it; a wrap-up gets a summary that
// asks nothing, and the conversation goes on after it.
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
// The last answer on the page: its words, and what its foot holds.
const lastAnswer = (wc) => js(wc, `(()=>{const ls=[...document.querySelectorAll('${ED} [data-line]')];const raw=ls.map((d)=>d.dataset.raw);let end=raw.length-1;while(end>=0&&!/^bart>( |$)/.test(raw[end]))end--;let start=end;while(start>0&&/^bart>( |$)/.test(raw[start-1]))start--;const words=raw.slice(start,end+1).map((l)=>l.replace(/^bart> ?/,'')).filter((l)=>l&&!/^\\*.*\\*$/.test(l)).join('\\n');const foot=raw.slice(start,end+1).find((l)=>/^bart> \\*.*\\*$/.test(l))||'';return{words,foot,skip:!!document.querySelector('${ED} [data-act="cardskip"]'),wrap:!!document.querySelector('${ED} [data-act="cardwrap"]'),live:!!document.querySelector('${ED} [data-answers]'),reply:!!document.querySelector('${ED} [data-act="reply"]')}})()`);

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

    /* ------------------------------------------------ the first turn: prose, drawn as an answer */
    await press(wc, `${ED} [data-line="0"] .t`);
    await key(wc, 'A', { modifiers: ['meta'] });
    await key(wc, 'Backspace');
    await until(async () => (await rows(wc)).join('\n').trim() === '', 'an empty document');
    await typeKeys(wc, 'Retries loop when the lock frees.\n@brainstorm retries\n');
    await settled(wc);
    const first = await lastAnswer(wc);
    assert.match(first.words, /^FAKE BRAINSTORM on "retries" \(no earlier turns\)\./, first.words);
    assert.deepEqual([first.live, first.skip, first.wrap, first.reply], [false, false, false, true], 'no card, Skip or Wrap up; Reply on its foot');
    assert.match(first.foot, /Brainstorm/);
    await shot(wc, '1-first');
    console.log('PASS the first turn is prose, drawn as an answer, with Reply and no card controls');

    /* ------------------------------------------------ follow-ups: Reply, type, Enter; Bart keeps them with Brainstorm */
    const SAID = ['Not the backoff.', 'No, I mean the lock, not the timer.', 'Actually, forget retries: the logging worries me.', 'Who writes the logs.', 'Mostly one worker.', 'So that is the real problem.', 'Let us wrap up.', 'One more thing: it only happens at night.'];
    for (const [n, said] of SAID.entries()) {
      await press(wc, `${ED} [data-act="reply"]`);
      await press(wc, `${ED} [data-follow-input]`);
      await typeKeys(wc, `${said}\n`);
      await settled(wc);
      const got = await until(async () => { const a = await lastAnswer(wc); return a.words.includes(/wrap up/.test(said) ? 'wrap-up after' : said) ? a : null; }, `the answer to "${said}"`, 600);
      assert.ok(/^FAKE BRAINSTORM /.test(got.words) && /the same session, given the question alone/.test(got.words), `turn ${n + 2}, Brainstorm in the same session: ${got.words}`);
      assert.deepEqual([got.live, got.skip, got.wrap], [false, false, false], `turn ${n + 2}: no card controls`);
      assert.match(got.foot, /Brainstorm/, `turn ${n + 2}: answered by Brainstorm`);
      if (/wrap up/.test(said)) {
        assert.match(got.words, /^FAKE BRAINSTORM wrap-up after \d+ turns/);
        assert.ok(!got.words.includes('?'), 'a wrap-up asks nothing');
        await shot(wc, '2-wrap-up');
      } else assert.ok(got.words.endsWith('?'), got.words);
      console.log(`PASS turn ${n + 2}: ${JSON.stringify(got.words.split('\n')[0])}`);
    }
    const ls = await rows(wc);
    assert.equal(ls.filter((l) => /^@brainstorm /.test(l)).length, 1, 'one @brainstorm line opened it');
    assert.equal(ls.filter((l) => /^@bart /.test(l)).length, SAID.length, 'each follow-up a line of its own, routed through Bart');
    await shot(wc, '3-after');
    console.log(`PASS ${SAID.length + 1} turns in one conversation, the wrap-up and a turn after it`);
    app.exit(0);
  } catch (error) {
    console.error(error);
    try { const wc = BrowserWindow.getAllWindows()[0].webContents; console.error('The document then:', JSON.stringify(await rows(wc))); } catch { /* none */ }
    app.exit(1);
  }
});
