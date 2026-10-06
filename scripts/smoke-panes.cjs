'use strict';

// npm run build && npx electron scripts/smoke-panes.cjs
// Runs the real app, hidden, against disposable project/user data and the fake @bart, and drives the middle column's
// full screen and the notes opened beside the document (MATH-23: src/renderer/screens/Workspace.jsx, workspace/DocPane.jsx,
// model/panes.js) with real (synthetic) input: a note's mention opens its note to the right and stays marked, another
// replaces it, a mention in that pane opens a third and the strip scrolls to it, the document folds to a strip and comes
// back on a click, × closes, ⌘-click still opens a tab, @bart in a pane is answered there, the same note in two panes
// is one document, a tab switch closes the panes, and Escape leaves the full screen without closing the workspace.
// ENGELBART_PANES_SHOTS=<dir> saves pictures of the window at the moments worth seeing.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-panes-smoke-'));
app.setPath('userData', path.join(root, 'electron'));
process.env.ENGELBART_HOME_DIR = root;
process.env.ENGELBART_SUMMARIES = 'off';
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
const PANE = (i) => `main [data-doc-pane="${i}"]`;
const WS = 'Getting started'; // the welcome workspace's name: the document's title
const click = async (wc, { x, y }, modifiers = []) => {
  wc.focus();
  await pause();
  wc.sendInputEvent({ type: 'mouseMove', x, y });
  wc.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x, y, modifiers });
  wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x, y, modifiers });
  await pause(150);
};
const key = async (wc, keyCode, { ch = null, modifiers = [] } = {}) => {
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  if (ch) wc.sendInputEvent({ type: 'char', keyCode: ch, modifiers });
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await pause(30);
};
const typeKeys = async (wc, text) => { for (const ch of text) { if (ch === '\n') await key(wc, 'Enter', { ch: '\r' }); else await key(wc, ch === ' ' ? 'Space' : ch, { ch }); } await pause(150); };
// The centre of what `selector` finds, as it is on screen now (nothing is scrolled to find it).
const spot = (wc, selector) => js(wc, `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;const r=el.getBoundingClientRect();if(!r.width||!r.height)return null;return{x:Math.round(r.x+Math.min(r.width/2,20)),y:Math.round(r.y+r.height/2)}})()`);
const press = async (wc, selector, modifiers) => { const at = await until(() => spot(wc, selector), selector); await click(wc, at, modifiers); };
// What the strip shows: each pane's title and document lines, and where the strip is scrolled to.
const strip = (wc) => js(wc, `(()=>{const main=document.querySelector('main');return{left:Math.round(main.scrollLeft),width:main.clientWidth,scrollWidth:main.scrollWidth,panes:[...main.querySelectorAll('[data-doc-pane]')].map((p)=>({title:(p.querySelector('[data-doc-title]')||{}).value,width:Math.round(p.getBoundingClientRect().width),left:Math.round(p.getBoundingClientRect().left-main.getBoundingClientRect().left),rows:[...p.querySelectorAll('[data-editor] [data-line]')].map((d)=>d.dataset.raw),folded:(()=>{const s=p.querySelector('[data-pane-strip]');return !!s&&getComputedStyle(s).opacity==='1'})(),marked:[...p.querySelectorAll('[data-mention][data-beside]')].map((m)=>m.dataset.mention)}))}})()`);
const settledStrip = async (wc) => { let last = ''; return until(async () => { const now = JSON.stringify(await strip(wc)); const same = now === last; last = now; await pause(120); return same ? JSON.parse(now) : null; }, 'the strip settles'); };
const SHOTS = process.env.ENGELBART_PANES_SHOTS;
async function shot(wc, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  const picture = await wc.capturePage(undefined, { stayHidden: true, stayAwake: true });
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), picture.toPNG());
}

app.whenReady().then(async () => {
  try {
    const win = await until(() => BrowserWindow.getAllWindows()[0], 'app window');
    win.setFocusable(false); // synthetic input only; do not capture the user's typing
    assert.equal(win.isVisible(), false, 'smoke runs must not show a desktop window');
    win.setBounds({ x: 0, y: 0, width: 1440, height: 900 });
    const wc = win.webContents;
    wc.setBackgroundThrottling(false);
    await until(() => js(wc, '!!window.engelbartAPI && !!document.querySelector("button")').catch(() => false), 'app bootstrap');
    const made = await js(wc, `window.engelbartAPI.createProjectWithWelcome({name:'Panes smoke', directory:${JSON.stringify(root)}})`);
    const pid = made.project.id, wid = made.workspaceId;
    const api = (call) => js(wc, `window.engelbartAPI.${call}`);
    const notes = {};
    for (const name of ['Alpha', 'Beta', 'Gamma', 'Delta']) notes[name] = await api(`createNote(${JSON.stringify(pid)}, {name:${JSON.stringify(name)}, workspaceId:${JSON.stringify(wid)}})`);
    const write = (ref, text) => api(`writeDoc(${JSON.stringify(pid)}, ${JSON.stringify(ref)}, ${JSON.stringify(text)})`);
    const read = (ref) => api(`readDoc(${JSON.stringify(pid)}, ${JSON.stringify(ref)})`);
    const noteRef = (name) => ({ kind: 'note', id: notes[name].id });
    const filler = Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of the plan, long enough to scroll.`).join('\n');
    await write({ kind: 'workspace', workspaceId: wid }, `Plan\nSee @[Alpha] and @[Beta].\n${filler}\n`);
    await write(noteRef('Alpha'), 'Alpha body\nGo on to @[Gamma].\n');
    await write(noteRef('Beta'), 'Beta body\n');
    await write(noteRef('Gamma'), 'Gamma body\nThen @[Delta], or back to @[Alpha].\n');
    await write(noteRef('Delta'), 'Delta body\n');
    wc.reload();
    await until(() => js(wc, `!!document.querySelector(${JSON.stringify(`${PANE(0)} [data-editor] [data-mention="Alpha"]`)})`).catch(() => false), 'the workspace document');
    await pause(400);

    /* ------------------------------------------------ A-10: the document alone is as it was */
    const alone = await settledStrip(wc);
    assert.equal(alone.panes.length, 1);
    assert.equal(alone.panes[0].width, alone.width, 'the document fills the column');
    assert.equal(alone.scrollWidth, alone.width, 'nothing to scroll sideways');
    assert.equal(await js(wc, `!!document.querySelector('[data-pane-strip], [data-pane-close]')`), false, 'no strip, no ×');
    await shot(wc, '0-alone');
    console.log(`PASS the document alone fills the middle column (${alone.width}px), nothing beside it`);

    /* ------------------------------------------------ A-02: a note's mention opens it beside, marked; the document stays */
    const pageTop = () => js(wc, `document.querySelector('${PANE(0)} [data-editor]').parentElement.parentElement.scrollTop`);
    await js(wc, `document.querySelector('${PANE(0)} [data-editor]').parentElement.parentElement.scrollTop = 60`);
    await pause(400); // past the editor's report of where it was scrolled to
    const scrolled = await pageTop();
    await press(wc, `${PANE(0)} [data-editor] [data-mention="Alpha"]`);
    let now = await settledStrip(wc);
    assert.deepEqual(now.panes.map((p) => p.title), [WS, 'Alpha'], 'the note beside the document');
    assert.deepEqual(now.panes[0].marked, ['Alpha'], 'the mention stays marked');
    assert.deepEqual(now.panes[1].rows.slice(0, 1), ['Alpha body']);
    assert.ok(now.panes[1].width <= 600, `a pane is at most 600px (${now.panes[1].width})`);
    assert.ok(scrolled > 0, 'the document was scrolled down a little');
    assert.equal(await pageTop(), scrolled, 'and is still where it was');
    await shot(wc, '1-beside');
    console.log(`PASS a note's mention opens it to the right (${now.panes.map((p) => `${p.width}px`).join(' + ')}, strip at ${now.left}px), its mention marked`);

    /* ------------------------------------------------ A-03: another mention in the document replaces it */
    await press(wc, `[data-pane-strip="0"]`).catch(() => {}); // folded in a narrow column: bring the document back first
    await settledStrip(wc);
    await press(wc, `${PANE(0)} [data-editor] [data-mention="Beta"]`);
    now = await settledStrip(wc);
    assert.deepEqual(now.panes.map((p) => p.title), [WS, 'Beta']);
    assert.deepEqual(now.panes[0].marked, ['Beta'], 'the new mention is the marked one');
    console.log('PASS another mention in the document replaces the pane beside it');

    /* ------------------------------------------------ A-04: a mention in the pane opens a third; the document folds */
    await press(wc, `[data-pane-strip="0"]`).catch(() => {});
    await settledStrip(wc);
    await press(wc, `${PANE(0)} [data-editor] [data-mention="Alpha"]`);
    await settledStrip(wc);
    await press(wc, `${PANE(1)} [data-editor] [data-mention="Gamma"]`);
    now = await settledStrip(wc);
    assert.deepEqual(now.panes.map((p) => p.title), [WS, 'Alpha', 'Gamma']);
    assert.deepEqual(now.panes[1].marked, ['Gamma']);
    assert.ok(now.left > 0, 'the strip scrolled');
    assert.equal(now.left, now.scrollWidth - now.width, 'to its end, where the new pane is');
    assert.equal(now.panes[0].folded, true, 'the document is a strip');
    assert.equal(now.panes[2].left + now.panes[2].width, now.width, 'the new pane shows whole');
    await shot(wc, '2-three');
    console.log('PASS a mention in the pane opens a third and the strip scrolls to it; the document is a strip');
    const titled = await js(wc, `document.querySelector('[data-pane-strip="0"]').textContent`);
    assert.equal(titled, WS, 'the strip has the document\'s title');
    await press(wc, '[data-pane-strip="0"]');
    now = await settledStrip(wc);
    assert.equal(now.left, 0, 'the strip scrolled back');
    assert.equal(now.panes[0].folded, false);
    await shot(wc, '3-back');
    console.log(`PASS a click on the document's strip ("${titled}") scrolls back to it`);

    /* ------------------------------------------------ A-05: × closes that pane and those after it */
    await js(wc, `document.querySelector('[data-pane-close="1"]').scrollIntoView({ inline: 'nearest', block: 'nearest' })`); // its pane's right edge, past the column's
    await settledStrip(wc);
    await press(wc, '[data-pane-close="1"]');
    now = await settledStrip(wc);
    assert.deepEqual(now.panes.map((p) => p.title), [WS], '× on the second pane closes it and the third');
    assert.deepEqual(now.panes[0].marked, [], 'nothing is marked any more');
    console.log('PASS × closes its pane and every pane after it');

    /* ------------------------------------------------ A-06: ⌘-click opens a tab, as before */
    await press(wc, `${PANE(0)} [data-editor] [data-mention="Alpha"]`, ['meta']);
    now = await settledStrip(wc);
    assert.deepEqual(now.panes.map((p) => p.title), ['Alpha'], 'the note in front, as its tab');
    console.log('PASS ⌘-click on a note\'s mention opens its tab');

    /* ------------------------------------------------ A-08: the same note in two panes is one document */
    await press(wc, `${PANE(0)} [data-editor] [data-mention="Gamma"]`);
    await settledStrip(wc);
    await press(wc, `${PANE(1)} [data-editor] [data-mention="Alpha"]`);
    now = await settledStrip(wc);
    assert.deepEqual(now.panes.map((p) => p.title), ['Alpha', 'Gamma', 'Alpha']);
    await press(wc, `${PANE(2)} [data-editor] [data-line="0"] .t`);
    await key(wc, 'End');
    await typeKeys(wc, ' typed beside');
    now = await settledStrip(wc);
    assert.equal(now.panes[2].rows[0], 'Alpha body typed beside');
    assert.equal(now.panes[0].rows[0], 'Alpha body typed beside', 'the tab shows it too');
    await until(async () => String(await read(noteRef('Alpha'))).startsWith('Alpha body typed beside'), 'saved');
    await shot(wc, '4-same-note');
    console.log('PASS typing in a note beside shows in its tab too, and is saved');

    /* ------------------------------------------------ A-09: another tab closes the panes */
    await press(wc, '[data-doc-tab="ws"]');
    now = await settledStrip(wc);
    assert.equal(now.panes.length, 1, 'the panes closed with the tab change');
    assert.ok(now.panes[0].rows[0] === 'Plan', 'the workspace document is in front');
    console.log('PASS switching tab closes the panes beside');

    /* ------------------------------------------------ A-07: @bart in a pane is answered in that note */
    await press(wc, `${PANE(0)} [data-editor] [data-mention="Beta"]`);
    await settledStrip(wc);
    await press(wc, `${PANE(1)} [data-editor] [data-line="0"] .t`);
    await key(wc, 'End');
    await typeKeys(wc, '\n@bart what is beta\n');
    const answered = await until(async () => { const s = await strip(wc); const rows = s.panes[1] ? s.panes[1].rows : []; return rows.some((r) => /FAKE ANSWER/.test(r)) && !rows.some((r) => /^bart~> /.test(r)) ? s : null; }, 'the answer in the note', 400);
    assert.ok(!answered.panes[0].rows.some((r) => /FAKE ANSWER|what is beta/.test(r)), 'nothing in the workspace document');
    await until(async () => /FAKE ANSWER/.test(String(await read(noteRef('Beta')))), 'the answer saved in the note');
    assert.ok(!/FAKE ANSWER/.test(String(await read({ kind: 'workspace', workspaceId: wid }))), 'none saved in the workspace document');
    await shot(wc, '5-bart-beside');
    console.log('PASS @bart asked in a note beside is answered in that note, never in the document');

    /* ------------------------------------------------ A-01: full screen, and Escape */
    const layout = () => js(wc, `({full:document.querySelector('[data-doc-full]').dataset.docFull,rail:getComputedStyle(document.querySelector('aside[aria-label="Sidebar"]')).display,right:getComputedStyle(document.querySelector('section[aria-label="Right pane"]')).display,main:Math.round(document.querySelector('main').getBoundingClientRect().width),window:innerWidth,workspace:!!document.querySelector('main [data-doc-pane]')})`);
    await press(wc, '[data-doc-full]');
    let seen = await layout();
    assert.deepEqual([seen.full, seen.rail, seen.right], ['1', 'none', 'none'], 'no sidebar, no Stage');
    assert.equal(seen.main, seen.window, 'the middle column has the whole window');
    now = await settledStrip(wc);
    assert.ok(now.panes.every((p) => !p.folded), 'with room, the document and the note sit side by side');
    await shot(wc, '6-full');
    console.log(`PASS the full screen hides the sidebar and the Stage (the column is ${seen.main}px; panes ${now.panes.map((p) => `${p.width}px`).join(' + ')})`);
    await press(wc, `${PANE(0)} [data-editor] [data-line="0"] .t`);
    await key(wc, 'End');
    await typeKeys(wc, '@');
    await until(() => js(wc, `!!document.querySelector('[data-mention-menu]')`), 'the @ menu');
    await key(wc, 'Escape');
    seen = await layout();
    assert.equal(seen.full, '1', 'Escape closed the @ menu only');
    assert.equal(await js(wc, `!!document.querySelector('[data-mention-menu]')`), false);
    await key(wc, 'Backspace');
    await key(wc, 'Escape');
    seen = await layout();
    assert.deepEqual([seen.full, seen.rail, seen.right, seen.workspace], ['0', 'flex', 'flex', true], 'Escape while typing left the full screen, and only that');
    console.log('PASS Escape while typing leaves the full screen (after the @ menu took the first one)');
    await press(wc, '[data-doc-full]');
    await js(wc, 'document.activeElement && document.activeElement.blur()');
    await key(wc, 'Escape');
    seen = await layout();
    assert.deepEqual([seen.full, seen.workspace], ['0', true], 'Escape outside the editor leaves the full screen and never the workspace');
    await press(wc, '[data-doc-full]');
    // Its button stays clear of the controls in the window's top-right corner (Connections, the bell, test mode).
    const clear = await js(wc, `(()=>{const b=document.querySelector('[data-doc-full]').getBoundingClientRect(),c=document.querySelector('[data-window-controls]').getBoundingClientRect();return b.right<=c.left||b.bottom<=c.top||b.top>=c.bottom})()`);
    assert.equal(clear, true, 'the full-screen button is not under the window\'s controls');
    await press(wc, '[data-doc-full]');
    assert.equal((await layout()).full, '0', 'the button leaves it too');
    console.log('PASS Escape outside the editor, and the button, leave the full screen; the workspace stays open');
    console.log('SMOKE OK');
  } catch (error) {
    console.error(error);
    const wc = BrowserWindow.getAllWindows()[0]?.webContents;
    if (wc) console.error('The strip then:', JSON.stringify(await strip(wc).catch(() => null), null, 1));
    process.exitCode = 1;
  } finally {
    app.exit(process.exitCode || 0);
  }
});
