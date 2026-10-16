'use strict';

// npm run build && npx electron scripts/smoke-ui-10-16.cjs
// Hudson's "User Interface" notes of 2026-10-16, driven in the real app, hidden, against disposable data: the sidebar's
// toggle and clock over Settings and New note; Search with no hints under it; Agents with no Earlier and no Repositories
// section, a row three days old gone, a black dot on what waits, × on hover, a click going where the agent ran (a note, a
// sticky's quick task); archived versions under their project in Projects' More; a project's sources by last opened.
// ENGELBART_UI_SHOTS=<dir> saves pictures of each.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-ui-smoke-'));
app.setPath('userData', path.join(root, 'electron'));
process.env.ENGELBART_HOME_DIR = root;
process.env.ENGELBART_SUMMARIES = 'off';
process.env.ENGELBART_CONNECT_OFFER = 'off';
process.env.ENGELBART_TOOLS_FAKE = JSON.stringify({ claude: '2.1.300', codex: '0.155.1' });
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
const click = async (wc, { x, y }) => {
  wc.focus();
  await pause();
  wc.sendInputEvent({ type: 'mouseMove', x, y });
  wc.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x, y });
  wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x, y });
  await pause(200);
};
const hover = async (wc, { x, y }) => { wc.sendInputEvent({ type: 'mouseMove', x, y }); await pause(150); };
const key = async (wc, keyCode) => { wc.sendInputEvent({ type: 'keyDown', keyCode }); wc.sendInputEvent({ type: 'keyUp', keyCode }); await pause(60); };
const rect = (wc, selector) => js(wc, `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;const r=el.getBoundingClientRect();if(!r.width)return null;return{x:Math.round(r.x+Math.min(r.width/2,60)),y:Math.round(r.y+r.height/2),left:r.left,right:r.right,top:r.top,bottom:r.bottom}})()`);
const press = async (wc, selector) => { const at = await until(() => rect(wc, selector), selector); await click(wc, at); };
const has = (wc, selector) => js(wc, `!!document.querySelector(${JSON.stringify(selector)})`);
const texts = (wc, selector) => js(wc, `[...document.querySelectorAll(${JSON.stringify(selector)})].map((el)=>el.textContent.trim())`);
const SHOTS = process.env.ENGELBART_UI_SHOTS;
async function shot(wc, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await pause(250);
  const picture = await wc.capturePage(undefined, { stayHidden: true, stayAwake: true });
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), picture.toPNG());
}
const api = (wc, call) => js(wc, `window.engelbartAPI.${call}`);
const J = JSON.stringify;

app.whenReady().then(async () => {
  try {
    const win = await until(() => BrowserWindow.getAllWindows()[0], 'app window');
    win.setFocusable(false);
    win.setSize(1440, 900);
    const wc = win.webContents;
    wc.setBackgroundThrottling(false);
    await until(() => js(wc, '!!window.engelbartAPI && !!document.querySelector("button")').catch(() => false), 'app bootstrap');

    /* ------------------------------------------------ a project to look at */
    const made = await api(wc, `createProjectWithWelcome({name:'Engelbart', directory:${J(root)}})`);
    const pid = made.project.id;
    const ws = async (name, parentId = null) => (await api(wc, `createWorkspace(${J(pid)}, ${J({ name, parentId })})`)).id;
    const ui = await ws('User Interface');
    const sidebar = await ws('Sidebar', ui);
    await ws('Middle Canvas', ui);
    const onboarding = await ws('Onboarding');
    await ws('Agents');
    await ws('Library');
    await ws('Release');
    // Onboarding written in, then cleared: one archived version.
    await api(wc, `writeDoc(${J(pid)}, ${J({ kind: 'workspace', workspaceId: onboarding })}, 'The first onboarding plan\\n')`);
    await api(wc, `clearWorkspace(${J(pid)}, ${J(onboarding)})`);
    const notes = [];
    for (const name of ['Old requirements', 'Sidebar brainstorming', 'Iconography']) {
      notes.push(await api(wc, `createNote(${J(pid)}, ${J({ name, workspaceId: sidebar })})`));
      await pause(30);
    }
    await api(wc, `linkToWorkspace(${J(pid)}, ${J(sidebar)}, ${J(notes.map((note) => note.id))})`);
    const dataRoot = path.join(root, '.engelbart');
    const stateFile = path.join(dataRoot, 'state.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const now = Date.now(), iso = (ms) => new Date(ms).toISOString();
    // An answer that waits, asked in a note of Sidebar.
    state.agents = [{ id: 'ask-1', kind: 'bart', projectId: pid, workspaceId: sidebar, doc: { kind: 'note', id: notes[0].id }, status: 'waiting', started: iso(now - 9 * 60000), finished: iso(now - 4 * 60000) }];
    state.projectId = pid;
    state.workspaceId = ui;
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    const projectDir = path.join(dataRoot, made.project.slug || 'engelbart');
    const task = (id, status, title, workspaceId, ago, more = {}) => {
      const dir = path.join(projectDir, 'builds', id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify({ id, kind: 'build', projectId: pid, workspaceId, title, provider: 'claude', model: 'opus', status, messages: [], created: iso(now - ago), updated: iso(now - ago), ...more }));
    };
    task('a1b2c3d4e5', 'needs-you', 'New sidebar', sidebar, 30 * 60000);
    task('b1b2c3d4e5', 'accepted', 'Copy button in the lower left', ui, 26 * 3600000);
    task('c1b2c3d4e5', 'accepted', 'Four days old', ui, 4 * 24 * 3600000);
    task('d1b2c3d4e5', 'failed', 'The archived workspace should open', null, 2 * 3600000, { kind: 'quick', postItId: 'p-1', postIt: 'The archived workspace should open' });
    wc.reload();
    await until(() => js(wc, '!!document.querySelector("main [data-editor]") && !!document.querySelector("[data-sb-project-row]")').catch(() => false), 'the workspace and its sidebar');
    await pause(800);

    /* ------------------------------------------------ the title bar */
    const toggle = await rect(wc, '[data-sidebar-toggle]'), clock = await rect(wc, '[data-recent-pages]');
    const gear = await rect(wc, '[data-sb-settings]'), compose = await rect(wc, '[data-sb-new-note]');
    assert.ok(Math.abs(toggle.left - gear.left) <= 2 && Math.abs(clock.left - compose.left) <= 2, `toggle and clock over Settings and New note: ${J({ toggle, clock, gear, compose })}`);
    await shot(wc, '01-sidebar');

    /* ------------------------------------------------ Search: no hints */
    await press(wc, '[data-sb-fixed-row="search"]');
    await until(() => has(wc, '[data-sb-search-dialog]'), 'search');
    assert.equal(await js(wc, 'document.querySelector("[data-sb-search-dialog]").textContent.includes("to move")'), false, 'no ↑↓ hint');
    await shot(wc, '02-search');
    await key(wc, 'Escape');

    /* ------------------------------------------------ Agents */
    await press(wc, '[data-sb-trigger="agents"]');
    await until(() => has(wc, '[data-sb-panel="agents"] [data-agent-entry]'), 'agents rows');
    const panelText = await js(wc, 'document.querySelector("[data-sb-panel=agents]").textContent');
    assert.ok(!panelText.includes('Earlier') && !panelText.includes('Repositories') && !panelText.includes('to look at'), `no Earlier, Repositories or "to look at": ${panelText}`);
    const shown = await js(wc, '[...document.querySelectorAll("[data-agent-entry]")].map((el)=>el.dataset.agentEntry)');
    assert.ok(!shown.includes('build:c1b2c3d4e5'), 'a row four days old is gone');
    assert.ok(shown.includes('build:b1b2c3d4e5'), 'one done yesterday is among what finished');
    assert.equal(await js(wc, 'document.querySelectorAll("[data-sb-panel=agents] [data-agent-dot]").length'), 3, 'a dot on each that waits: the failed quick task, the Build that needs you, the answer');
    assert.ok(panelText.includes('A sticky'), 'a sticky, not a post-it');
    const quickRow = await rect(wc, '[data-agent-entry="build:d1b2c3d4e5"]');
    await hover(wc, quickRow);
    await shot(wc, '03-agents-hover');
    assert.equal(await js(wc, 'getComputedStyle(document.querySelector("[data-agent-dismiss=\\"build:b1b2c3d4e5\\"]")).opacity'), '0', 'the × only on hover');

    // × puts a row away.
    const doneRow = await rect(wc, '[data-agent-entry="build:b1b2c3d4e5"]');
    await hover(wc, doneRow);
    await press(wc, '[data-agent-dismiss="build:b1b2c3d4e5"]');
    await until(async () => !(await has(wc, '[data-agent-entry="build:b1b2c3d4e5"]')), 'the × removes it');

    // The quick task: its card, the stickies in sight.
    await press(wc, '[data-agent-entry="build:d1b2c3d4e5"]');
    await until(() => has(wc, '[data-post-it-task="d1b2c3d4e5"]'), 'the quick task\'s card');
    await shot(wc, '04-quick-task');
    await key(wc, 'Escape');
    await pause(200);
    if (await has(wc, '[data-post-it-task]')) await click(wc, { x: 700, y: 450 });

    // The answer asked in a note: that note in front, in its project.
    await press(wc, '[data-sb-trigger="agents"]');
    await until(() => has(wc, '[data-agent-entry="agent:ask-1"]'), 'the answer');
    await press(wc, '[data-agent-entry="agent:ask-1"]');
    await until(() => js(wc, `document.querySelector('[data-workspace-here]')?.dataset.workspaceHere === ${J(sidebar)}`), 'in Sidebar');
    await until(() => js(wc, `!!document.querySelector('[data-doc-tab=${J(notes[0].id)}]')`), 'the note\'s tab');
    await shot(wc, '05-answer-note');

    // Clicked: no dot on it any more.
    await press(wc, '[data-sb-trigger="agents"]');
    await until(() => has(wc, '[data-agent-entry="agent:ask-1"]').then(async (yes) => yes || !(await has(wc, '[data-agent-entry="agent:ask-1"]'))), 'agents again');
    if (await has(wc, '[data-agent-entry="agent:ask-1"]')) assert.equal(await has(wc, '[data-agent-entry="agent:ask-1"] [data-agent-dot]'), false, 'clicked: no dot');
    await key(wc, 'Escape');

    /* ------------------------------------------------ the project's sources, last opened first */
    const order = () => js(wc, '[...document.querySelectorAll("[data-sb-folder-rows=project] [data-sb-source]")].map((el)=>el.textContent.trim())');
    const before = await order();
    assert.equal(before[0], 'Old requirements', `opened last first: ${J(before)}`);
    await press(wc, `[data-sb-folder-rows="project"] [data-sb-source="${notes[2].id}"]`);
    await until(async () => (await order())[0] === 'Iconography', 'the note opened goes to the top');
    await shot(wc, '06-sources-order');

    /* ------------------------------------------------ archived versions under their project */
    await press(wc, '[data-sb-more="projects"]');
    await until(() => has(wc, '[data-sb-panel="projects"]'), 'every project');
    assert.equal(await js(wc, 'document.querySelector("[data-sb-panel=projects]").textContent.includes("Archived")'), false, 'no Archived section');
    if (!(await has(wc, `[data-sb-panel="projects"] [data-parent="${onboarding}"] [data-sb-version]`))) await press(wc, `[data-sb-panel="projects"] [data-tree-fold="${onboarding}"]`);
    await until(() => has(wc, `[data-sb-panel="projects"] [data-parent="${onboarding}"] [data-sb-version]`), 'the version under Onboarding');
    await shot(wc, '07-projects-archived');
    await press(wc, `[data-sb-panel="projects"] [data-parent="${onboarding}"] [data-sb-version]`);
    await until(() => js(wc, `document.querySelector('[data-workspace-here]')?.dataset.workspaceHere === ${J(onboarding)}`), 'the version opens in Onboarding');
    await shot(wc, '08-version-open');

    const errors = await js(wc, 'window.__engelbartErrors || []').catch(() => []);
    assert.deepEqual(errors, []);
    console.log('smoke-ui-10-16: ok');
    app.exit(0);
  } catch (error) {
    console.error(error);
    try { const wc = BrowserWindow.getAllWindows()[0].webContents; if (SHOTS) { const picture = await wc.capturePage(undefined, { stayHidden: true, stayAwake: true }); fs.writeFileSync(path.join(SHOTS, 'failed.png'), picture.toPNG()); } } catch { /* no picture */ }
    app.exit(1);
  }
});
