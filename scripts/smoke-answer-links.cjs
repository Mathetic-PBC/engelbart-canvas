'use strict';

// npm run build && npx electron scripts/smoke-answer-links.cjs
// Runs the real app, hidden, against disposable project/user data and the fake @discover, and checks links in answers
// (src/renderer/model/doc.js, src/renderer/workspace/DocEditor.jsx; 2026-10-12) with real (synthetic) clicks:
//  1. The link's box (padding 5px 2px, margin -5px -2px) moves no letter: a wrapped link's words, and links at a line's
//     start and end, stand where they did with the old style, and wrap where they did.
//  2. On a section link of an @discover guide (#find=…&to=…), a click on its letters, on its underline (2px below the
//     text), in the gap between a wrapped link's two lines and 2px past its last letter each open it in the Stage, and
//     the line does not become the caret's.
//  3. A click beside the link, further off, puts the caret on the line and the link is still drawn as a link.
// ENGELBART_LINK_SHOTS=<dir> saves pictures of the window.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-links-smoke-'));
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
  await pause(250);
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
const SHOTS = process.env.ENGELBART_LINK_SHOTS;
async function shot(wc, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  const picture = await wc.capturePage(undefined, { stayHidden: true, stayAwake: true });
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), picture.toPNG());
}

// The old link style, as it was before 2026-10-12.
const OLD = 'color:#0070f3;text-decoration:underline;text-underline-offset:3px';

// Where each character of each text node under `sel` is drawn, rounded to 0.01px: the text's place on the page.
const GLYPHS = (sel) => `(()=>{const out=[];const w=document.createTreeWalker(document.querySelector(${JSON.stringify(sel)}),NodeFilter.SHOW_TEXT);let n;while((n=w.nextNode())){for(let i=0;i<n.length;i++){const r=document.createRange();r.setStart(n,i);r.setEnd(n,i+1);const b=r.getClientRects()[0];if(b)out.push([n.data[i],Math.round(b.left*100)/100,Math.round(b.top*100)/100])}}return out})()`;

// Every page the app starts loading (the Stage's tabs are views of their own): what a click opened.
const navigations = [];
app.on('web-contents-created', (_event, contents) => {
  contents.on('did-start-navigation', (details, legacy) => { const url = details && details.url ? details.url : legacy; if (url) navigations.push(String(url)); });
});

app.whenReady().then(async () => {
  try {
    const { inlineHtml } = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);
    const win = await until(() => BrowserWindow.getAllWindows()[0], 'app window');
    win.setFocusable(false);
    win.setSize(1400, 900);
    const wc = win.webContents;
    wc.setBackgroundThrottling(false);
    await until(() => js(wc, '!!window.engelbartAPI && !!document.querySelector("button")').catch(() => false), 'app bootstrap');
    await js(wc, `window.engelbartAPI.createProjectWithWelcome({name:'Links smoke', directory:${JSON.stringify(root)}})`);
    wc.reload();
    await until(() => js(wc, `!!document.querySelector(${JSON.stringify(ED)})`).catch(() => false), 'the workspace document');
    await pause(400);

    /* ------------------------------------------------ 1. the link's box moves no letter */
    const samples = [
      ['a wrapped link', 'Some words before [a long section title that has to wrap onto the next line of the card](https://example.org/x#find=a&to=b) and after.', 330],
      ['a link at the start of a line', '[Start of line](https://example.org/a) then words.', 600],
      ['a link at the end of a line', 'Words then [end of line](https://example.org/b)', 600],
      ['a link ending a line that wraps', 'Words words words words words [last](https://example.org/c) next', 260],
      ['a bold title link', '**[A paper title that goes on for a while](https://example.org/p)** · Someone et al. · 2024', 300],
    ];
    for (const [label, text, width] of samples) {
      const now = inlineHtml(text), was = now.split(/style="[^"]*padding:5px 2px[^"]*"/).join(`style="${OLD}"`);
      assert.notEqual(now, was, `${label}: the old style put back`);
      const place = (html) => js(wc, `(()=>{let box=document.getElementById('link-probe');if(!box){box=document.createElement('div');box.id='link-probe';document.querySelector(${JSON.stringify(`${ED} [data-line]`)}).after(box)}box.setAttribute('style','position:relative;width:${width}px;padding:0 16px;color:#4d4d4d;font-size:16px;line-height:1.65;text-wrap:pretty');box.innerHTML=${JSON.stringify('<span class="t" style="display:block">')}+${JSON.stringify(html)}+'</span>';return true})()`);
      await place(was); const before = await js(wc, GLYPHS('#link-probe'));
      await place(now); const after = await js(wc, GLYPHS('#link-probe'));
      assert.ok(before.length > 10, `${label}: measured`);
      assert.deepEqual(after, before, `${label}: every letter where it was`);
      const lines = new Set(after.map((g) => g[2])).size;
      console.log(`PASS ${label}: ${after.length} letters on ${lines} line${lines === 1 ? '' : 's'}, each where it stood with the old style`);
    }
    await js(wc, `document.getElementById('link-probe').remove()`);

    /* ------------------------------------------------ an @discover guide */
    await press(wc, `${ED} [data-line="0"] .t`);
    await key(wc, 'A', { modifiers: ['meta'] });
    await key(wc, 'Backspace');
    await until(async () => (await rows(wc)).join('\n').trim() === '', 'an empty document');
    await typeKeys(wc, 'Reading\n@discover how do people read research papers closely\n');
    await until(async () => { const ls = await rows(wc); return !ls.some((l) => /^bart~> /.test(l)) && ls.some((l) => /#find=/.test(l)); }, 'the guide', 600);
    await pause(300);
    const all = await rows(wc);
    const links = await js(wc, `[...document.querySelectorAll(${JSON.stringify(`${ED} a[data-link]`)})].filter((a)=>/#find=/.test(a.getAttribute('href'))).map((a)=>({href:a.getAttribute('href'),text:a.textContent,line:Number(a.closest('[data-line]').dataset.line)}))`);
    assert.ok(links.length, 'the guide has section links');
    console.log(`     the guide: ${all.length} lines, section links: ${links.map((l) => `"${l.text}"`).join(', ')}`);
    await shot(wc, '1-guide');

    // The section link with words enough to wrap: its row narrowed so the link breaks across two lines.
    const target = links.find((l) => /\s/.test(l.text)) || links[0];
    const SEL = `${ED} [data-line="${target.line}"] a[data-link]`;
    const narrow = () => js(wc, `(()=>{const a=document.querySelector(${JSON.stringify(SEL)});a.scrollIntoView({block:'center'});const t=a.closest('.t');t.style.width='';const r=document.createRange();const n=a.firstChild;const sp=n.data.lastIndexOf(' ');if(sp<0)return 1;r.setStart(n,0);r.setEnd(n,sp);const end=r.getBoundingClientRect().right;t.style.width=(end-t.getBoundingClientRect().left+6)+'px';return a.getClientRects().length})()`);
    const geometry = () => js(wc, `(()=>{const a=document.querySelector(${JSON.stringify(SEL)});const rs=[...a.getClientRects()].map((r)=>({left:r.left,right:r.right,top:r.top,bottom:r.bottom}));const cs=getComputedStyle(a),pv=parseFloat(cs.paddingTop),ph=parseFloat(cs.paddingLeft);const r=document.createRange();r.selectNodeContents(a);const gl=rs.map((x,i)=>({left:x.left+(i===0?ph:0),right:x.right-(i===rs.length-1?ph:0),top:x.top+pv,bottom:x.bottom-pv}));return{rs,gl,text:[...r.getClientRects()].filter((x)=>x.width>0).map((x)=>({left:x.left,right:x.right,top:x.top,bottom:x.bottom}))}})()`);
    const state = () => js(wc, `(()=>{const row=document.querySelector(${JSON.stringify(`${ED} [data-line="${target.line}"]`)});return{active:!!row.querySelector('[data-src]'),drawn:!!row.querySelector('a[data-link]'),source:/\\]\\(https?:/.test(row.querySelector('.t').textContent)}})()`);

    // Each spot is worked out after the row is narrowed again: opening the Stage narrows the document and rewraps it.
    const SPOTS = [
      ['on its letters', ([f]) => ({ x: (f.left + f.right) / 2, y: (f.top + f.bottom) / 2 })],
      ['on its underline, 2px below the text', ([f]) => ({ x: (f.left + f.right) / 2, y: f.bottom + 2 })],
      ['in the gap between its two lines', ([f, s]) => ({ x: s.left + 8, y: (f.bottom + s.top) / 2 })],
      ['2px past its last letter', ([, s]) => ({ x: s.right + 2, y: (s.top + s.bottom) / 2 })],
      ['10px past its last letter (beside it, not on it)', ([, s]) => ({ x: s.right + 10, y: (s.top + s.bottom) / 2 })],
    ];
    const closeTabs = () => js(wc, `(()=>{for(const b of document.querySelectorAll('[data-stage-tab] button[aria-label="Close tab"]'))b.click();return true})()`);
    const results = [];
    for (const [where, at] of SPOTS) {
      await closeTabs(); await pause(200);
      navigations.length = 0;
      // Put the caret elsewhere first, on the document's title line, so each click starts from the same place.
      await press(wc, `${ED} [data-line="0"] .t`);
      assert.equal(await narrow(), 2, 'the link wraps over two lines');
      const { gl, text } = await geometry();
      const p = at(gl), x = Math.round(p.x), y = Math.round(p.y);
      const hit = await js(wc, `(()=>{const e=document.elementFromPoint(${x},${y});return e?(e.closest('a[data-link]')?'the link (its box)':e.tagName.toLowerCase()+(e.dataset&&e.dataset.line?'[data-line]':'')+(typeof e.className==='string'&&e.className?'.'+e.className:'')):'nothing'})()`);
      await click(wc, { x, y });
      await pause(400);
      const s = await state();
      const went = navigations.filter((u) => /example\.org/.test(u));
      results.push({ where, opened: went.length > 0, ...s });
      console.log(`     ${where} at (${x}, ${y}), under the pointer: ${hit}; the letters' lines: ${text.map((r) => `${Math.round(r.left)}–${Math.round(r.right)} × ${Math.round(r.top)}–${Math.round(r.bottom)}`).join(', ')}`);
      console.log(`       opened: ${went.length ? went[0] : 'nothing'}; line became the caret's: ${s.active}; link drawn as a link: ${s.drawn}; [text](url) shown: ${s.source}`);
    }
    for (const r of results.slice(0, 4)) {
      assert.equal(r.opened, true, `${r.where}: opened`);
      assert.equal(r.active, false, `${r.where}: the line is not the caret's`);
      assert.equal(r.drawn, true, `${r.where}: still a link`);
    }
    const beside = results[4];
    assert.equal(beside.opened, false, 'beside it: nothing opened');
    assert.equal(beside.active, true, 'beside it: the caret is on the line');
    assert.equal(beside.drawn, true, 'beside it: the link is still drawn as a link');
    assert.equal(beside.source, false, 'beside it: no [text](url)');
    // A second click on the link, the caret now on its line, still opens it.
    await closeTabs(); await pause(200); navigations.length = 0;
    assert.equal(await narrow(), 2);
    const again = (await geometry()).gl[0];
    await click(wc, { x: Math.round((again.left + again.right) / 2), y: Math.round((again.top + again.bottom) / 2) });
    await pause(400);
    console.log(`     the link clicked again after the click beside it: opened ${navigations.find((u) => /example\.org/.test(u)) || 'nothing'}`);
    assert.ok(navigations.some((u) => /example\.org/.test(u)), 'the next click opens it');
    await shot(wc, '2-after-clicks');
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
