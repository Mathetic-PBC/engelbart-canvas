'use strict';

// npm run build && npx electron scripts/smoke-sidebar.cjs
// Runs the real app, hidden, against disposable data, and drives the workspace sidebar (src/renderer/workspace/Rail.jsx,
// 2026-10-07) with real (synthetic) input: a project with workspaces nested two deep, notes, files and a folder linked to
// one of them, a star, an agent waiting in another workspace and two Builds. It checks the head (the project's name, its
// menu, Settings, Search), the fixed rows and their panels (Inbox, Agents, Connections, Library, Add sources), Workspaces
// (the three worked in last, a sub-workspace marked, a new one named in its dialog, More), Your sources (its groups, a
// star, More), the foot (Hide / Show stickies) and the sidebar folding away (⌘\).
// ENGELBART_SIDEBAR_SHOTS=<dir> saves pictures of each.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-sidebar-smoke-'));
app.setPath('userData', path.join(root, 'electron'));
process.env.ENGELBART_HOME_DIR = root;
process.env.ENGELBART_SUMMARIES = 'off';
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
const ED = 'main [data-editor]';
const click = async (wc, { x, y }, { button = 'left', modifiers = [] } = {}) => {
  wc.focus();
  await pause();
  wc.sendInputEvent({ type: 'mouseMove', x, y });
  wc.sendInputEvent({ type: 'mouseDown', button, clickCount: 1, x, y, modifiers });
  wc.sendInputEvent({ type: 'mouseUp', button, clickCount: 1, x, y, modifiers });
  await pause(200);
};
const hover = async (wc, { x, y }) => { wc.sendInputEvent({ type: 'mouseMove', x, y }); await pause(120); };
const key = async (wc, keyCode, { ch = null, modifiers = [] } = {}) => {
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  if (ch) wc.sendInputEvent({ type: 'char', keyCode: ch, modifiers });
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await pause(40);
};
const typeKeys = async (wc, text) => { for (const ch of text) await key(wc, ch === ' ' ? 'Space' : ch, { ch }); await pause(150); };
const spot = (wc, selector) => js(wc, `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;const r=el.getBoundingClientRect();if(!r.width)return null;return{x:Math.round(r.x+Math.min(r.width/2,60)),y:Math.round(r.y+r.height/2)}})()`);
const press = async (wc, selector, options) => { const at = await until(() => spot(wc, selector), selector); await click(wc, at, options); };
const has = (wc, selector) => js(wc, `!!document.querySelector(${JSON.stringify(selector)})`);
const texts = (wc, selector) => js(wc, `[...document.querySelectorAll(${JSON.stringify(selector)})].map((el)=>el.textContent.trim())`);
const SHOTS = process.env.ENGELBART_SIDEBAR_SHOTS;
async function shot(wc, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await pause(220); // the panels rise in
  const picture = await wc.capturePage(undefined, { stayHidden: true, stayAwake: true });
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), picture.toPNG());
}
const api = (wc, call) => js(wc, `window.engelbartAPI.${call}`);

app.whenReady().then(async () => {
  try {
    const win = await until(() => BrowserWindow.getAllWindows()[0], 'app window');
    win.setFocusable(false); // synthetic input only; do not capture the user's typing
    win.setSize(1440, 900);
    assert.equal(win.isVisible(), false, 'smoke runs must not show a desktop window');
    const wc = win.webContents;
    wc.setBackgroundThrottling(false);
    await until(() => js(wc, '!!window.engelbartAPI && !!document.querySelector("button")').catch(() => false), 'app bootstrap');

    /* ------------------------------------------------ a project to look at */
    const made = await api(wc, `createProjectWithWelcome({name:'Memex studies', directory:${JSON.stringify(root)}})`);
    const pid = made.project.id;
    const ws = async (name, parentId = null) => (await api(wc, `createWorkspace(${JSON.stringify(pid)}, ${JSON.stringify({ name, parentId })})`)).id;
    const ui = await ws('User Interface');
    const sidebar = await ws('Sidebar', ui);
    await ws('Middle Canvas', ui);
    await ws('Focusing attention', ui);
    await ws('Iconography', sidebar); // a grandchild: never in the sidebar
    const agents = await ws('Agents');
    await ws('Bart build agents', agents);
    await ws('Library');
    await ws('Onboarding');
    const files = path.join(root, 'files');
    fs.mkdirSync(path.join(files, 'notebook'), { recursive: true });
    const write = (name, body) => { const file = path.join(files, name); fs.writeFileSync(file, body); return file; };
    fs.mkdirSync(path.join(files, 'engelbart-canvas', '.git'), { recursive: true }); // a clone: Code
    const paths = [write('Working spheres.pdf', '%PDF-1.4\n%%EOF\n'), write('Reading list.md', '# Reading\n'), write('survey.csv', 'a,b\n1,2\n'), path.join(files, 'notebook'), path.join(files, 'engelbart-canvas')];
    const ids = [];
    for (const file of paths) ids.push((await api(wc, `addLibraryItem(${JSON.stringify(file)})`)).id);
    for (const [url, name] of [['https://worrydream.com/MagicInk/', 'Magic Ink'], ['https://linear.app/now/behind-the-latest-design-refresh', 'Behind the latest design refresh']]) {
      ids.push((await api(wc, `addLibraryItem(${JSON.stringify(url)}, ${JSON.stringify({ name })})`)).id);
    }
    for (const name of ['Sidebar requirements', 'Sidebar brainstorming', 'Iconography', 'Switch Projects', 'Linear references', 'Hand-drawn mockup', 'Old ideas']) {
      const note = await api(wc, `createNote(${JSON.stringify(pid)}, ${JSON.stringify({ name, workspaceId: sidebar })})`);
      ids.push(note.id);
    }
    await api(wc, `linkToWorkspace(${JSON.stringify(pid)}, ${JSON.stringify(sidebar)}, ${JSON.stringify(ids)})`);
    await api(wc, `setStarred(${JSON.stringify(pid)}, ${JSON.stringify(ids[0])}, true)`);
    await api(wc, `setStarred(${JSON.stringify(pid)}, ${JSON.stringify(ids[5])}, true)`);
    // Worked in last: Sidebar, then Agents' child, then Library.
    await api(wc, `recordEdit(${JSON.stringify(pid)}, ${JSON.stringify(sidebar)})`);
    // An agent that finished in another workspace and waits (state.json `agents`), and two Builds (their records).
    const dataRoot = path.join(root, '.engelbart');
    const stateFile = path.join(dataRoot, 'state.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const now = Date.now(), iso = (ms) => new Date(ms).toISOString();
    state.agents = [{ id: 'ask-1', kind: 'bart', projectId: pid, workspaceId: agents, doc: null, status: 'waiting', started: iso(now - 9 * 60000), finished: iso(now - 4 * 60000) }];
    state.projectId = pid;
    state.workspaceId = sidebar;
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    const projectDir = path.join(dataRoot, made.project.slug || 'memex-studies');
    const task = (id, status, title, workspaceId, ago) => {
      const dir = path.join(projectDir, 'builds', id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify({ id, kind: 'build', projectId: pid, workspaceId, title, provider: 'claude', model: 'opus', status, messages: [], created: iso(now - ago), updated: iso(now - ago) }));
    };
    task('a1b2c3d4e5', 'needs-you', 'New sidebar', sidebar, 30 * 60000);
    task('b1b2c3d4e5', 'accepted', 'Copy button in the lower left', ui, 26 * 3600000);
    wc.reload();
    await until(() => js(wc, `!!document.querySelector(${JSON.stringify(ED)}) && !!document.querySelector('[data-sb-workspace]')`).catch(() => false), 'the workspace and its sidebar');
    await pause(600);

    /* ------------------------------------------------ the head, the fixed rows, the sections */
    assert.equal((await texts(wc, '[data-sb-project-name]'))[0], 'Memex studies');
    assert.deepEqual(await texts(wc, '[data-sb-fixed-row]'), ['Inbox1', 'Agents', 'Connections', 'Library', 'Add sources']);
    assert.ok(await has(wc, '[data-sb-fixed-row="inbox"] [data-inbox-dot]'), 'the inbox wears its dot');
    assert.equal(await has(wc, '[data-window-controls] [data-settings] button'), true);
    assert.equal(await js(wc, 'getComputedStyle(document.querySelector("[data-window-controls] [data-settings]")).display'), 'none', 'one gear: the sidebar\'s');
    const rows = await js(wc, '[...document.querySelectorAll("[data-sb-section=workspaces] [data-sb-workspace]")].map((el)=>el.textContent.trim())');
    assert.equal(rows[0], 'User Interface', 'the one holding the workspace open here, worked in last');
    assert.ok(rows.includes('Sidebar'), 'its sub-workspace shown');
    assert.ok(!rows.includes('Iconography'), 'no grandchild');
    assert.ok(await has(wc, '[data-sb-workspace][data-active="1"]'), 'where you are is marked');
    assert.ok(await has(wc, '[data-sb-more="workspaces"]'), 'More, for the rest');
    assert.deepEqual(await js(wc, '[...document.querySelectorAll("[data-sb-group]")].map((el)=>el.dataset.sbGroup)'), ['starred', 'notes', 'websites', 'code', 'files'], 'the groups in order');
    await shot(wc, '01-sidebar');

    /* ------------------------------------------------ panels beside the sidebar */
    for (const [row, panel, name] of [['inbox', 'inbox', '02-inbox'], ['agents', 'agents', '03-agents'], ['connections', 'connections', '04-connections'], ['library', 'library', '05-library'], ['add', 'add', '06-add-sources']]) {
      await press(wc, `[data-sb-fixed-row="${row}"]`);
      await until(() => has(wc, `[data-sb-panel="${panel}"]`), `${panel} panel`);
      const box = await js(wc, `(()=>{const p=document.querySelector('[data-sb-panel="${panel}"]').getBoundingClientRect(),s=document.querySelector('aside[data-sidebar]').getBoundingClientRect();return{left:p.left,right:s.right}})()`);
      assert.ok(box.left >= box.right, `${panel} opens beside the sidebar, not over it`);
      await shot(wc, name);
      await key(wc, 'Escape');
      await until(async () => !(await has(wc, `[data-sb-panel="${panel}"]`)), `Escape closes ${panel}`);
      assert.ok(await has(wc, ED), 'and Escape never leaves the workspace');
    }

    // Add sources: Note, Sticky, the field, disk, GitHub; no search and no Sub-Workspace.
    await press(wc, '[data-sb-fixed-row="add"]');
    await until(() => has(wc, '[data-sb-panel="add"] [data-new="sticky"]'), 'Add sources has Sticky');
    assert.equal(await has(wc, '[data-sb-panel="add"] [data-add-search]'), false, 'no search in Add sources');
    assert.equal(await has(wc, '[data-sb-panel="add"] [data-new="workspace"]'), false, 'no Sub-Workspace in Add sources');
    await key(wc, 'Escape');

    /* ------------------------------------------------ Settings from the sidebar's gear, and Connections' Manage */
    await press(wc, '[data-sb-settings]');
    await until(() => has(wc, '[data-levels-dialog] [data-settings-page="model"][aria-current="page"]'), 'Settings, at Model');
    await key(wc, 'Escape');
    await until(async () => !(await has(wc, '[data-levels-dialog]')), 'Settings closes');
    await press(wc, '[data-sb-fixed-row="connections"]');
    await press(wc, '[data-sb-manage-connections]');
    await until(() => has(wc, '[data-levels-dialog] [data-settings-page="connections"][aria-current="page"]'), 'Settings, at Connections');
    await key(wc, 'Escape');
    await until(async () => !(await has(wc, '[data-levels-dialog]')), 'Settings closes again');
    assert.ok(await has(wc, ED), 'still in the workspace');

    /* ------------------------------------------------ the project menu */
    await press(wc, '[data-sb-trigger="project"]');
    await until(() => has(wc, '[data-sb-panel="project"]'), 'the project menu');
    await press(wc, '[data-sb-switch-project]');
    await until(() => has(wc, '[data-sb-panel="projects"] [data-sb-project]'), 'the projects');
    await shot(wc, '07-project-menu');
    await key(wc, 'Escape');
    await key(wc, 'Escape');
    await until(async () => !(await has(wc, '[data-sb-panel="project"]')), 'the menu closes');

    /* ------------------------------------------------ More: every workspace; a group whole */
    await press(wc, '[data-sb-more="workspaces"]');
    await until(() => has(wc, '[data-sb-panel="workspaces"] [data-sb-all-workspace]'), 'all workspaces');
    await shot(wc, '08-all-workspaces');
    await key(wc, 'Escape');
    if (await has(wc, '[data-sb-more="notes"]')) {
      await press(wc, '[data-sb-more="notes"]');
      await until(() => has(wc, '[data-sb-panel="sources-notes"]'), 'every note');
      await shot(wc, '09-all-notes');
      await key(wc, 'Escape');
    }

    /* ------------------------------------------------ hover, star, right click */
    const first = await until(() => spot(wc, '[data-sb-group-rows="notes"] [data-sb-source]'), 'a note row');
    await hover(wc, first);
    await pause(500);
    await shot(wc, '10-hover-peek');
    await press(wc, '[data-sb-group-rows="notes"] [data-sb-source]', { button: 'right' });
    await until(() => has(wc, '[data-sb-context-menu]'), 'its menu');
    await shot(wc, '11-context-menu');
    await key(wc, 'Escape');

    /* ------------------------------------------------ a star, and a source taken out */
    const star = await js(wc, 'document.querySelector("[data-sb-group-rows=notes] [data-sb-star]").dataset.sbStar');
    await press(wc, `[data-sb-group-rows="notes"] [data-sb-source="${star}"]`, { button: 'right' });
    await until(() => has(wc, '[data-sb-context-menu]'), 'the menu');
    await js(wc, '[...document.querySelectorAll("[data-sb-context-menu] [role=menuitem]")].find((b)=>b.textContent.trim()==="Star").click()');
    await until(() => has(wc, `[data-sb-group-rows="starred"] [data-sb-source="${star}"]`), 'starred: under Starred');
    assert.ok(JSON.parse(fs.readFileSync(stateFile, 'utf8')).starred[pid].includes(star), 'kept in state.json');
    await pause(300); // main's answer to the star
    const gone = await js(wc, `[...document.querySelectorAll('[data-sb-group-rows="notes"] [data-sb-source]')].map((el)=>el.dataset.sbSource).find((id)=>id!==${JSON.stringify(star)})`);
    await hover(wc, await until(() => spot(wc, `[data-sb-group-rows="notes"] [data-sb-source="${gone}"]`), 'a note to take out'));
    await js(wc, `document.querySelector('[data-sb-remove="${gone}"]').click()`);
    await until(async () => !(await has(wc, `[data-sb-group-rows="notes"] [data-sb-source="${gone}"]`)), 'taken out of this workspace');

    /* ------------------------------------------------ Search */
    await press(wc, '[data-sb-search]');
    await until(() => has(wc, '[data-sb-search-dialog]'), 'Search');
    await typeKeys(wc, 'side');
    await until(() => has(wc, '[data-search-result]'), 'results');
    await shot(wc, '12-search');
    await key(wc, 'Escape');
    await until(async () => !(await has(wc, '[data-sb-search-dialog]')), 'Search closes');
    await press(wc, '[data-sb-search]');
    await until(() => has(wc, '[data-sb-search-dialog]'), 'Search again');
    await typeKeys(wc, 'Middle');
    await until(() => has(wc, '[data-search-result^="ws:"]'), 'a workspace found');
    await key(wc, 'Enter', { ch: '\r' });
    await until(async () => (await js(wc, 'document.querySelector("[data-workspace-here]").dataset.workspaceHere')) !== sidebar, 'Enter goes there');
    assert.equal((await texts(wc, '[data-sb-section=workspaces] [data-sb-workspace][data-active="1"]'))[0], 'Middle Canvas');
    await press(wc, `[data-sb-workspace="${sidebar}"]`);
    await until(async () => (await js(wc, 'document.querySelector("[data-workspace-here]").dataset.workspaceHere')) === sidebar, 'and back');

    /* ------------------------------------------------ a new workspace, named */
    await press(wc, '[data-sb-new-workspace]');
    await until(() => has(wc, '[data-sb-new-workspace-dialog]'), 'the dialog');
    await typeKeys(wc, 'Reading group');
    await shot(wc, '13-new-workspace');
    await key(wc, 'Enter', { ch: '\r' });
    await until(async () => (await texts(wc, '[data-sb-section=workspaces] [data-sb-workspace][data-active="1"]'))[0] === 'Reading group', 'made, gone into and first');
    await shot(wc, '14-after-new');

    /* ------------------------------------------------ stickies, and folding the sidebar */
    await press(wc, '[data-toggle-post-its]');
    await until(async () => (await js(wc, 'document.querySelector("[data-toggle-post-its]").dataset.togglePostIts')) === 'hidden', 'hidden');
    assert.match((await texts(wc, '[data-toggle-post-its]'))[0], /Show stickies/);
    await press(wc, '[data-sidebar-toggle]');
    await until(async () => !(await js(wc, '!!document.querySelector("aside[data-sidebar]").offsetWidth')), 'folded away');
    assert.equal(await js(wc, 'getComputedStyle(document.querySelector("[data-window-controls] [data-settings]")).display'), 'flex', 'the controls\' gear is back');
    await shot(wc, '15-folded');
    await key(wc, '\\', { ch: '\\', modifiers: ['meta'] });
    await until(() => js(wc, '!!document.querySelector("aside[data-sidebar]").offsetWidth'), '⌘\\ brings it back');

    /* ------------------------------------------------ a row's +, a narrow sidebar, a tall window */
    await press(wc, `[data-sb-workspace="${ui}"]`);
    await until(() => js(wc, `document.querySelector('[data-workspace-here]').dataset.workspaceHere === ${JSON.stringify(ui)}`), 'User Interface open');
    await hover(wc, await spot(wc, `[data-sb-workspace="${ui}"]`));
    await shot(wc, '16-row-hover');
    const edge = await spot(wc, '[role="separator"]');
    wc.sendInputEvent({ type: 'mouseMove', x: edge.x, y: 400 });
    wc.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: edge.x, y: 400 });
    for (let x = edge.x; x >= 220; x -= 20) { wc.sendInputEvent({ type: 'mouseMove', x, y: 400, modifiers: ['leftbuttondown'] }); await pause(10); }
    wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: 220, y: 400 });
    await pause(300);
    await shot(wc, '17-narrow');
    win.setSize(1440, 1200);
    await pause(600);
    await shot(wc, '18-tall');
    console.log('sidebar smoke: ok');
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
