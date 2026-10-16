'use strict';

// npm run build && npx electron scripts/smoke-keys.cjs
// Runs the real app, hidden, against disposable project/user data, and drives ⌘T, ⌘W and ⌘F with real (synthetic) input
// (2026-10-16: "cmd + w and cmd + t should work in middle canvas or stage or terminal, depending on where i clicked";
// "Add cmd + f to the middle canvas"; model/key-side.js, workspace/DocFind.jsx). Clicked in the document: ⌘T opens the +'s
// note menu, ⌘W closes the note tab in front and leaves Workspace and the Stage's tabs alone. Clicked in the Stage: ⌘T and
// ⌘W open and close its tabs as before. Clicked in the terminal: its own tabs. A page on the Stage taking the keyboard
// is the Stage's, also once the app has the keyboard back. ⌘F in the document: the find card over the pane clicked last,
// its matches painted with CSS highlights (the editor's DOM untouched), Enter, ⇧Enter and ⌘G stepping, Escape closing it
// with the match selected in the editor; ⌘W in the pane beside closes that pane. The Stage's own ⌘F still opens its card.
// Keys are sent with sendInputEvent, so they reach the page's keydown listeners and main's before-input-event, but not
// the Edit menu's accelerators. ENGELBART_KEYS_SHOTS=<dir> saves pictures of the window with the find card open.
const { app, BrowserWindow, webContents } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-keys-smoke-'));
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
async function until(fn, label, tries = 200) {
  for (let i = 0; i < tries; i++) { const result = await fn(); if (result) return result; await pause(); }
  throw new Error(`Timed out: ${label}`);
}
const js = (wc, expression) => wc.executeJavaScript(expression, true);
const PANE = (i) => `main [data-doc-pane="${i}"]`;
const click = async (wc, { x, y }) => {
  wc.focus();
  await pause();
  wc.sendInputEvent({ type: 'mouseMove', x, y });
  wc.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x, y });
  wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x, y });
  await pause(200);
};
const key = async (wc, keyCode, { ch = null, modifiers = [] } = {}) => {
  wc.sendInputEvent({ type: 'rawKeyDown', keyCode, modifiers });
  if (ch) wc.sendInputEvent({ type: 'char', keyCode: ch, modifiers });
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await pause(200);
};
const cmd = (wc, letter, more = []) => key(wc, letter, { modifiers: ['meta', ...more] });
const typeKeys = async (wc, text) => { for (const ch of text) await key(wc, ch === ' ' ? 'Space' : ch, { ch }); await pause(150); };
const spot = (wc, selector) => js(wc, `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;const r=el.getBoundingClientRect();if(!r.width||!r.height)return null;return{x:Math.round(r.x+Math.min(r.width/2,20)),y:Math.round(r.y+r.height/2)}})()`);
const press = async (wc, selector) => { const at = await until(() => spot(wc, selector), selector); await click(wc, at); };
const count = (wc, selector) => js(wc, `document.querySelectorAll(${JSON.stringify(selector)}).length`);
const docTabs = (wc) => js(wc, `[...document.querySelectorAll('[data-doc-tab]')].map((t)=>t.dataset.docTab)`);
const stageTabs = (wc) => count(wc, '[data-stage-tab]');
const termTabs = (wc) => count(wc, '[data-term-tab]');
const findCount = (wc) => js(wc, `(document.querySelector('[data-doc-find] [data-find-count]')||{}).textContent||null`);
// What the find highlights cover now: the match in front and the others.
const SHOTS = process.env.ENGELBART_KEYS_SHOTS;
async function shot(wc, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  const picture = await wc.capturePage(undefined, { stayHidden: true, stayAwake: true });
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), picture.toPNG());
}
const painted = (wc) => js(wc, `(()=>{const h=CSS.highlights;const text=(name)=>h.has(name)?[...h.get(name)].map((r)=>r.toString()):null;return{on:text('doc-find-cur'),rest:text('doc-find')}})()`);

app.whenReady().then(async () => {
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Local page</title><p>A page on the Stage.</p>'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const pageUrl = `http://127.0.0.1:${server.address().port}/`;
  try {
    const win = await until(() => BrowserWindow.getAllWindows()[0], 'app window');
    win.setFocusable(false); // synthetic input only; do not capture the user's typing
    assert.equal(win.isVisible(), false, 'smoke runs must not show a desktop window');
    win.setBounds({ x: 0, y: 0, width: 1440, height: 900 });
    const wc = win.webContents;
    wc.setBackgroundThrottling(false);
    await until(() => js(wc, '!!window.engelbartAPI && !!document.querySelector("button")').catch(() => false), 'app bootstrap');
    const made = await js(wc, `window.engelbartAPI.createProjectWithWelcome({name:'Keys smoke', directory:${JSON.stringify(root)}})`);
    const pid = made.project.id, wid = made.workspaceId;
    const api = (call) => js(wc, `window.engelbartAPI.${call}`);
    const notes = {};
    for (const name of ['Alpha', 'Beta']) notes[name] = await api(`createNote(${JSON.stringify(pid)}, {name:${JSON.stringify(name)}, workspaceId:${JSON.stringify(wid)}})`);
    const write = (ref, text) => api(`writeDoc(${JSON.stringify(pid)}, ${JSON.stringify(ref)}, ${JSON.stringify(text)})`);
    const filler = Array.from({ length: 50 }, (_, i) => `Line ${i + 1} is filler, long enough to scroll the page.`).join('\n');
    await write({ kind: 'workspace', workspaceId: wid }, `The plan\nSee @[Alpha] for the **plan** in short.\n${filler}\nThe last Plan line.\n`);
    await write({ kind: 'note', id: notes.Alpha.id }, 'Alpha body\nMore of the body here.\n');
    await write({ kind: 'note', id: notes.Beta.id }, 'Beta body\n');
    wc.reload();
    await until(() => js(wc, '!!document.querySelector("[data-doc-tab]")').catch(() => false), 'the workspace screen');
    await js(wc, `(()=>{const row=[...document.querySelectorAll('aside[aria-label="Sidebar"] *')].find((el)=>el.children.length===0&&el.textContent.trim()==='Getting started');if(row)row.click()})()`);
    await until(() => js(wc, `!!document.querySelector(${JSON.stringify(`${PANE(0)} [data-editor] [data-mention="Alpha"]`)})`).catch(() => false), 'the workspace document');
    await pause(400);
    const line = (i) => `${PANE(0)} [data-editor] [data-line="${i}"]`;

    /* ------------------------------------------------ the document clicked: ⌘T opens the + menu, ⌘W closes the note in front */
    const stage0 = await stageTabs(wc);
    await press(wc, line(0));
    await cmd(wc, 'T');
    assert.equal(await count(wc, '[data-note-picker]'), 1, '⌘T in the document opens the note menu');
    assert.equal(await stageTabs(wc), stage0, 'and no Stage tab');
    await typeKeys(wc, 'Beta');
    await key(wc, 'Enter', { ch: '\r' });
    await until(async () => (await docTabs(wc)).includes(notes.Beta.id), 'Beta opened as a tab');
    assert.equal(await count(wc, '[data-note-picker]'), 0);
    console.log('PASS ⌘T with the document clicked last opens its + menu (no Stage tab); picking a note opens its tab');
    await press(wc, `${PANE(0)} [data-editor] [data-line="0"]`);
    await cmd(wc, 'W');
    await until(async () => !(await docTabs(wc)).includes(notes.Beta.id), 'Beta closed');
    assert.equal(await stageTabs(wc), stage0, '⌘W closed no Stage tab');
    const left = await docTabs(wc);
    await press(wc, line(0));
    await cmd(wc, 'W');
    assert.deepEqual(await docTabs(wc), left, 'Workspace in front: ⌘W closes nothing');
    assert.equal(await stageTabs(wc), stage0, 'nor a Stage tab');
    console.log(`PASS ⌘W with the document clicked last closes the note in front; on Workspace it closes nothing (tabs ${JSON.stringify(left)})`);

    /* ------------------------------------------------ the Stage clicked: its tabs, as before */
    await press(wc, '[data-stage] input[aria-label="Open on stage"]');
    await cmd(wc, 'T');
    await until(async () => (await stageTabs(wc)) === stage0 + 1, 'a new Stage tab');
    assert.deepEqual(await docTabs(wc), left, 'no note tab');
    assert.equal(await count(wc, '[data-note-picker]'), 0, 'no note menu');
    await cmd(wc, 'W');
    await until(async () => (await stageTabs(wc)) === stage0, 'the Stage tab closed');
    assert.deepEqual(await docTabs(wc), left);
    await press(wc, '[data-stage] input[aria-label="Open on stage"]');
    await cmd(wc, 'F');
    assert.equal(await count(wc, '[data-stage] [data-find-bar]'), 1, 'the Stage\'s ⌘F still opens its card');
    assert.equal(await count(wc, '[data-doc-find]'), 0, 'and not the document\'s');
    await key(wc, 'Escape');
    assert.equal(await count(wc, '[data-stage] [data-find-bar]'), 0);
    console.log('PASS ⌘T, ⌘W and ⌘F with the Stage clicked last are the Stage\'s, as before');

    /* ------------------------------------------------ a page on the Stage: the native view's keyboard is the Stage's */
    await press(wc, '[data-stage] input[aria-label="Open on stage"]');
    await typeKeys(wc, pageUrl);
    await key(wc, 'Enter', { ch: '\r' });
    const page = await until(() => webContents.getAllWebContents().find((w) => w.getURL().startsWith(pageUrl) && !w.isLoading()), 'the page loaded');
    const tabsWithPage = await stageTabs(wc);
    await press(wc, line(0)); // the document clicked, then the page
    page.focus();
    await pause(200);
    wc.focus(); // the app gets the keyboard back (as ⌘T in a page or a closed tab hands it back): the editor it had is no click
    await pause(200);
    await cmd(wc, 'T');
    await until(async () => (await stageTabs(wc)) === tabsWithPage + 1, 'a Stage tab after the page had the keyboard');
    assert.equal(await count(wc, '[data-note-picker]'), 0, 'not the note menu');
    await cmd(wc, 'W');
    await until(async () => (await stageTabs(wc)) === tabsWithPage, 'closed again');
    page.focus();
    await pause(200);
    await cmd(page, 'T'); // in the page: main's before-input-event, unchanged
    await until(async () => (await stageTabs(wc)) === tabsWithPage + 1, 'a Stage tab from ⌘T in the page');
    await cmd(wc, 'W');
    await until(async () => (await stageTabs(wc)) === tabsWithPage, 'and ⌘W in the app closes it');
    assert.deepEqual(await docTabs(wc), left);
    console.log('PASS a page on the Stage taking the keyboard makes ⌘T and ⌘W the Stage\'s, also once the app has the keyboard back');

    /* ------------------------------------------------ the terminal clicked: its own tabs */
    await press(wc, '[data-right-mode="terminal"]');
    await until(async () => (await termTabs(wc)) > 0 || js(wc, '!!document.querySelector("[data-terminal]")'), 'the Terminal');
    const term0 = await termTabs(wc);
    await press(wc, '[data-terminal] [data-term-tabs]');
    await cmd(wc, 'T');
    await until(async () => (await termTabs(wc)) === term0 + 1, 'a new terminal');
    assert.equal(await count(wc, '[data-note-picker]'), 0);
    await press(wc, line(0));
    await cmd(wc, 'T');
    assert.equal(await count(wc, '[data-note-picker]'), 1, 'the document clicked: ⌘T is its + menu, not a terminal');
    assert.equal(await termTabs(wc), term0 + 1);
    await key(wc, 'Escape'); // the note menu closes (one more would leave the workspace)
    assert.equal(await count(wc, '[data-note-picker]'), 0);
    await press(wc, '[data-right-mode="stage"]');
    console.log(`PASS ⌘T with the terminal clicked last opens a terminal (${term0} → ${term0 + 1}); with the document clicked, the + menu`);

    /* ------------------------------------------------ ⌘F in the document */
    await press(wc, line(0));
    const before = await js(wc, `document.querySelector('${PANE(0)} [data-editor]').innerHTML`);
    await cmd(wc, 'F');
    await until(() => js(wc, `document.activeElement && document.activeElement.closest('[data-doc-find]') && document.activeElement.closest('${PANE(0)}') ? true : false`), 'the find field has the keyboard');
    assert.equal(await count(wc, '[data-stage] [data-find-bar]'), 0, 'not the Stage\'s');
    await typeKeys(wc, 'plan');
    const n = await until(async () => { const c = await findCount(wc); return c && /of 3$/.test(c) ? c : null; }, 'three matches');
    assert.equal(n, '1 of 3');
    let p = await painted(wc);
    assert.deepEqual([p.on, p.rest.map((s) => s.toLowerCase())], [['plan'], ['plan', 'plan']], 'the match in front and the others painted');
    await shot(wc, '1-find');
    await key(wc, 'Enter', { ch: '\r' });
    assert.equal(await findCount(wc), '2 of 3');
    await cmd(wc, 'G');
    assert.equal(await findCount(wc), '3 of 3', '⌘G steps on');
    p = await painted(wc);
    assert.deepEqual(p.on, ['Plan'], 'the last line\'s Plan in front');
    const scrolled = await js(wc, `document.querySelector('${PANE(0)} [data-editor]').parentElement.parentElement.scrollTop`);
    assert.ok(scrolled > 0, 'scrolled to the last line');
    await key(wc, 'Enter', { ch: '\r', modifiers: ['shift'] });
    assert.equal(await findCount(wc), '2 of 3', '⇧Enter steps back');
    const during = await js(wc, `document.querySelector('${PANE(0)} [data-editor]').innerHTML`);
    assert.ok(!/doc-find|<mark/i.test(during), 'nothing of find in the editor\'s DOM');
    await press(wc, `${PANE(0)} [data-doc-find] [aria-label="Next match"]`);
    assert.equal(await findCount(wc), '3 of 3', 'the ↓ button steps');
    await press(wc, `${PANE(0)} [data-doc-find] input`);
    await key(wc, 'Escape');
    await until(async () => (await count(wc, '[data-doc-find]')) === 0, 'find closed');
    p = await painted(wc);
    assert.deepEqual([p.on, p.rest], [null, null], 'its highlights gone');
    await pause(200);
    const back = await js(wc, `(()=>{const a=document.activeElement;const s=getSelection();return{editor:!!a&&a.matches('[data-editor]')&&!!a.closest('${PANE(0)}'),selected:s.toString()}})()`);
    assert.deepEqual(back, { editor: true, selected: 'Plan' }, 'Escape gives the keyboard back to the editor with the match selected');
    console.log(`PASS ⌘F in the document finds "plan" (${n}), steps with Enter, ⌘G, ⇧Enter and ↓, never writes into the editor's DOM, and Escape selects the match in the editor`);
    assert.ok(before.length > 0);

    /* ------------------------------------------------ two panes: find and ⌘W in the one clicked last */
    await key(wc, 'Escape'); // the caret leaves its line
    await js(wc, `document.querySelector('${PANE(0)} [data-editor]').parentElement.parentElement.scrollTop = 0`);
    await pause(300);
    await press(wc, `${PANE(0)} [data-editor] [data-mention="Alpha"]`);
    await until(() => js(wc, `!!document.querySelector('${PANE(1)} [data-editor] [data-line]')`), 'Alpha beside');
    await press(wc, `${PANE(1)} [data-editor] [data-line="0"]`);
    await cmd(wc, 'F');
    await until(() => js(wc, `!!document.querySelector('${PANE(1)} [data-doc-find]')`), 'find over the pane beside');
    assert.equal(await count(wc, `${PANE(0)} [data-doc-find]`), 0, 'not over the document');
    await js(wc, `(()=>{const i=document.querySelector('${PANE(1)} [data-doc-find] input');i.select();})()`);
    await typeKeys(wc, 'body');
    assert.equal(await until(() => findCount(wc), 'a count'), '1 of 2', 'Alpha\'s two "body"s, not the document\'s');
    await shot(wc, '2-find-beside');
    await key(wc, 'Escape');
    await until(async () => (await count(wc, '[data-doc-find]')) === 0, 'find closed');
    const tabsNow = await docTabs(wc);
    await press(wc, `${PANE(1)} [data-editor] [data-line="1"]`);
    await cmd(wc, 'W');
    await until(async () => (await count(wc, `${PANE(1)}`)) === 0, 'the pane beside closed');
    assert.deepEqual(await docTabs(wc), tabsNow, 'no tab closed');
    console.log('PASS with a pane beside, ⌘F searches the pane clicked last and ⌘W there closes that pane, not a tab');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    server.close();
    app.exit(process.exitCode || 0);
  }
});
