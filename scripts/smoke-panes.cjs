'use strict';

// npm run build && npx electron scripts/smoke-panes.cjs
// Runs the real app, hidden, against disposable project/user data and the fake @bart, and drives the middle column's
// full screen and the panes opened beside the document (MATH-23, MATH-103: src/renderer/screens/Workspace.jsx,
// workspace/DocPane.jsx, model/panes.js) with real (synthetic) input: a note's mention opens its note to the right and
// stays marked and in sight, the two panes side by side at half the column each; with the Stage open at 1440px the column
// is full with one beside, so another mention, in either pane, replaces the rightmost; the split icon is greyed out then,
// and the full screen's wider column takes new panes, a mention's and the split icon's, side by side at equal widths, and
// hides the ones that do not fit when the Stage comes back, showing them again when it goes; × closes one pane only; a
// note already on the left is not opened again, and ⌘Z in one pane leaves the other's typing; a workspace's mention opens
// its document beside; ⌘-click still opens a tab, @bart in a pane is answered there, each tab keeps its own panes when
// another is in front and across a reload; and Escape leaves the full screen only once the line, the @ menu, the title
// field or the + menu has had its own.
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
process.env.ENGELBART_CONNECT_OFFER = 'off'; // Connect your library's one-time popup would cover the workspace
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
const VIEW_SAVED = 900; // ms: past Workspace.jsx's VIEW_SAVE_DELAY, the view is with main
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
    const second = await api(`createWorkspace(${JSON.stringify(pid)}, {name:'Second'})`);
    const write = (ref, text) => api(`writeDoc(${JSON.stringify(pid)}, ${JSON.stringify(ref)}, ${JSON.stringify(text)})`);
    const read = (ref) => api(`readDoc(${JSON.stringify(pid)}, ${JSON.stringify(ref)})`);
    const noteRef = (name) => ({ kind: 'note', id: notes[name].id });
    const filler = Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of the plan, long enough to scroll.`).join('\n');
    await write({ kind: 'workspace', workspaceId: wid }, `Plan\nSee @[Alpha] and @[Beta], or @[Second](ws:${second.id}).\n${filler}\n`);
    await write({ kind: 'workspace', workspaceId: second.id }, 'Second body\nOn to @[Gamma].\n');
    await write(noteRef('Alpha'), 'Alpha body\nGo on to @[Gamma].\n');
    await write(noteRef('Beta'), 'Beta body\n');
    await write(noteRef('Gamma'), 'Gamma body\nThen @[Delta], or back to @[Alpha].\n');
    await write(noteRef('Delta'), 'Delta body\n');
    // Back in the welcome workspace (making Second may have moved the window there), its document in front.
    wc.reload();
    await until(() => js(wc, '!!document.querySelector("[data-doc-tab]")').catch(() => false), 'the workspace screen');
    await js(wc, `(()=>{const row=[...document.querySelectorAll('aside[aria-label="Sidebar"] *')].find((el)=>el.children.length===0&&el.textContent.trim()===${JSON.stringify(WS)});if(row)row.click()})()`);
    await until(() => js(wc, `!!document.querySelector(${JSON.stringify(`${PANE(0)} [data-editor] [data-mention="Alpha"]`)})`).catch(() => false), 'the workspace document');
    await pause(400);
    // Equal shares of the column (half each for two), and side by side from its left edge, nothing scrolled sideways.
    const half = (s) => s.panes.every((p) => Math.abs(p.width - s.width / s.panes.length) <= 2);
    const sideBySide = (s, n = 2) => s.panes.length === n && s.panes[0].left === 0 && s.panes.every((p, i) => !i || Math.abs(p.left - (s.panes[i - 1].left + s.panes[i - 1].width)) <= 1) && s.scrollWidth === s.width && s.left === 0;
    const splitIcon = () => js(wc, `(()=>{const b=document.querySelector('[data-split-pane]');return b?{on:b.dataset.splitPane,title:b.title}:null})()`);
    // The marked mention in the left pane is on screen: inside its pane and the column, not under the pane beside.
    const markedInSight = () => js(wc, `(()=>{const m=document.querySelector('${PANE(0)} [data-mention][data-beside]');if(!m)return false;const r=m.getBoundingClientRect(),main=document.querySelector('main').getBoundingClientRect(),right=document.querySelector('${PANE(1)}').getBoundingClientRect();const at=document.elementFromPoint(r.left+2,r.top+r.height/2);return r.width>0&&r.left>=main.left&&r.right<=right.left&&r.right<=main.right&&!!at&&!!at.closest('${PANE(0)}')})()`);

    /* ------------------------------------------------ the document alone is as it was */
    const alone = await settledStrip(wc);
    assert.equal(alone.panes.length, 1);
    assert.equal(alone.panes[0].width, alone.width, 'the document fills the column');
    assert.equal(alone.scrollWidth, alone.width, 'nothing to scroll sideways');
    assert.equal(await js(wc, `!!document.querySelector('[data-pane-close]')`), false, 'no ×');
    await shot(wc, '0-alone');
    console.log(`PASS the document alone fills the middle column (${alone.width}px), nothing beside it`);

    /* ------------------------------------------------ (2) a note's mention opens it beside: two halves, the mention marked and in sight */
    const pageTop = () => js(wc, `document.querySelector('${PANE(0)} [data-editor]').parentElement.parentElement.scrollTop`);
    await js(wc, `document.querySelector('${PANE(0)} [data-editor]').parentElement.parentElement.scrollTop = 20`);
    await pause(400); // past the editor's report of where it was scrolled to
    const scrolled = await pageTop();
    await press(wc, `${PANE(0)} [data-editor] [data-mention="Alpha"]`);
    let now = await settledStrip(wc);
    assert.deepEqual(now.panes.map((p) => p.title), [WS, 'Alpha'], 'the note beside the document');
    assert.deepEqual(now.panes[0].marked, ['Alpha'], 'the mention stays marked');
    assert.deepEqual(now.panes[1].rows.slice(0, 1), ['Alpha body']);
    assert.ok(sideBySide(now), `side by side, nothing covered, nothing scrolled (${JSON.stringify(now.panes.map((p) => [p.left, p.width]))}, column ${now.width}px)`);
    assert.ok(half(now), 'each half the column');
    assert.ok(now.panes.every((p) => !p.folded), 'no folded strip');
    assert.equal(await markedInSight(), true, 'the marked mention is in sight');
    assert.ok(scrolled > 0, 'the document was scrolled down a little');
    assert.equal(await pageTop(), scrolled, 'and is still where it was');
    await shot(wc, '1-beside');
    console.log(`PASS a note's mention opens it to the right, side by side (${now.panes.map((p) => `${p.width}px`).join(' + ')} of ${now.width}px), its mention marked and in sight`);

    /* ------------------------------------------------ another mention in the document replaces it */
    await press(wc, `${PANE(0)} [data-editor] [data-mention="Beta"]`);
    now = await settledStrip(wc);
    assert.deepEqual(now.panes.map((p) => p.title), [WS, 'Beta']);
    assert.deepEqual(now.panes[0].marked, ['Beta'], 'the new mention is the marked one');
    console.log('PASS another mention in the document replaces the pane beside it');

    /* ------------------------------------------------ (1) the column full: a mention in the right pane replaces that pane */
    // At 1440px with the Stage open the column fits two panes (model/panes.js paneRoom): the document and one beside it.
    await press(wc, `${PANE(0)} [data-editor] [data-mention="Alpha"]`);
    await settledStrip(wc);
    await press(wc, `${PANE(1)} [data-editor] [data-mention="Gamma"]`);
    now = await settledStrip(wc);
    assert.deepEqual(now.panes.map((p) => p.title), [WS, 'Gamma'], 'Gamma took Alpha\'s place; no room for a third pane');
    assert.ok(sideBySide(now) && half(now), 'still two halves, nothing scrolled');
    await press(wc, `${PANE(1)} [data-editor] [data-mention="Delta"]`);
    now = await settledStrip(wc);
    assert.deepEqual(now.panes.map((p) => p.title), [WS, 'Delta']);
    assert.equal(await js(wc, `document.querySelectorAll('main [data-doc-pane]').length`), 2);
    await shot(wc, '2-replaced');
    console.log(`PASS the column full (${now.width}px fits two), a mention in the right pane replaces it`);

    /* ------------------------------------------------ (MATH-103, MATH-84) as many panes as fit; the split icon */
    assert.deepEqual(await splitIcon(), { on: '0', title: 'No room for another pane. Close one or widen the window.' }, 'the column full: the split icon greyed out, saying why');
    await press(wc, '[data-split-pane]');
    assert.equal(await js(wc, `!!document.querySelector('[data-note-picker]')`), false, 'greyed out, it opens nothing');
    await press(wc, '[data-doc-full]'); // the Stage away: the column has the window but the sidebar
    now = await settledStrip(wc);
    assert.deepEqual(now.panes.map((p) => p.title), [WS, 'Delta']);
    assert.equal((await splitIcon()).on, '1', 'room again: the split icon is on');
    await press(wc, `${PANE(0)} [data-editor] [data-mention="Alpha"]`);
    now = await settledStrip(wc);
    assert.deepEqual(now.panes.map((p) => p.title), [WS, 'Delta', 'Alpha'], 'room: a mention opens a new pane at the right');
    assert.ok(sideBySide(now, 3) && half(now), `three side by side, equal widths (${now.panes.map((p) => `${p.width}px`).join(' + ')} of ${now.width}px)`);
    assert.deepEqual(now.panes[0].marked, ['Alpha'], 'its mention marked');
    await press(wc, '[data-split-pane]');
    await until(() => js(wc, `!!document.querySelector('[data-note-picker]')`), 'the split icon\'s menu');
    await until(() => js(wc, `document.activeElement && document.activeElement.matches('[data-note-search]')`), 'its search field focused');
    await typeKeys(wc, 'Beta');
    await key(wc, 'Enter', { ch: '\r' });
    now = await settledStrip(wc);
    assert.deepEqual(now.panes.map((p) => p.title), [WS, 'Delta', 'Alpha', 'Beta'], 'the note picked from the split icon in a new pane at the right');
    assert.ok(sideBySide(now, 4) && half(now), `four side by side, equal widths (${now.panes.map((p) => `${p.width}px`).join(' + ')})`);
    assert.ok(now.panes.every((p) => p.width >= 280), 'none narrower than PANE_MIN');
    assert.equal((await splitIcon()).on, '0', 'four fill the column: greyed out again');
    await shot(wc, '2b-four');
    await press(wc, '[data-doc-full]'); // the Stage back: room for two
    now = await settledStrip(wc);
    assert.deepEqual(now.panes.map((p) => p.title), [WS, 'Delta'], 'the panes that do not fit are hidden');
    assert.ok(sideBySide(now) && half(now), 'and nothing scrolls sideways');
    await press(wc, '[data-doc-full]');
    now = await settledStrip(wc);
    assert.deepEqual(now.panes.map((p) => p.title), [WS, 'Delta', 'Alpha', 'Beta'], 'room again: they come back as they were');
    win.setBounds({ x: 0, y: 0, width: 1000, height: 900 }); // a narrower window: 699px of column, room for two
    now = await until(async () => { const seen = await settledStrip(wc); return seen.panes.length === 2 ? seen : null; }, 'the window narrowed');
    assert.deepEqual(now.panes.map((p) => p.title), [WS, 'Delta'], 'a narrower window hides the rightmost panes');
    assert.ok(sideBySide(now) && half(now));
    win.setBounds({ x: 0, y: 0, width: 1440, height: 900 });
    now = await until(async () => { const seen = await settledStrip(wc); return seen.panes.length === 4 ? seen : null; }, 'the window widened');
    assert.deepEqual(now.panes.map((p) => p.title), [WS, 'Delta', 'Alpha', 'Beta'], 'widened again, they are back');
    await press(wc, '[data-pane-close="2"]');
    now = await settledStrip(wc);
    assert.deepEqual(now.panes.map((p) => p.title), [WS, 'Delta', 'Beta'], '× on the middle pane closes that one only');
    assert.ok(sideBySide(now, 3) && half(now));
    await press(wc, '[data-pane-close="2"]');
    await press(wc, '[data-doc-full]');
    now = await settledStrip(wc);
    assert.deepEqual(now.panes.map((p) => p.title), [WS, 'Delta']);
    console.log('PASS the full screen fits four panes: a mention and the split icon open new ones at the right; the Stage back, or a narrower window, hides those that do not fit, and they come back with the room; × closes one pane only');

    /* ------------------------------------------------ × closes the pane beside */
    await press(wc, '[data-pane-close="1"]');
    now = await settledStrip(wc);
    assert.deepEqual(now.panes.map((p) => p.title), [WS], '× closed it');
    assert.deepEqual(now.panes[0].marked, [], 'nothing is marked any more');
    console.log('PASS × closes the pane beside');

    /* ------------------------------------------------ ⌘-click opens a tab, as before */
    await press(wc, `${PANE(0)} [data-editor] [data-mention="Alpha"]`, ['meta']);
    now = await settledStrip(wc);
    assert.deepEqual(now.panes.map((p) => p.title), ['Alpha'], 'the note in front, as its tab');
    console.log('PASS ⌘-click on a note\'s mention opens its tab');

    /* ------------------------------------------------ (4) the note open on the left is not opened again; ⌘Z stays in its pane */
    await press(wc, `${PANE(0)} [data-editor] [data-mention="Gamma"]`);
    await settledStrip(wc);
    await press(wc, `${PANE(1)} [data-editor] [data-mention="Alpha"]`);
    now = await settledStrip(wc);
    assert.deepEqual(now.panes.map((p) => p.title), ['Alpha', 'Gamma'], 'Alpha, already on the left, did not open beside');
    assert.equal(now.left, 0, 'the left pane is the one in sight');
    console.log('PASS a mention of the note already on the left leaves the panes as they are and shows the left one');
    await press(wc, `${PANE(0)} [data-editor] [data-line="0"] .t`);
    await key(wc, 'End');
    await typeKeys(wc, ' left');
    await press(wc, `${PANE(1)} [data-editor] [data-line="0"] .t`);
    await key(wc, 'End');
    await typeKeys(wc, ' right');
    now = await settledStrip(wc);
    assert.deepEqual([now.panes[0].rows[0], now.panes[1].rows[0]], ['Alpha body left', 'Gamma body right']);
    for (let i = 0; i < 12; i++) await key(wc, 'z', { modifiers: ['meta'] });
    now = await settledStrip(wc);
    assert.equal(now.panes[1].rows[0], 'Gamma body', '⌘Z in the right pane undid its own typing');
    assert.equal(now.panes[0].rows[0], 'Alpha body left', 'and none of the left pane\'s');
    await until(async () => String(await read(noteRef('Alpha'))).startsWith('Alpha body left'), 'the left pane\'s typing saved');
    await until(async () => String(await read(noteRef('Gamma'))).startsWith('Gamma body\n'), 'the right pane\'s undo saved');
    await shot(wc, '3-two-notes');
    console.log('PASS ⌘Z in one pane undoes that pane\'s typing only');

    /* ------------------------------------------------ each tab keeps its own panes */
    await press(wc, '[data-doc-tab="ws"]');
    now = await settledStrip(wc);
    assert.equal(now.panes.length, 1, 'the Workspace tab has none of its own');
    assert.ok(now.panes[0].rows[0] === 'Plan', 'the workspace document is in front');
    await press(wc, `[data-doc-tab="${notes.Alpha.id}"]`);
    now = await settledStrip(wc);
    assert.deepEqual(now.panes.map((p) => p.title), ['Alpha', 'Gamma'], 'back on Alpha\'s tab: its pane is kept and shown again');
    await pause(VIEW_SAVED);
    wc.reload(); // as a relaunch reads them: the view main kept (state.json `views`)
    await until(() => js(wc, `!!document.querySelector(${JSON.stringify(`${PANE(1)} [data-editor] [data-line]`)})`).catch(() => false), 'the panes after the reload');
    now = await settledStrip(wc);
    assert.deepEqual(now.panes.map((p) => p.title), ['Alpha', 'Gamma'], 'and after a reload');
    await press(wc, '[data-doc-tab="ws"]');
    now = await settledStrip(wc);
    assert.equal(now.panes.length, 1);
    console.log('PASS switching tab keeps each tab\'s panes: they are shown again on its return, and after a reload');

    /* ------------------------------------------------ (5) a workspace's mention opens its document beside */
    await press(wc, `${PANE(0)} [data-editor] [data-mention="Second"]`);
    now = await settledStrip(wc);
    assert.deepEqual(now.panes.map((p) => p.title), [WS, 'Second'], 'Second\'s document beside; this workspace stays in front');
    assert.deepEqual(now.panes[1].rows.slice(0, 1), ['Second body']);
    assert.deepEqual(now.panes[0].marked, ['Second'], 'its mention marked');
    assert.ok(sideBySide(now) && half(now));
    assert.equal(await markedInSight(), true);
    assert.equal(await js(wc, `document.querySelector('${PANE(1)}').getAttribute('aria-label')`), 'Workspace: Second');
    await press(wc, `${PANE(1)} [data-editor] [data-line="0"] .t`);
    await key(wc, 'End');
    await typeKeys(wc, ' typed beside');
    await until(async () => String(await read({ kind: 'workspace', workspaceId: second.id })).startsWith('Second body typed beside'), 'typing beside saved in Second\'s document');
    assert.ok(!/typed beside/.test(String(await read({ kind: 'workspace', workspaceId: wid }))), 'none in this one');
    await press(wc, `${PANE(1)} [data-editor] [data-mention="Gamma"]`);
    now = await settledStrip(wc);
    assert.deepEqual(now.panes.map((p) => p.title), [WS, 'Gamma'], 'a note\'s mention in it replaces it in turn');
    await shot(wc, '4-workspace-beside');
    console.log('PASS a workspace\'s mention opens its document in the right pane, typed in and saved there');

    /* ------------------------------------------------ @bart in a pane is answered in that note */
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

    /* ------------------------------------------------ (3) full screen, and Escape only once nothing else used it */
    const layout = () => js(wc, `({full:document.querySelector('[data-doc-full]').dataset.docFull,rail:getComputedStyle(document.querySelector('aside[aria-label="Sidebar"]')).display,right:getComputedStyle(document.querySelector('section[aria-label="Right pane"]')).display,main:Math.round(document.querySelector('main').getBoundingClientRect().width),window:innerWidth,workspace:!!document.querySelector('main [data-doc-pane]')})`);
    const focused = () => js(wc, `(()=>{const a=document.activeElement;return !a||a===document.body?'nothing':a.matches('[data-editor]')?'line':a.matches('[data-doc-title]')?'title':a.matches('[data-note-search]')?'+ menu':a.tagName})()`);
    const escape = async (label, { full, has }) => {
      await key(wc, 'Escape');
      await pause(120);
      const seen = await layout();
      assert.equal(seen.full, full ? '1' : '0', `${label}: ${full ? 'still' : 'no longer'} full screen`);
      assert.equal(seen.workspace, true, `${label}: the workspace is still open`);
      if (has) assert.equal(await focused(), has, `${label}: then ${has} has the key`);
    };
    await press(wc, '[data-doc-full]');
    let seen = await layout();
    assert.deepEqual([seen.full, seen.right], ['1', 'none'], 'no Stage');
    assert.notEqual(seen.rail, 'none', 'the sidebar stays (2026-10-15)');
    assert.ok(seen.main < seen.window, 'the middle column has the window but the sidebar');
    now = await settledStrip(wc);
    assert.ok(sideBySide(now) && half(now), `the document and the note side by side, half the window each (${now.panes.map((p) => `${p.width}px`).join(' + ')})`);
    await shot(wc, '6-full');
    console.log(`PASS the full screen hides the Stage and keeps the sidebar (the column is ${seen.main}px; panes ${now.panes.map((p) => `${p.width}px`).join(' + ')})`);
    // The caret in a line, the @ menu open: the menu, then the line, then the full screen.
    await press(wc, `${PANE(0)} [data-editor] [data-line="0"] .t`);
    await key(wc, 'End');
    await typeKeys(wc, '@');
    await until(() => js(wc, `!!document.querySelector('[data-mention-menu]')`), 'the @ menu');
    await escape('the @ menu open', { full: true, has: 'line' });
    assert.equal(await js(wc, `!!document.querySelector('[data-mention-menu]')`), false, 'the @ menu shut');
    await key(wc, 'Backspace');
    await escape('the caret in a line', { full: true, has: 'nothing' });
    await escape('nothing left to use it', { full: false });
    console.log('PASS Escape shuts the @ menu, then takes the caret out of its line, and only the third leaves the full screen');
    // A field focused: the title.
    await press(wc, '[data-doc-full]');
    await press(wc, `${PANE(1)} [data-doc-title]`);
    assert.equal(await focused(), 'title');
    await escape('the title focused', { full: true, has: 'nothing' });
    await escape('then', { full: false });
    console.log('PASS Escape in a title field leaves the field first, the full screen on the next one');
    // A menu open: the + menu beside the tabs, its search field focused.
    await press(wc, '[data-doc-full]');
    await press(wc, '[data-note-plus]');
    await until(() => js(wc, `!!document.querySelector('[data-note-picker]')`), 'the + menu');
    await until(async () => (await focused()) === '+ menu', 'its search field focused');
    await escape('the + menu open', { full: true });
    assert.equal(await js(wc, `!!document.querySelector('[data-note-picker]')`), false, 'the + menu shut');
    await js(wc, 'document.activeElement && document.activeElement.blur()');
    await escape('then', { full: false });
    console.log('PASS Escape with the + menu open shuts it; the full screen goes on the next one');
    // Nothing focused at all: straight out, and never the workspace.
    await press(wc, '[data-doc-full]');
    await js(wc, 'document.activeElement && document.activeElement.blur()');
    await escape('nothing focused', { full: false });
    await press(wc, '[data-doc-full]');
    // Its button stays clear of the controls in the window's top-right corner (the bell, the gear, test mode).
    const clear = await js(wc, `(()=>{const b=document.querySelector('[data-doc-full]').getBoundingClientRect(),c=document.querySelector('[data-window-controls]').getBoundingClientRect();return b.right<=c.left||b.bottom<=c.top||b.top>=c.bottom})()`);
    assert.equal(clear, true, 'the full-screen button is not under the window\'s controls');
    await press(wc, '[data-doc-full]');
    assert.equal((await layout()).full, '0', 'the button leaves it too');
    console.log('PASS Escape with nothing focused, and the button, leave the full screen; the workspace stays open');
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
