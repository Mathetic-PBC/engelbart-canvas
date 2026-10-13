'use strict';

// npm run build && npx electron scripts/smoke-research.cjs
// Runs the real app, hidden, against disposable project/user data and the fake agents (src/main/bart/ask.cjs and
// route.cjs), and drives @discover's research box (2026-10-13; DocEditor splitsDiscover) by typing: an @discover question
// is answered by Chat's reply, closing as Discover's, with the search in a box of its own under it; a reply asking about
// it goes to Chat, with no new box; a reply asking for other papers refines the search in a second box.
// ENGELBART_RESEARCH_SHOTS=<dir> saves pictures of the window.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-research-smoke-'));
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
const settled = async (wc) => until(async () => !(await rows(wc)).some((line) => /^bart~> /.test(line)), 'the answers', 600);
const SHOTS = process.env.ENGELBART_RESEARCH_SHOTS;
async function shot(wc, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  const picture = await wc.capturePage(undefined, { stayHidden: true, stayAwake: true });
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), picture.toPNG());
}
const reply = async (wc, text) => {
  await press(wc, `${ED} [data-follow-input]`);
  await typeKeys(wc, `${text}\n`);
};

app.whenReady().then(async () => {
  try {
    const win = await until(() => BrowserWindow.getAllWindows()[0], 'app window');
    win.setFocusable(false);
    const wc = win.webContents;
    wc.setBackgroundThrottling(false);
    await until(() => js(wc, '!!window.engelbartAPI && !!document.querySelector("button")').catch(() => false), 'app bootstrap');
    await js(wc, `window.engelbartAPI.createProjectWithWelcome({name:'Research smoke', directory:${JSON.stringify(root)}})`);
    wc.reload();
    await until(() => js(wc, `!!document.querySelector(${JSON.stringify(ED)})`).catch(() => false), 'the workspace document');
    await pause(400);

    /* ------------------------------------------------ an @discover question: the reply, then the box */
    await press(wc, `${ED} [data-line="0"] .t`);
    await key(wc, 'A', { modifiers: ['meta'] });
    await key(wc, 'Backspace');
    await until(async () => (await rows(wc)).join('\n').trim() === '', 'an empty document');
    await typeKeys(wc, 'Notes\n@discover how do tutors notice struggle\n');
    const asked = await until(async () => { const ls = await rows(wc); return ls.some((l) => l === '@discover --research how do tutors notice struggle') ? ls : null; }, 'the research line, asked with the reply');
    await shot(wc, '1-asked');
    await settled(wc);
    const ls = await rows(wc);
    const q = ls.indexOf('@discover how do tutors notice struggle'), box = ls.indexOf('@discover --research how do tutors notice struggle');
    assert.ok(q > 0 && box > q, `the box under the reply: ${JSON.stringify(asked)}`);
    assert.match(ls[q - 1], /^bart# \[discover /, 'one title, the conversation Discover\'s');
    assert.equal(ls[q + 1], 'bart> FAKE INTRO to "how do tutors notice struggle": Discover is looking for what to read on it.');
    assert.match(ls[box - 1], /^bart> \*Discover · /, 'the reply closes as Discover\'s');
    assert.ok(ls.slice(box + 1).some((l) => /^bart> ## /.test(l)), 'the guide is in the box');
    const head = await js(wc, `(()=>{const h=document.querySelector('${ED} [data-research]');return h?{text:h.innerText.replace(/\\s+/g,' ').trim(),editable:h.getAttribute('contenteditable'),radius:getComputedStyle(h).borderTopLeftRadius}:null})()`);
    assert.deepEqual(head, { text: 'Research · Standard', editable: 'false', radius: '10px' });
    await shot(wc, '2-answered');
    console.log('PASS an @discover question is the reply, closing as Discover\'s, and the search in a box of its own under it');

    /* ------------------------------------------------ a reply about it is Chat's: no new box */
    await reply(wc, 'which one is the most cited');
    await settled(wc);
    const after = await rows(wc);
    assert.equal(after.filter((l) => l.includes('--research')).length, 1, 'still one box');
    assert.ok(after.some((l) => l === '@bart which one is the most cited'));
    assert.match(after[after.indexOf('@bart which one is the most cited') + 1], /^bart> FAKE ANSWER/);
    console.log('PASS a reply asking about it goes to Chat, with no new search');

    /* ------------------------------------------------ a reply asking for other papers refines the search */
    await reply(wc, 'find papers on K-12 only');
    await settled(wc);
    const refined = await rows(wc);
    assert.ok(refined.includes('@discover --research find papers on K-12 only'), JSON.stringify(refined.slice(-12)));
    const heads = await js(wc, `[...document.querySelectorAll('${ED} [data-research]')].map((h)=>h.innerText.replace(/\\s+/g,' ').trim())`);
    assert.deepEqual(heads, ['Research · Standard', 'Research · Standard · find papers on K-12 only']);
    const collapsed = await js(wc, `[...document.querySelectorAll('${ED} [data-line]')].filter((d)=>/^bart\\+> /.test(d.dataset.raw)).length`);
    assert.ok(collapsed > 0, 'the turns before the reply collapsed');
    await shot(wc, '3-refined');
    console.log('PASS a reply asking for other papers refines the search in a second box, the turns before it collapsed');

    /* ------------------------------------------------ a Build Bart picks: Chat's reply, then the Build's card under it */
    // At the end of the document: an answer with a fenced block (the fake's answer to a question about code), then "ok build it".
    const before = await rows(wc);
    await press(wc, `${ED} [data-line="${before.length - 1}"]`);
    await typeKeys(wc, '\n@chat show the code config\n');
    await settled(wc);
    const spec = await rows(wc);
    assert.ok(spec.some((l) => l === 'bart> ```json'), `a fenced block to build: ${JSON.stringify(spec)}`);
    const end = spec.length - 1;
    await press(wc, `${ED} [data-line="${end}"]`);
    await typeKeys(wc, '@bart ok build it\n');
    await until(async () => (await rows(wc)).some((l) => /^build> /.test(l)), 'the Build\'s card', 600);
    await settled(wc);
    const built = await rows(wc), line = built.indexOf('@bart ok build it'), card = built.findIndex((l) => /^build> /.test(l));
    assert.equal(built[line + 1], 'bart> FAKE INTRO to "ok build it": Build is making the spec above.', JSON.stringify(built.slice(line)));
    assert.match(built[card - 1], /^bart> \*Build · /, 'the reply closes as Build\'s, right above the card');
    const from = built.indexOf('@chat show the code config');
    assert.equal(await js(wc, `document.querySelectorAll('${ED} [data-followup="${from}"]').length`), 0, 'no follow-up field over the card');
    assert.ok(await js(wc, `document.querySelectorAll('${ED} [data-followup]').length`) > 0, 'the conversation above keeps its own');
    await shot(wc, '4-build');
    console.log('PASS a Build Bart picks is Chat\'s reply first, closing as Build\'s, with the Build\'s card under it');
    app.exit(0);
  } catch (error) {
    console.error(error);
    try { const wc = BrowserWindow.getAllWindows()[0].webContents; console.error('The document then:', JSON.stringify(await rows(wc))); } catch { /* none */ }
    app.exit(1);
  }
});
