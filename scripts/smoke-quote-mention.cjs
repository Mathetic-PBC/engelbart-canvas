'use strict';

// npm run build && npx electron scripts/smoke-quote-mention.cjs
// Runs the real app, hidden, against disposable data, and types with real key events (2026-10-16):
//  1. The @ menu offers the whole library: this workspace's note first, then another project's; a name of several words
//     is narrowed to with spaces typed. A note of another project, mentioned, draws as a chip, shows its card on hover,
//     goes to @bart with its text (expand-mentions), opens beside the document and saves into its own project.
//  2. A quote is edited like any line: `>` typed keeps the caret on its line, a paste right after it (no space) makes
//     `> pasted`, typing, Backspace at the start of its text making it plain, and a pasted quote of several lines; the
//     document on disk holds the lines as typed and they draw as quotes again after a reload.
// ENGELBART_QUOTE_SHOTS=<dir> saves pictures of the window.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-quote-smoke-'));
app.setPath('userData', path.join(root, 'electron'));
process.env.ENGELBART_HOME_DIR = root;
process.env.ENGELBART_SUMMARIES = 'off';
process.env.ENGELBART_CONNECT_OFFER = 'off';
process.env.ENGELBART_TOOLS = 'off';
process.env.ENGELBART_WEB_PDFS = 'off';
process.env.ENGELBART_BART_FAKE = '1';
process.env.ENGELBART_BUILD_FAKE = '1';
process.env.ENGELBART_HEADLESS = '1';
for (const dir of ['here', 'elsewhere']) fs.mkdirSync(path.join(root, dir));
require('../src/main/index.cjs');
const db = require('../src/main/store/db.cjs');
const { ensureHome } = require('../src/main/store/home.cjs');
const { expandDoc } = require('../src/main/context/expand-mentions.cjs');

const pause = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, tries = 300) {
  for (let i = 0; i < tries; i++) { const result = await fn(); if (result) return result; await pause(); }
  throw new Error(`Timed out: ${label}`);
}
const js = (wc, expression) => wc.executeJavaScript(expression, true);
const ED = 'main [data-doc-pane="0"] [data-editor]';
const key = async (wc, keyCode, { ch = null, modifiers = [] } = {}) => {
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  if (ch) wc.sendInputEvent({ type: 'char', keyCode: ch, modifiers });
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await pause(40);
};
// One key at a time, as a person types: a line that redraws under the caret shows here, not in a bulk insert.
const typeKeys = async (wc, text) => { for (const ch of text) { if (ch === '\n') await key(wc, 'Enter', { ch: '\r' }); else await key(wc, ch === ' ' ? 'Space' : ch, { ch }); } await pause(150); };
const rows = (wc, ed = ED) => js(wc, `[...document.querySelectorAll(${JSON.stringify(`${ed} [data-line]`)})].map((d) => d.dataset.raw)`);
const click = async (wc, { x, y }) => {
  wc.focus();
  await pause();
  wc.sendInputEvent({ type: 'mouseMove', x, y });
  wc.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x, y });
  wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x, y });
  await pause(250);
};
const spot = (wc, selector, dx = 40) => js(wc, `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return{x:Math.round(r.x+Math.max(4,Math.min(r.width-2,${dx}))),y:Math.round(r.y+r.height/2)}})()`);
// The clipboard is not touched (it is the person's): a paste event carrying text/plain, as ⌘V gives the editor.
const paste = (wc, text) => js(wc, `(()=>{const dt=new DataTransfer();dt.setData('text/plain',${JSON.stringify(text)});document.activeElement.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));return true})()`);
const menu = (wc) => js(wc, `[...document.querySelectorAll('[data-mention-row]')].map((r)=>r.textContent)`);
const caretLine = (wc) => js(wc, `(()=>{const s=getSelection();if(!s.rangeCount)return null;const n=s.anchorNode;const el=n.nodeType===1?n:n.parentElement;const d=el&&el.closest('[data-line]');return d&&el.closest(${JSON.stringify(ED)})?Number(d.dataset.line):null})()`);
const SHOTS = process.env.ENGELBART_QUOTE_SHOTS;
async function shot(wc, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  const picture = await wc.capturePage(undefined, { stayHidden: true, stayAwake: true });
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), picture.toPNG());
}
const pass = (what) => console.log(`PASS ${what}`);

app.whenReady().then(async () => {
  try {
    const win = await until(() => BrowserWindow.getAllWindows()[0], 'app window');
    win.setFocusable(false);
    win.setSize(1400, 900);
    const wc = win.webContents;
    wc.setBackgroundThrottling(false);
    await until(() => js(wc, '!!window.engelbartAPI && !!document.querySelector("button")').catch(() => false), 'app bootstrap');
    const api = (call) => js(wc, `window.engelbartAPI.${call}`);
    const there = await api(`createProjectWithWelcome({name:'Elsewhere', directory:${JSON.stringify(path.join(root, 'elsewhere'))}})`);
    const far = await api(`createNote(${JSON.stringify(there.project.id)}, {name:'Zebra elsewhere note'})`);
    await api(`createNote(${JSON.stringify(there.project.id)}, {name:'Meeting with David'})`);
    await api(`createNote(${JSON.stringify(there.project.id)}, {name:'Meeting with Amir'})`);
    await api(`writeDoc(${JSON.stringify(there.project.id)}, {kind:'note', id:${JSON.stringify(far.id)}}, 'words from elsewhere\\n')`);
    const here = await api(`createProjectWithWelcome({name:'Here', directory:${JSON.stringify(path.join(root, 'here'))}})`);
    await api(`createNote(${JSON.stringify(here.project.id)}, {name:'Zebra here', workspaceId:${JSON.stringify(here.workspaceId)}})`);
    wc.reload();
    await until(() => js(wc, `!!document.querySelector(${JSON.stringify(ED)})`).catch(() => false), 'the workspace document');
    await pause(600);
    const last = async () => (await rows(wc)).length - 1;
    await click(wc, await spot(wc, `${ED} [data-line="${await last()}"]`));
    await pause(50);
    await key(wc, 'End');

    /* ------------------------------------------------ 1. the whole library in the @ menu */
    await typeKeys(wc, '@Zeb');
    await until(async () => (await menu(wc)).length, 'the @ menu');
    assert.deepEqual(await menu(wc), ['Zebra here', 'Zebra elsewhere note'], 'this workspace\'s note first, then another project\'s');
    pass('@Zeb: this workspace\'s note first, then the other project\'s');
    for (let k = 0; k < 4; k++) await key(wc, 'Backspace');
    await typeKeys(wc, '@Meeting with A');
    assert.deepEqual(await menu(wc), ['Meeting with Amir'], 'spaces typed narrow to the one name');
    await key(wc, 'Enter', { ch: '\r' });
    await pause(200);
    assert.equal((await rows(wc)).at(-1), '@[Meeting with Amir]');
    pass('@Meeting with A: narrowed past the spaces and picked');
    await typeKeys(wc, '\n@Zebra el');
    assert.deepEqual(await menu(wc), ['Zebra elsewhere note']);
    await key(wc, 'Enter', { ch: '\r' });
    await typeKeys(wc, '\nend');
    assert.ok((await rows(wc)).includes('@[Zebra elsewhere note]'));
    const chip = `${ED} [data-mention="Zebra elsewhere note"]`;
    assert.match(await js(wc, `document.querySelector(${JSON.stringify(chip)}).getAttribute('style')`), /#0070f3/, 'drawn as a mention, not grey');
    const at = await spot(wc, chip, 30);
    wc.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y });
    await until(() => js(wc, `(()=>{const p=document.querySelector('[data-hover="1"]');return p&&p.textContent.includes('Zebra elsewhere note')})()`), 'its card on hover');
    assert.ok(await js(wc, `document.querySelector('[data-hover="1"]').textContent.includes('A note in another project.')`), 'its card says where it is kept');
    pass('the other project\'s note: a blue chip, and its card on hover');
    await shot(wc, '1-mentions');
    // What @bart is given: the document with the note's text under its mention (main/context/expand-mentions.cjs).
    const layout = ensureHome(root);
    const ctx = { homeDir: root, root: layout.root, dataRoot: layout.root, libraryDb: await db.openLibraryDb(layout.root) };
    const expanded = await until(async () => { const out = await expandDoc(ctx, here.project.id, { kind: 'workspace', workspaceId: here.workspaceId }); return out.text.includes('words from elsewhere') && out; }, 'the note\'s text in what @bart reads');
    assert.equal(expanded.missing, 0, 'no mention leads nowhere');
    pass('@bart\'s context holds the other project\'s note, whole');
    await click(wc, at);
    const PANE = 'main [data-doc-pane="1"] [data-editor]';
    await until(async () => (await rows(wc, PANE).catch(() => [])).includes('words from elsewhere'), 'the note open beside the document');
    assert.equal(await js(wc, `document.body.textContent.includes('Unknown note')`), false);
    await click(wc, await spot(wc, `${PANE} [data-line="0"]`, 400));
    await key(wc, 'End');
    await typeKeys(wc, ' and more');
    const farFile = path.join(there.project.dir, 'Zebra elsewhere note.md');
    await until(() => fs.readFileSync(farFile, 'utf8').includes('words from elsewhere and more'), 'the edit saved in its own project');
    assert.equal(fs.existsSync(path.join(here.project.dir, 'Zebra elsewhere note.md')), false);
    pass('opened beside the document from its chip, edited, saved into its own project');
    await shot(wc, '2-opened');
    await js(wc, `(()=>{const b=document.querySelector('[data-pane-close="1"]');if(b)b.click();return true})()`);
    await pause(300);

    /* ------------------------------------------------ 2. quotes */
    await click(wc, await spot(wc, `${ED} [data-line="${await last()}"]`, 400));
    await key(wc, 'End');
    await typeKeys(wc, '\n>');
    const q = await last();
    assert.equal((await rows(wc))[q], '>', 'the `>` is a line of its own');
    assert.equal(await caretLine(wc), q, 'the caret stays on the `>` line');
    assert.equal(await js(wc, `document.querySelector('${ED} [data-line="${q}"]').getAttribute('contenteditable')`), null, 'the quote is not locked');
    await paste(wc, 'pasted quote');
    await pause(200);
    assert.equal((await rows(wc))[q], '> pasted quote', 'pasted right after `>`, no space: a quote of what was pasted');
    pass('`>` then a paste with no space: "> pasted quote", the caret still on it');
    await typeKeys(wc, ' typed');
    assert.equal((await rows(wc))[q], '> pasted quote typed');
    await click(wc, await spot(wc, `${ED} [data-line="${q - 1}"]`, 400)); // off the quote: it draws without its `> `
    await pause(100);
    const word = await js(wc, `(()=>{const t=document.querySelector('${ED} [data-line="${q}"] .t');const w=document.createTreeWalker(t,NodeFilter.SHOW_TEXT);let n;while((n=w.nextNode())&&!n.data.includes('quote'));if(!n)return t.outerHTML;const i=n.data.indexOf('quote');const r=document.createRange();r.setStart(n,i);r.setEnd(n,i+1);const b=r.getBoundingClientRect();return{x:Math.round(b.left+1),y:Math.round(b.top+b.height/2)}})()`);
    assert.equal(typeof word, 'object', `the quote's word on screen: ${word}`);
    await click(wc, word);
    await pause(60);
    assert.equal(await caretLine(wc), q, 'a click puts the caret in the quote');
    await typeKeys(wc, 'X');
    assert.match((await rows(wc))[q], /^> pasted Xquote typed$|^> pasted qXuote typed$/, 'typed where it was clicked');
    pass('clicked into the quote and typed in it');
    // A word selected in the quote: a paste takes its place, and Backspace deletes a selection as on any line.
    const pick = (word) => js(wc, `(()=>{const t=document.querySelector('${ED} [data-line="${q}"] .t');const w=document.createTreeWalker(t,NodeFilter.SHOW_TEXT);let n;while((n=w.nextNode())&&!n.data.includes(${JSON.stringify(word)}));const i=n.data.indexOf(${JSON.stringify(word)});const r=document.createRange();r.setStart(n,i);r.setEnd(n,i+${word.length});const s=getSelection();s.removeAllRanges();s.addRange(r);return true})()`);
    await pick('typed');
    await pause(100);
    await paste(wc, 'kept');
    await pause(200);
    assert.match((await rows(wc))[q], /^> pasted (Xquote|qXuote) kept$/, 'the selected word replaced by the paste');
    await pick('kept');
    await pause(100);
    await key(wc, 'Backspace');
    await pause(200);
    assert.match((await rows(wc))[q], /^> pasted (Xquote|qXuote) $/, 'the selected word deleted');
    await typeKeys(wc, 'typed');
    pass('a selection in the quote: replaced by a paste, deleted by Backspace');
    const quoted = (await rows(wc))[q];
    await key(wc, 'Home');
    await key(wc, 'Right'); // Electron's names for the arrows
    await key(wc, 'Right');
    assert.equal(await js(wc, `getSelection().anchorOffset + (getSelection().anchorNode.textContent === '> ' ? 0 : 2)`), 2, 'the caret at the start of the quote\'s text');
    await key(wc, 'Backspace');
    await pause(150);
    assert.equal((await rows(wc))[q], quoted.slice(2), 'Backspace at the start of its text: a plain line');
    pass('Backspace at the start of the quote\'s text: a plain line again');
    await key(wc, 'End');
    await typeKeys(wc, '\n>');
    await paste(wc, 'line one\nline two');
    await pause(200);
    const now = await rows(wc);
    assert.deepEqual(now.slice(q + 1, q + 3), ['> line one', '> line two'], 'every pasted line quoted');
    pass('`>` then a paste of two lines: both quoted');
    const saved = await until(async () => { const text = await api(`readDoc(${JSON.stringify(here.project.id)}, {kind:'workspace', workspaceId:${JSON.stringify(here.workspaceId)}})`); return text.includes('> line two') && text; }, 'the document saved');
    assert.ok(saved.split('\n').includes('> line one'), 'on disk as typed');
    await shot(wc, '3-quotes');
    wc.reload();
    await until(() => js(wc, `!!document.querySelector(${JSON.stringify(ED)})`).catch(() => false), 'the document again');
    await pause(500);
    const drawn = await js(wc, `[...document.querySelectorAll('${ED} [data-line]')].filter((d)=>/^>/.test(d.dataset.raw)).map((d)=>[d.dataset.raw,!!d.querySelector('.t[style*="border-left"]'),d.getAttribute('contenteditable')])`);
    assert.deepEqual(drawn, [['> line one', true, null], ['> line two', true, null]]);
    pass('after a reload: drawn as quotes, still editable');
    console.log('ALL PASS');
  } catch (error) {
    console.error('FAIL', error);
    process.exitCode = 1;
  } finally {
    app.exit(process.exitCode || 0);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
setTimeout(() => { console.error('FAIL: timed out'); app.exit(2); }, 180000).unref();
