'use strict';

// npx electron scripts/smoke-stream-scroll.cjs
// The real DocEditor (src/renderer/workspace/DocEditor.jsx), bundled on its own into a hidden window with props this
// script sets, checked with the browser's own layout (2026-10-13: streaming answers and follow-ups don't move what you're
// looking at):
//  1. A pending row with 40 lines of answer so far is no taller than its box's cap (min(240px, 35vh)) plus its activity
//     row, and the box is at its bottom after an update.
//  2. Scrolled up inside the box by more than 40px, the next update keeps that place; scrolled back down, it follows again.
//  3. The caret on a line under a pending row: an update that adds lines leaves that line's top where it was, and so does
//     the answer landing; the caret is still on that line, and typing there goes into it.
//  4. The caret above the pending row: the pane's scrollTop does not change on an update.
//  5. A Brainstorm pending row has no box.
//  6. A conversation whose last answer is 30 lines: a follow-up sent from its reply field (routed, sent straight, and an
//     empty send on a Brainstorm field) puts the question's row where the field was, and the earlier turns are folded.
// ENGELBART_STREAM_SHOTS=<dir> saves pictures of the window.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { replyLines } = require('../src/main/bart/reply.cjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-stream-smoke-'));
app.setPath('userData', path.join(dir, 'electron'));

// The editor and a stand-in for the workspace around it: props kept here, drawn again on every change, as Workspace does.
const ENTRY = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import DocEditor from './DocEditor.jsx';
const ref = React.createRef();
let props = {}, root = null;
const draw = () => root.render(<div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column' }}><DocEditor ref={ref} {...props} /></div>);
window.H = {
  asked: [], routed: [],
  mount(p) {
    H.asked = []; H.routed = [];
    props = { docKey: 'k' + Math.random(), asks: {}, onChange: (text) => { props = { ...props, text }; draw(); }, onAsk: (a) => H.asked.push(a), ...p };
    if (p.route) props.onRoute = (r) => { H.routed.push(r); return Promise.resolve({ agent: 'bart', sure: 1, by: 'rule' }); };
    root = root || createRoot(document.getElementById('root'));
    draw();
  },
  set(p) { props = { ...props, ...p }; draw(); },
  text: () => props.text,
  editor: () => ref.current,
};
`;
const bundle = buildSync({
  stdin: { contents: ENTRY, resolveDir: path.join(__dirname, '../src/renderer/workspace'), loader: 'jsx', sourcefile: 'harness.jsx' },
  bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', write: false, logLevel: 'silent',
  loader: { '.js': 'jsx', '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' },
});
fs.writeFileSync(path.join(dir, 'harness.js'), bundle.outputFiles[0].text);
fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html><meta charset="utf-8"><style>:root{--font-sans:-apple-system,BlinkMacSystemFont,sans-serif;--font-mono:Menlo,monospace}body{margin:0}@keyframes thinking{0%,100%{opacity:.4}50%{opacity:1}}</style><div id="root"></div><script src="harness.js"></script>`);

const pause = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
let wc = null;
const js = (expression) => wc.executeJavaScript(expression, true);
const SHOTS = process.env.ENGELBART_STREAM_SHOTS;
async function shot(name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), (await wc.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
}
const results = [];
const pass = (label, detail = '') => { results.push(label); console.log(`PASS ${label}${detail ? ` (${detail})` : ''}`); };

const ED = '[data-editor]';
const ANSWER = (n, word = 'Line') => Array.from({ length: n }, (_, k) => `${word} ${k + 1} of the answer so far, long enough to read as a sentence.`);
const asking = (lines, agent = 'bart') => ({ A1: { askId: 'A1', agent, activity: 'Writing', name: 'Sonnet', effort: 'high', log: ['Reading notes.md'], lines } });
const PARAS = Array.from({ length: 24 }, (_, k) => `Paragraph ${k + 1} above the question, there to give the page something to scroll.`);
const mount = async (lines, props = {}) => { await js(`H.mount(${JSON.stringify({ text: lines.join('\n'), ...props })})`); await pause(150); };
const setAsks = async (asks) => { await js(`H.set({ asks: ${JSON.stringify(asks)} })`); await pause(80); };
const setText = async (lines) => { await js(`H.set({ text: ${JSON.stringify(lines.join('\n'))} })`); await pause(120); };
const box = (id = 'A1') => js(`(()=>{const b=document.querySelector('[data-stream="${id}"]');return b?{top:b.scrollTop,height:b.scrollHeight,client:b.clientHeight}:null})()`);
const topOf = (raw) => js(`(()=>{const d=[...document.querySelectorAll('${ED} [data-line]')].find((d)=>d.dataset.raw===${JSON.stringify(raw)});return d?d.getBoundingClientRect().top:null})()`);
const pane = () => js(`document.querySelector('${ED}').closest('[style*="overflow: auto"]').scrollTop`);
const scrollPane = (top) => js(`document.querySelector('${ED}').closest('[style*="overflow: auto"]').scrollTop=${top}`);
// The pane scrolled so the row holding `raw` has its top `y` px from the window's top.
const bring = async (raw, y) => { await js(`(()=>{const p=document.querySelector('${ED}').closest('[style*="overflow: auto"]');const d=[...p.querySelectorAll('[data-line]')].find((d)=>d.dataset.raw===${JSON.stringify(raw)});p.scrollTop+=d.getBoundingClientRect().top-${y};return true})()`); await pause(80); };
// The caret put in the row holding `raw`, at the end of its text, the editor focused, as a click there leaves it.
const caretIn = async (raw) => {
  await js(`(()=>{const ed=document.querySelector('${ED}');ed.focus({preventScroll:true});const d=[...ed.querySelectorAll('[data-line]')].find((d)=>d.dataset.raw===${JSON.stringify(raw)});const t=d.querySelector('.t');const r=document.createRange();r.selectNodeContents(t);r.collapse(false);const s=getSelection();s.removeAllRanges();s.addRange(r);return true})()`);
  await pause(120);
};
const caretRaw = () => js(`(()=>{const s=getSelection();if(!s.rangeCount)return null;const n=s.anchorNode;const el=n.nodeType===1?n:n.parentElement;const d=el&&el.closest('[data-line]');return d?d.dataset.raw:null})()`);
const typeKeys = async (text) => { for (const ch of text) { wc.sendInputEvent({ type: 'char', keyCode: ch }); await pause(20); } await pause(120); };
const near = (a, b, label) => assert.ok(Math.abs(a - b) <= 1, `${label}: ${a} vs ${b}`);

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ width: 1100, height: 800, show: false, paintWhenInitiallyHidden: true, webPreferences: { backgroundThrottling: false } });
    wc = win.webContents;
    await win.loadFile(path.join(dir, 'index.html'));
    await pause(200);
    const Q = '@chat explain the method';
    const doc = (below = 'The line I am writing under the card') => [...PARAS, Q, 'bart~> A1', below, ''];

    /* ------------------------------------------------ 1. the box is capped and follows the newest line */
    await mount(doc(), { asks: asking(ANSWER(40)) });
    const cap = await js('Math.min(240, innerHeight * 0.35)');
    const sizes = await js(`(()=>{const d=document.querySelector('[data-pending="A1"]');const b=d.querySelector('[data-stream]');const act=d.lastElementChild;const cs=getComputedStyle(d);return{row:d.getBoundingClientRect().height,box:b.getBoundingClientRect().height,act:act.getBoundingClientRect().height,pad:parseFloat(cs.paddingTop)+parseFloat(cs.paddingBottom),actOutside:!b.contains(act)}})()`);
    assert.ok(sizes.actOutside, 'the activity row is outside the box');
    assert.ok(sizes.box <= cap + 0.5, `the box is capped: ${sizes.box} > ${cap}`);
    assert.ok(sizes.row <= cap + sizes.act + sizes.pad + 0.5, `the row is the cap plus its activity row: ${JSON.stringify(sizes)}`);
    await setAsks(asking(ANSWER(41)));
    let b = await box();
    near(b.top + b.client, b.height, 'at the bottom after an update');
    pass('1. a pending row with 40 lines is no taller than the cap plus its activity row; its box is at the bottom after an update', `row ${Math.round(sizes.row)}px, cap ${cap}px`);
    await shot('1-capped');

    /* ------------------------------------------------ 2. scrolled up, it stays; back at the bottom, it follows */
    const up = b.height - b.client - 120;
    await js(`document.querySelector('[data-stream="A1"]').scrollTop=${up}`); await pause(80);
    await setAsks(asking(ANSWER(42)));
    b = await box();
    near(b.top, up, 'the next update keeps the place scrolled to');
    await setAsks(asking(ANSWER(43)));
    near((await box()).top, up, 'and the one after');
    await js(`(()=>{const b=document.querySelector('[data-stream="A1"]');b.scrollTop=b.scrollHeight;return true})()`); await pause(80);
    await setAsks(asking(ANSWER(44)));
    b = await box();
    near(b.top + b.client, b.height, 'following again');
    pass('2. scrolled up by more than 40px the next update keeps that scrollTop; scrolled back to the bottom it follows again');

    /* ------------------------------------------------ 3. the caret's line under the row stays where it is */
    const BELOW = 'The line I am writing under the card';
    await mount(doc(BELOW), { asks: asking(ANSWER(2)) });
    await bring(BELOW, 420);
    await caretIn(BELOW);
    assert.equal(await caretRaw(), BELOW, 'the caret is on the line under the card');
    let before = await topOf(BELOW), paneBefore = await pane();
    for (const n of [4, 6, 9, 14]) await setAsks(asking(ANSWER(n)));
    near(await topOf(BELOW), before, 'the caret\'s line after updates that add lines');
    assert.ok(await pane() > paneBefore, 'the pane scrolled with the growing card');
    await typeKeys(' more');
    const typed = `${BELOW} more`;
    assert.ok((await js('H.text()')).split('\n').includes(typed), 'typing went into the line');
    before = await topOf(typed);
    await setAsks(asking(ANSWER(16)));
    near(await topOf(typed), before, 'the caret\'s line after typing and another update');
    // The answer lands: the pending line becomes the answer's lines (main writes them; here the text is set the same way).
    const landed = doc(typed).flatMap((l) => (l === 'bart~> A1' ? replyLines(ANSWER(16).join('\n'), { level: { name: 'Sonnet', effort: 'high' }, trail: [], ms: 4000 }, { agent: 'bart' }) : [l]));
    await js(`H.set({ text: ${JSON.stringify(landed.join('\n'))}, asks: {} })`); await pause(200);
    near(await topOf(typed), before, 'the caret\'s line when the answer lands');
    assert.equal(await caretRaw(), typed, 'the caret is still on its line once the answer has landed');
    await typeKeys('!');
    assert.ok((await js('H.text()')).split('\n').includes(`${typed}!`), 'typing after the answer landed goes into the same line');
    pass('3. with the caret on a line under a pending row, updates and the answer landing leave that line\'s top unchanged');
    await shot('3-landed');

    /* ------------------------------------------------ 4. the caret above the row: the pane does not move */
    await mount(doc(BELOW), { asks: asking(ANSWER(2)) });
    await bring(BELOW, 420);
    await caretIn(PARAS[23]);
    const still = await pane();
    for (const n of [4, 7, 10]) await setAsks(asking(ANSWER(n)));
    assert.equal(await pane(), still, 'scrollTop is unchanged with the caret above');
    await js(`document.querySelector('${ED}').blur()`); await pause(60);
    for (const n of [12, 14]) await setAsks(asking(ANSWER(n)));
    assert.equal(await pane(), still, 'and with the editor not focused');
    pass('4. with the caret above the pending row, or no focus, the pane\'s scrollTop does not change on an update');

    /* ------------------------------------------------ 5. Brainstorm: no box */
    await mount([...PARAS, '@brainstorm', 'bart~> A1', ''], { asks: asking(['{"say":"x",'], 'brainstorm') });
    assert.equal(await js(`!!document.querySelector('[data-pending="A1"]')`), true);
    assert.equal(await box(), null, 'no stream box');
    pass('5. a Brainstorm pending row has no stream box');

    /* ------------------------------------------------ 6. a follow-up sent from the reply field stays where it was typed */
    const turn = (q, n, agent = 'bart') => [q, ...replyLines(ANSWER(n, `${q.slice(1, 6)} answer`).join('\n'), { level: { name: 'Sonnet', effort: 'high' }, trail: [], ms: 3000 }, { agent, model: agent === 'bart' })];
    const convo = (agent = 'bart', lead = '@chat') => [...PARAS, ...turn(`${lead} first question`, 6, agent), ...turn(`${lead} second question`, 30, agent), ''];
    const cases = [
      { label: 'typed, routed through Bart', lines: convo(), route: true, typed: 'and then what?', want: '@bart and then what?' },
      { label: 'typed, sent straight', lines: convo(), route: false, typed: 'and then what?', want: '@chat and then what?' },
      { label: 'empty, on a Brainstorm field', lines: convo('brainstorm', '@brainstorm'), route: true, typed: '', want: '@brainstorm' },
    ];
    for (const c of cases) {
      await mount(c.lines, { route: c.route });
      await js(`(()=>{document.querySelector('[data-act="reply"]').click();return true})()`); // the field is shut until Reply (2026-10-13)
      await pause(100);
      // The field brought to the lower part of the pane, as after reading the long answer down to it.
      const field = await js(`(()=>{const f=document.querySelector('[data-follow-input]');const p=f.closest('[style*="overflow: auto"]');p.scrollTop+=f.getBoundingClientRect().top-p.getBoundingClientRect().top-p.clientHeight*0.7;return{top:f.getBoundingClientRect().top,from:f.dataset.followInput}})()`);
      await pause(100);
      const fieldTop = await js(`document.querySelector('[data-follow-input]').getBoundingClientRect().top`);
      await js(`(()=>{const f=document.querySelector('[data-follow-input]');f.focus();f.value=${JSON.stringify(c.typed)};f.dispatchEvent(new InputEvent('input',{bubbles:true}));return true})()`);
      await pause(60);
      await js(`(()=>{const f=document.querySelector('[data-follow-input]');f.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));return true})()`);
      await pause(300);
      const ls = (await js('H.text()')).split('\n');
      const q = ls.indexOf(c.want);
      assert.ok(q > 0, `${c.label}: the question is in the document (${JSON.stringify(ls.slice(-6))})`);
      const rowTop = await js(`document.querySelector('${ED} [data-line="${q}"]').getBoundingClientRect().top`);
      near(rowTop, fieldTop, `${c.label}: the question's row where the field was`);
      assert.ok(ls.some((l) => l.startsWith('bart+> ')), `${c.label}: the earlier turns are folded`);
      assert.ok(!ls.some((l) => l.startsWith('bart> ')), `${c.label}: no answer is left open`);
      pass(`6. a follow-up ${c.label} from under a 30-line answer: the question's row is where the field was, the turns folded`, `field ${Math.round(field.top)}px`);
      await shot(`6-${c.label.split(',')[0]}`);
    }
    // Sent with the field off screen, the pane is left as it is.
    await mount(convo(), { route: false });
    await js(`(()=>{document.querySelector('[data-act="reply"]').click();return true})()`); // the field is shut until Reply (2026-10-13)
    await pause(100);
    await scrollPane(0); await pause(80);
    const off = await js(`(()=>{const f=document.querySelector('[data-follow-input]');const p=f.closest('[style*="overflow: auto"]');return f.getBoundingClientRect().top>p.getBoundingClientRect().bottom})()`);
    assert.ok(off, 'the field is below the pane');
    await js(`(()=>{const f=document.querySelector('[data-follow-input]');f.value='later';f.dispatchEvent(new InputEvent('input',{bubbles:true}));f.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));return true})()`);
    await pause(300);
    assert.equal(await pane(), 0, 'the pane did not scroll');
    pass('6. a follow-up sent with its field off screen leaves the scroll as it was');

    console.log(`\n${results.length} checks passed`);
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* left for macOS */ }
  }
});
