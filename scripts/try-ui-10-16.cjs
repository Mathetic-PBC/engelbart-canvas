'use strict';

// npm run build && npx electron scripts/try-ui-10-16.cjs [--fresh]
// A window of this checkout for Hudson to try the 2026-10-16 "User Interface" round by hand: test mode on, its own data
// root (~/.engelbart/test/ui-10-16/root, so test data lives in …/root/test) and its own Electron profile, so the
// Engelbart in /Applications, its ~/.engelbart and its config.json are never read or written. Real Claude Code and Codex.
// The first run seeds two projects (onboarding is skipped: it only shows with none) and a few agent rows; later runs
// open what is there. --fresh deletes ~/.engelbart/test/ui-10-16 first. Checklist: docs/try-ui-10-16.html.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const base = path.join(os.homedir(), '.engelbart', 'test', 'ui-10-16');
if (process.argv.includes('--fresh')) fs.rmSync(base, { recursive: true, force: true });
const root = path.join(base, 'root');
const dataRoot = path.join(root, 'test');
const code = path.join(base, 'code');
const seeded = path.join(base, '.seeded');
fs.mkdirSync(root, { recursive: true });
fs.mkdirSync(code, { recursive: true });
app.setPath('userData', path.join(base, 'electron'));
process.env.ENGELBART_ROOT_DIR = root;
process.env.ENGELBART_CONNECT_OFFER = 'off';
delete process.env.ENGELBART_HOME_DIR;

// Providers and the tools check copied from the real config.json (read only) so no setup dialog shows. Test mode is
// switched on through the app once it is up: written here, the carried-defaults merge (store/defaults.cjs) takes it
// for an old default and turns it off.
const configFile = path.join(root, 'config.json');
if (!fs.existsSync(configFile)) {
  let real = {};
  try { real = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.engelbart', 'config.json'), 'utf8')); } catch { /* none */ }
  const { providers, summarizer, github, tools } = real;
  fs.writeFileSync(configFile, JSON.stringify({ testMode: false, providers, summarizer, github, tools }, null, 2), { mode: 0o600 });
}
require('../src/main/index.cjs');

const pause = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, tries = 600) {
  for (let i = 0; i < tries; i++) { const result = await fn(); if (result) return result; await pause(); }
  throw new Error(`Timed out: ${label}`);
}
const js = (wc, expression) => wc.executeJavaScript(expression, true);
const api = (wc, call) => js(wc, `window.engelbartAPI.${call}`);
const J = JSON.stringify;

async function seed(wc) {
  const made = await api(wc, `createProjectWithWelcome({name:'Engelbart', directory:${J(code)}})`);
  const pid = made.project.id;
  const ws = async (projectId, name, parentId = null) => (await api(wc, `createWorkspace(${J(projectId)}, ${J({ name, parentId })})`)).id;
  const ui = await ws(pid, 'User Interface');
  const sidebar = await ws(pid, 'Sidebar', ui);
  const middle = await ws(pid, 'Middle Canvas', ui);
  const onboarding = await ws(pid, 'Onboarding');
  await ws(pid, 'Agents');
  await ws(pid, 'Release');
  // Two archived versions of Onboarding: written in, then cleared, twice.
  for (const text of ['The first onboarding plan', 'The second onboarding plan']) {
    await api(wc, `writeDoc(${J(pid)}, ${J({ kind: 'workspace', workspaceId: onboarding })}, ${J(`${text}\n`)})`);
    await api(wc, `clearWorkspace(${J(pid)}, ${J(onboarding)})`);
  }
  const notes = [];
  for (const name of ['Old requirements', 'Sidebar brainstorming', 'Iconography']) {
    notes.push(await api(wc, `createNote(${J(pid)}, ${J({ name, workspaceId: sidebar })})`));
    await pause(30);
  }
  await api(wc, `linkToWorkspace(${J(pid)}, ${J(sidebar)}, ${J(notes.map((note) => note.id))})`);
  await api(wc, `writeDoc(${J(pid)}, ${J({ kind: 'workspace', workspaceId: middle })}, ${J('Middle canvas\n\nSearch this page for the word canvas with ⌘F. The canvas is the middle pane.\n\n> A quote you should be able to edit after it became one.\n\nType @ below to mention a note from the Research project.\n\n')})`);

  // A second project, so @ can reach notes outside this one.
  const other = await api(wc, `createProjectWithWelcome({name:'Research', directory:${J(code)}})`);
  const rid = other.project.id;
  const reading = await ws(rid, 'Reading');
  for (const name of ['Context engineering notes', 'Requirement engineering pedagogy']) {
    const note = await api(wc, `createNote(${J(rid)}, ${J({ name, workspaceId: reading })})`);
    await api(wc, `linkToWorkspace(${J(rid)}, ${J(reading)}, ${J([note.id])})`);
  }

  const stateFile = path.join(dataRoot, 'state.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const now = Date.now(), iso = (ms) => new Date(ms).toISOString();
  state.agents = [{ id: 'ask-1', kind: 'bart', projectId: pid, workspaceId: sidebar, doc: { kind: 'note', id: notes[0].id }, status: 'waiting', started: iso(now - 9 * 60000), finished: iso(now - 4 * 60000) }];
  state.projectId = pid;
  state.workspaceId = middle;
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  const projectDir = path.join(dataRoot, made.project.slug || 'engelbart');
  const task = (id, status, title, workspaceId, ago, more = {}) => {
    const dir = path.join(projectDir, 'builds', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify({ id, kind: 'build', projectId: pid, workspaceId, title, provider: 'claude', model: 'opus', status, messages: [], created: iso(now - ago), updated: iso(now - ago), ...more }));
  };
  task('a1b2c3d4e5', 'needs-you', 'New sidebar', sidebar, 30 * 60000);
  task('b1b2c3d4e5', 'accepted', 'Copy button in the lower left', ui, 26 * 3600000);
  task('c1b2c3d4e5', 'accepted', 'Four days old (should not show)', ui, 4 * 24 * 3600000);
  task('d1b2c3d4e5', 'failed', 'The archived workspace should open', null, 2 * 3600000, { kind: 'quick', postItId: 'p-1', postIt: 'The archived workspace should open' });
  fs.writeFileSync(seeded, new Date().toISOString());
  wc.reload();
}

app.whenReady().then(async () => {
  try {
    const win = await until(() => BrowserWindow.getAllWindows()[0], 'app window');
    const wc = win.webContents;
    await until(() => js(wc, '!!window.engelbartAPI && !!document.querySelector("button")').catch(() => false), 'app bootstrap');
    if (!(await api(wc, 'config()')).testMode) {
      await api(wc, 'setTestMode(true)');
      wc.reload();
      await pause(500);
      await until(() => js(wc, '!!window.engelbartAPI && !!document.querySelector("button")').catch(() => false), 'test mode on');
    }
    if (!fs.existsSync(seeded)) await seed(wc);
    console.log(`try-ui-10-16: open, data in ${dataRoot}`);
  } catch (error) {
    console.error('try-ui-10-16:', error);
  }
});
