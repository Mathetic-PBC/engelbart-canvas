'use strict';

// engelbart:* IPC. Every handler runs behind the trusted-renderer check and validates
// its arguments before touching the store. The data root follows the test toggle:
// ~/.engelbart (test off) or ~/.engelbart/test (test on), each with its own library
// database; the test root is seeded once and can be reset from the settings gear.

const fs = require('node:fs');
const path = require('node:path');
const home = require('./store/home.cjs');
const db = require('./store/db.cjs');
const projects = require('./store/projects.cjs');
const library = require('./store/library.cjs');
const { expandDoc } = require('./context/expand-mentions.cjs');
const { failureLines } = require('./bart/reply.cjs');
const { readShellHistory } = require('./shell-history.cjs');

const MAX_NAME = 512;

function str(value, what, max = MAX_NAME) {
  if (typeof value !== 'string' || value.length > max) throw new TypeError(`${what} must be a string of at most ${max} characters`);
  return value;
}

function optStr(value, what, max = MAX_NAME) {
  return value == null ? null : str(value, what, max);
}

function docRef(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('doc ref must be an object');
  if (value.kind === 'note') return { kind: 'note', id: str(value.id, 'note id', 64) };
  if (value.kind === 'workspace') return { kind: 'workspace', workspaceId: str(value.workspaceId, 'workspace id', 64) };
  throw new TypeError('Unknown doc kind');
}

function projectInput(value) {
  const input = typeof value === 'string' ? { name: value } : (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
  return { name: str(input.name, 'name'), path: optStr(input.path, 'path', 200), directory: optStr(input.directory, 'directory', 4096) };
}

function createStore({ homeDir, fixturesDir }) {
  const layout = home.ensureHome(homeDir);
  const contexts = new Map();

  function mode() {
    return home.readConfig(layout.root).testMode ? 'test' : 'normal';
  }

  function describe() {
    const current = mode();
    return { ...home.readConfig(layout.root), mode: current, home: layout.root, testRoot: layout.testRoot, dataRoot: current === 'test' ? layout.testRoot : layout.root };
  }

  async function context() {
    const current = mode();
    if (contexts.has(current)) return contexts.get(current);
    const opening = (async () => {
      home.ensureHome(homeDir);
      const dataRoot = current === 'test' ? layout.testRoot : layout.root;
      const libraryDb = await db.openLibraryDb(dataRoot);
      const next = { homeDir, root: layout.root, dataRoot, mode: current, libraryDb };
      if (current === 'test') await library.seedIfEmpty(next, fixturesDir);
      return next;
    })();
    contexts.set(current, opening);
    try {
      return await opening;
    } catch (error) {
      contexts.delete(current);
      throw error;
    }
  }

  async function closeAll() {
    contexts.clear();
    await db.closeAll();
  }

  async function setTestMode(value) {
    if (typeof value !== 'boolean') throw new TypeError('testMode must be a boolean');
    await closeAll();
    home.writeConfig(layout.root, { testMode: value });
    return describe();
  }

  // Wipes ~/.engelbart/test entirely (projects, library, annotations, seeds) and recreates it.
  async function resetTestData() {
    if (mode() !== 'test') throw new Error('Test mode is off');
    await closeAll();
    fs.rmSync(layout.testRoot, { recursive: true, force: true });
    home.ensureHome(homeDir);
    return describe();
  }

  return { layout, context, config: describe, setTestMode, resetTestData, close: closeAll };
}

function registerEngelbartIpc({ ipcMain, trustedHandler, store, openExternal, revealItem, confirmReset, writeClipboard, bart, notify }) {
  const handle = (channel, handler) => ipcMain.handle(`engelbart:${channel}`, trustedHandler(handler));
  const withCtx = (fn) => async (...args) => fn(await store.context(), ...args);

  handle('config', () => store.config());
  handle('set-test-mode', (value) => store.setTestMode(value));
  handle('reset-test-data', async () => {
    if (!(await confirmReset())) return { reset: false, ...store.config() };
    const config = await store.resetTestData();
    return { reset: true, ...config };
  });

  handle('last-open', withCtx((ctx) => projects.readLastOpen(ctx)));
  handle('set-last-open', withCtx((ctx, value) => projects.writeLastOpen(ctx, value)));
  handle('list-projects', withCtx((ctx) => projects.listProjects(ctx)));
  handle('create-project', withCtx((ctx, input) => projects.createProject(ctx, projectInput(input))));
  handle('create-project-with-welcome', withCtx((ctx, input) => projects.createProjectWithWelcome(ctx, projectInput(input))));
  handle('rename-project', withCtx((ctx, id, name) => projects.renameProject(ctx, str(id, 'project id', 64), str(name, 'name'))));
  handle('load-project', withCtx((ctx, id) => projects.loadProject(ctx, str(id, 'project id', 64))));

  handle('set-project-directory', withCtx((ctx, id, directory) => projects.setProjectDirectory(ctx, str(id, 'project id', 64), str(directory, 'directory', 4096))));

  handle('create-workspace', withCtx((ctx, pid, input) => {
    const value = input && typeof input === 'object' ? input : {};
    return projects.createWorkspace(ctx, str(pid, 'project id', 64), { name: optStr(value.name, 'name'), parentId: optStr(value.parentId, 'parent id', 64) });
  }));
  handle('rename-workspace', withCtx((ctx, pid, wid, name) => projects.renameWorkspace(ctx, str(pid, 'project id', 64), str(wid, 'workspace id', 64), str(name, 'name'))));
  handle('set-workspace-status', withCtx((ctx, pid, wid, status) => projects.setWorkspaceStatus(ctx, str(pid, 'project id', 64), str(wid, 'workspace id', 64), str(status, 'status', 32))));
  handle('set-workspace-context', withCtx((ctx, pid, wid, entries) => projects.setWorkspaceContext(ctx, str(pid, 'project id', 64), str(wid, 'workspace id', 64), entries)));

  handle('create-note', withCtx((ctx, pid, input) => {
    const value = input && typeof input === 'object' ? input : {};
    return projects.createNote(ctx, str(pid, 'project id', 64), { name: optStr(value.name, 'name'), workspaceId: optStr(value.workspaceId, 'workspace id', 64) });
  }));
  handle('save-image', withCtx((ctx, pid, input) => {
    const value = input && typeof input === 'object' ? input : {};
    return projects.saveImage(ctx, str(pid, 'project id', 64), { bytes: value.bytes, mime: str(value.mime, 'mime', 64), name: optStr(value.name, 'name') });
  }));
  handle('read-image', withCtx((ctx, id) => projects.readImage(ctx, str(id, 'image id', 64))));
  handle('rename-note', withCtx((ctx, pid, id, name) => projects.renameNote(ctx, str(pid, 'project id', 64), str(id, 'note id', 64), str(name, 'name'))));
  handle('read-doc', withCtx((ctx, pid, ref) => projects.readDoc(ctx, str(pid, 'project id', 64), docRef(ref))));
  handle('write-doc', withCtx((ctx, pid, ref, text) => projects.writeDoc(ctx, str(pid, 'project id', 64), docRef(ref), text)));
  // The sidebar's Copy: the document with every @mentioned file placed where it is mentioned. The
  // clipboard is written here because the renderer is refused every permission, and its own
  // clipboard wants a user gesture that reading the files can outlive.
  handle('copy-doc', withCtx(async (ctx, pid, ref) => {
    const { text, chars, files, missing } = await expandDoc(ctx, str(pid, 'project id', 64), docRef(ref));
    writeClipboard(text);
    return { chars, files, missing };
  }));

  // @bart: the answer comes back as draft lines for the document. A run that fails answers too, so
  // the question line never stays locked behind a pending line; only Stop returns nothing to place.
  handle('ask-bart', withCtx(async (ctx, pid, input) => {
    const value = input && typeof input === 'object' ? input : {};
    const askId = str(value.askId, 'ask id', 64);
    if (!/^[\w-]+$/.test(askId)) throw new TypeError('ask id is invalid');
    try {
      return await bart.ask(ctx, str(pid, 'project id', 64), { askId, ref: docRef(value.ref), workspaceId: str(value.workspaceId, 'workspace id', 64), text: str(value.text, 'question', 8000) }, { onProgress: (progress) => notify('engelbart:bart-progress', { askId, ...progress }) });
    } catch (error) {
      if (error && error.kind === 'stopped') return { stopped: true };
      return { failed: true, lines: failureLines(error && error.message) };
    }
  }));
  handle('stop-bart', (askId) => bart.stop(str(askId, 'ask id', 64)));

  handle('read-text-file', withCtx((ctx, pid, input) => projects.readProjectTextFile(ctx, str(pid, 'project id', 64), str(input, 'path', 4096))));
  handle('library', withCtx((ctx) => library.listLibrary(ctx)));
  handle('rename-library-item', withCtx(async (ctx, id, name) => {
    const row = await ctx.libraryDb.get(str(id, 'library id', 64));
    if (!row) throw new Error('Unknown library item');
    if (row.type === 'note' && row.project_id) {
      const note = await projects.renameNote(ctx, row.project_id, row.id, str(name, 'name'));
      return ctx.libraryDb.get(note.id);
    }
    return ctx.libraryDb.rename(row.id, str(name, 'name'));
  }));
  handle('read-library-file', withCtx((ctx, id) => library.readLibraryFile(ctx, str(id, 'library id', 64))));
  handle('read-annotations', withCtx((ctx, id) => library.readAnnotations(ctx, str(id, 'library id', 64))));
  handle('write-annotations', withCtx((ctx, id, value) => library.writeAnnotations(ctx, str(id, 'library id', 64), value)));

  handle('shell-history', () => readShellHistory({ homeDir: require('node:os').homedir() }));
  handle('open-external', (url) => openExternal(url));
  handle('reveal', async (target) => {
    const value = path.resolve(str(target, 'path', 4096));
    if (!value.startsWith(store.layout.root + path.sep) && value !== store.layout.root) throw new Error('Only paths inside ~/.engelbart can be revealed');
    return revealItem(value);
  });
}

module.exports = { createStore, registerEngelbartIpc };
