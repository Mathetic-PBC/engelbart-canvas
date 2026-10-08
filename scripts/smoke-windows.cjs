'use strict';

// npm run build && node scripts/smoke-windows.cjs
// Several windows (2026-10-03, src/main/windows.cjs): the real app, hidden, against disposable data, run twice. First:
// File ▸ New Window opens a second window on the same workspace; each keeps its own Stage tab; a document saved in one
// shows in the other, and edits not yet saved there are kept behind a notice; a post-it made in one shows in the other;
// closing one leaves the others working; the windows are written to state.json; then the app quits as it does. Second,
// on the same data: both windows come back, where they were.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PHASE = process.env.ENGELBART_WINDOWS_SMOKE_PHASE;
const root = process.env.ENGELBART_WINDOWS_SMOKE_ROOT;

if (!process.versions.electron) {
  // Under node: the two runs of the app, one after the other, on one disposable folder.
  const electron = require('electron'); // its binary's path
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-windows-smoke-'));
  const runApp = (phase) => new Promise((resolve) => {
    const child = spawn(electron, [__filename], { stdio: 'inherit', env: { ...process.env, ENGELBART_WINDOWS_SMOKE_PHASE: phase, ENGELBART_WINDOWS_SMOKE_ROOT: folder } });
    child.on('exit', (code) => resolve(code == null ? 1 : code));
  });
  (async () => {
    let code = await runApp('run');
    if (code === 0) code = await runApp('restore');
    fs.rmSync(folder, { recursive: true, force: true });
    process.exit(code);
  })();
} else {
  smoke();
}

function smoke() {
  const { app, BrowserWindow, Menu } = require('electron');
  const assert = require('node:assert/strict');
  const http = require('node:http');
  app.setPath('userData', path.join(root, 'electron'));
  Object.assign(process.env, {
    ENGELBART_HOME_DIR: root, ENGELBART_SUMMARIES: 'off', ENGELBART_TOOLS: 'off', ENGELBART_BART_FAKE: '1', ENGELBART_HEADLESS: '1',
    ENGELBART_SANDBOXES: 'off', ENGELBART_WEB_PDFS: 'off', ENGELBART_UPDATES: 'off', ENGELBART_RUN_STEP: 'off',
  });
  require('../src/main/index.cjs');

  const pause = (ms = 50) => new Promise((resolve) => { setTimeout(resolve, ms); });
  async function until(fn, label, tries = 200) {
    for (let i = 0; i < tries; i += 1) { const result = await fn(); if (result) return result; await pause(); }
    throw new Error(`Timed out: ${label}`);
  }
  const js = (wc, expression) => wc.executeJavaScript(expression, true);
  const appWindows = () => BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed() && win.webContents.getURL().startsWith('engelbart://app/index.html'));
  const state = () => JSON.parse(fs.readFileSync(path.join(root, '.engelbart', 'state.json'), 'utf8'));
  const editorText = (win) => js(win.webContents, 'document.querySelector("main [data-editor]")?.innerText || ""').catch(() => '');
  const here = (win) => js(win.webContents, 'document.querySelector("[data-workspace-here]")?.dataset.workspaceHere || null').catch(() => null);
  const cards = (win) => win.contentView.children.filter((view) => view.webContents?.getURL() === 'engelbart://app/post-it.html');
  const key = (wc, keyCode, ch) => { wc.sendInputEvent({ type: 'keyDown', keyCode }); if (ch) wc.sendInputEvent({ type: 'char', keyCode: ch }); wc.sendInputEvent({ type: 'keyUp', keyCode }); };
  const typeKeys = async (wc, text) => { for (const ch of text) { key(wc, ch === ' ' ? 'Space' : ch, ch); await pause(8); } };
  const ready = (win) => until(() => js(win.webContents, '!!window.engelbartAPI && !!document.querySelector("button")').catch(() => false), 'app bootstrap');
  const inWorkspace = (win) => until(() => js(win.webContents, '!!document.querySelector("main [data-editor]")').catch(() => false), 'workspace document');
  const closeTerminals = (win) => js(win.webContents, 'window.terminalAPI.bootstrap().then(s=>Promise.all(s.sessions.map(t=>window.terminalAPI.closeSession(t.id))))');

  async function run() {
    const server = http.createServer((req, res) => res.end(`<!doctype html><title>${req.url}</title><p>${req.url}</p>`));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
      const a = await until(() => appWindows()[0], 'first window');
      a.setFocusable(false);
      await ready(a);
      const created = await js(a.webContents, `window.engelbartAPI.createProjectWithWelcome({name:'Windows smoke', directory:${JSON.stringify(root)}})`);
      const pid = created.project.id, wid = created.workspaceId;
      a.webContents.reload();
      await inWorkspace(a);
      assert.equal(await here(a), wid);

      /* ---------------------------------------------- File ▸ New Window, on the workspace in front */
      const file = Menu.getApplicationMenu().items.find((item) => item.label === 'File');
      file.submenu.items.find((item) => item.label === 'New Window').click();
      const b = await until(() => appWindows().find((win) => win !== a), 'second window');
      b.setFocusable(false);
      await inWorkspace(b);
      assert.equal(await here(b), wid, 'opened from a workspace, the new window shows it');
      assert.notDeepEqual(b.getBounds(), a.getBounds(), 'a step away from the window it came from');
      console.log('PASS File ▸ New Window opens a second window on the same workspace');

      /* ---------------------------------------------- each window its own Stage tab */
      await js(a.webContents, `window.engelbartAPI.browserOpen('smoke-a', ${JSON.stringify(`${url}/a`)})`);
      await js(b.webContents, `window.engelbartAPI.browserOpen('smoke-b', ${JSON.stringify(`${url}/b`)})`);
      const pages = (win) => win.contentView.children.map((view) => view.webContents?.getURL() || '').filter((at) => at.startsWith(url));
      await until(() => pages(a).length && pages(b).length, 'both tabs loaded');
      assert.deepEqual(pages(a), [`${url}/a`]);
      assert.deepEqual(pages(b), [`${url}/b`]);
      console.log('PASS each window keeps its own Stage tab');

      /* ---------------------------------------------- a save in one window shows in the other */
      const ref = JSON.stringify({ kind: 'workspace', workspaceId: wid });
      const saved = await js(a.webContents, `window.engelbartAPI.writeDoc(${JSON.stringify(pid)}, ${ref}, 'Saved in window A\\n')`);
      assert.ok(saved.revision >= 1);
      await until(async () => (await editorText(b)).includes('Saved in window A'), 'the other window shows the saved text');
      console.log('PASS a document saved in one window appears in the other');

      // Words typed in B and not saved yet when A saves: B keeps them and asks; Keep mine saves them.
      await js(b.webContents, 'document.querySelector("main [data-editor]").focus()');
      b.webContents.focus();
      await js(b.webContents, '(()=>{const ed=document.querySelector("main [data-editor]");const r=document.createRange();r.selectNodeContents(ed);r.collapse(false);const s=getSelection();s.removeAllRanges();s.addRange(r);})()');
      await typeKeys(b.webContents, ' typed in B');
      await js(a.webContents, `window.engelbartAPI.writeDoc(${JSON.stringify(pid)}, ${ref}, 'Saved again in window A\\n')`);
      await until(() => js(b.webContents, '!!document.querySelector("[data-doc-conflict]")'), 'the notice in the window with edits');
      assert.ok((await editorText(b)).includes('typed in B'), 'its edits are still on screen');
      await pause(600);
      assert.equal(fs.readFileSync(path.join(created.project.dir, 'Getting started', 'workspace.md'), 'utf8'), 'Saved again in window A\n', 'its save waits for a choice');
      await js(b.webContents, 'document.querySelector("[data-conflict-keep]").click()');
      await until(() => fs.readFileSync(path.join(created.project.dir, 'Getting started', 'workspace.md'), 'utf8').includes('typed in B'), 'Keep mine saved');
      await until(async () => (await editorText(a)).includes('typed in B'), 'and the first window shows it');
      console.log('PASS edits not yet saved are kept behind Keep mine / Take theirs');

      /* ---------------------------------------------- a post-it made in one window shows in the other */
      await js(a.webContents, `window.engelbartAPI.postItsCreate(${JSON.stringify(pid)})`);
      await until(() => cards(a).length === 1 && cards(b).length === 1, 'the card in both windows');
      console.log('PASS a post-it made in one window shows in the other');

      /* ---------------------------------------------- saved windows; closing one leaves the other */
      b.setBounds({ x: 120, y: 90, width: 1000, height: 700 });
      await js(b.webContents, 'document.querySelector("[data-sb-trigger=project]").click()'); // the project's menu → All projects
      await until(() => js(b.webContents, '!!document.querySelector("[data-sb-switch-project]")'), 'the project menu');
      await js(b.webContents, 'document.querySelector("[data-sb-switch-project]").click()');
      await until(() => js(b.webContents, '!!document.querySelector("[data-sb-all-projects]")'), 'its projects');
      await js(b.webContents, 'document.querySelector("[data-sb-all-projects]").click()');
      await until(() => js(b.webContents, '!document.querySelector("main [data-editor]")'), 'second window on the projects screen');
      await until(() => (state().windows || []).length === 2 && state().windows.some((entry) => entry.projectId === null), 'both windows in state.json');
      const kept = state().windows;
      assert.deepEqual(kept.find((entry) => entry.projectId === null).bounds, { x: 120, y: 90, width: 1000, height: 700 });
      assert.deepEqual(kept.find((entry) => entry.projectId === pid).workspaceId, wid);
      console.log('PASS the windows, where each is, are kept in state.json');

      file.submenu.items.find((item) => item.label === 'New Window').click();
      const c = await until(() => appWindows().find((win) => win !== a && win !== b), 'third window');
      c.setFocusable(false);
      await ready(c);
      c.close();
      await until(() => c.isDestroyed(), 'a window that is not the last really closes');
      assert.equal(appWindows().length, 2);
      assert.deepEqual(pages(a), [`${url}/a`], 'the other windows keep their tabs');
      assert.equal(cards(a).length, 1, 'and their post-its');
      await until(() => (state().windows || []).length === 2, 'a closed window leaves state.json');
      console.log('PASS closing one window leaves the others working');

      for (const win of appWindows()) await closeTerminals(win).catch(() => {});
      fs.writeFileSync(path.join(root, 'smoke-expect.json'), JSON.stringify({ pid, wid, kept }));
    } finally {
      server.close();
    }
  }

  async function restore() {
    const expected = JSON.parse(fs.readFileSync(path.join(root, 'smoke-expect.json'), 'utf8'));
    await until(() => appWindows().length === 2, 'both windows back');
    const wins = appWindows();
    for (const win of wins) { win.setFocusable(false); await ready(win); }
    const onWorkspace = await until(async () => { for (const win of wins) if (await here(win) === expected.wid) return win; return null; }, 'the workspace window');
    const onHome = wins.find((win) => win !== onWorkspace);
    await until(() => js(onHome.webContents, '!document.querySelector("main [data-editor]") && !!document.querySelector("button")'), 'the projects-screen window');
    assert.deepEqual(onHome.getBounds(), expected.kept.find((entry) => entry.projectId === null).bounds);
    console.log('PASS after a relaunch every window comes back, where it was');
    for (const win of appWindows()) await closeTerminals(win).catch(() => {});
  }

  app.whenReady().then(async () => {
    try {
      if (PHASE === 'restore') await restore();
      else await run();
    } catch (error) {
      console.error(`FAIL ${error.stack || error.message}`);
      app.exit(1);
      return;
    }
    app.quit(); // as the app quits: state.json written before any window closes
  });
}
