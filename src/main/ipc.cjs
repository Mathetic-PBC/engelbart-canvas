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
const { createDescriber, createRepoIdentifier, createRemoteFileLister } = require('./store/page-meta.cjs');
const { inspectPdf } = require('./context/pdf-kind.cjs');

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

// `inspectPdf` (the app passes pdf-kind's) is how a pdf is read for whether it is a paper when a library is re-categorized.
// `afterOpen(ctx)` runs each time a library is opened and ready, not awaited: background work that must not hold the
// library back (the app checks for pdfs saved as links: store/web-pdfs.cjs).
function createStore({ homeDir, fixturesDir, inspectPdf: readPdf = null, afterOpen = null }) {
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
      // A library behind the category rules (converted from the old types, or from before a change of
      // rules) is brought up to them before anyone reads it: about 30 ms a pdf, once. Summaries are
      // not touched. A failure leaves the rows due for the next launch; the library still opens.
      try { await library.recategorize(next, { inspectPdf: readPdf }); } catch { /* still due */ }
      if (afterOpen) setTimeout(() => { Promise.resolve().then(() => afterOpen(next)).catch(() => {}); }, 0);
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

function registerEngelbartIpc({ ipcMain, trustedHandler, store, openExternal, revealItem, confirmReset, writeClipboard, bart, readModels, notify, pickPaths = async () => [], beforeContextChange = async () => {}, describe = createDescriber(), identifyRepo = createRepoIdentifier(), listRemoteFiles = createRemoteFileLister(), github = null, openGithubPage = () => {}, pasteGithubCode = async () => false }) {
  const handle = (channel, handler) => ipcMain.handle(`engelbart:${channel}`, trustedHandler(handler));
  const withCtx = (fn) => async (...args) => fn(await store.context(), ...args);

  handle('config', () => store.config());
  handle('set-test-mode', async (value) => { await beforeContextChange(); return store.setTestMode(value); });
  handle('reset-test-data', async () => {
    if (!(await confirmReset())) return { reset: false, ...store.config() };
    await beforeContextChange();
    const config = await store.resetTestData();
    return { reset: true, ...config };
  });

  handle('last-open', withCtx((ctx) => projects.readLastOpen(ctx)));
  handle('set-last-open', withCtx((ctx, value) => projects.writeLastOpen(ctx, value)));
  handle('views', withCtx((ctx, projectId) => projects.readViews(ctx, projectId)));
  handle('set-view', withCtx((ctx, projectId, workspaceId, view) => projects.writeView(ctx, projectId, workspaceId, view)));
  // Where to go next (the sidebar's next row, ⌘J): the workspaces written in last and the agents running or waiting.
  // Every change is announced on `engelbart:nav`; the renderer reads `nav` again.
  const navChanged = () => notify('engelbart:nav', {});
  handle('nav', withCtx((ctx) => projects.readNav(ctx)));

  // GitHub (src/main/github/connection.cjs): signing in through the device flow, and the repositories the App can read.
  // Every change of the sign-in is announced on `engelbart:github` with the status. `github-open` shows GitHub's device
  // page again, or the App's install page, on Stage. The paste action uses the current code in main.
  const gh = () => { if (!github) throw new Error('GitHub is not available'); return github; };
  handle('github-status', () => (github ? github.status() : { configured: false, connected: false, pending: null, error: '', installUrl: '' }));
  handle('github-connect', () => gh().connect());
  handle('github-cancel', () => gh().cancel());
  handle('github-disconnect', () => gh().disconnect());
  handle('github-repos', () => gh().repos());
  handle('github-paste', (id) => pasteGithubCode(str(id, 'browser tab id', 128)));
  handle('github-open', (which) => {
    const status = gh().status();
    const url = which === 'install' ? status.installUrl : status.pending && status.pending.verificationUri;
    if (!url) throw new Error(which === 'install' ? 'The GitHub App has no slug in ~/.engelbart/config.json (github.appSlug).' : 'No sign-in is waiting');
    openGithubPage(url);
    return true;
  });
  handle('record-edit', withCtx((ctx, pid, wid) => { projects.recordEdit(ctx, str(pid, 'project id', 64), str(wid, 'workspace id', 64)); navChanged(); return true; }));
  handle('seen-agents', withCtx((ctx, pid, wid) => { const seen = projects.seenAgents(ctx, str(pid, 'project id', 64), str(wid, 'workspace id', 64)); if (seen) navChanged(); return seen; }));
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
  // The sidebar: search, +, Save and an @mention bring a library item into a workspace; the trash takes it out (and remembers that it did).
  handle('link-to-workspace', withCtx((ctx, pid, wid, ids) => projects.linkToWorkspace(ctx, str(pid, 'project id', 64), str(wid, 'workspace id', 64), (Array.isArray(ids) ? ids : [ids]).slice(0, 200).map((id) => str(id, 'library id', 64)))));
  handle('unlink-from-workspace', withCtx((ctx, pid, wid, id) => projects.unlinkFromWorkspace(ctx, str(pid, 'project id', 64), str(wid, 'workspace id', 64), str(id, 'library id', 64))));

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
    // Keeping the agent's row is bookkeeping: it never stands between a question and its answer.
    const track = (change) => { try { change(); navChanged(); return true; } catch { return false; } };
    let started = false;
    try {
      // `turns`: the earlier turns of the exchange this question continues, read from the document. `choice`: Regenerate's selector.
      const turns = (Array.isArray(value.turns) ? value.turns : []).slice(-40).map((turn) => ({ question: str(turn && turn.question, 'earlier question', 8000), answer: str(turn && turn.answer, 'earlier answer', 40000) }));
      const choice = value.choice && typeof value.choice === 'object' ? { model: str(value.choice.model, 'model', 24), effort: str(value.choice.effort, 'effort', 24) } : null;
      if (choice && !/^[a-z][a-z0-9]*$/.test(choice.model + choice.effort)) throw new TypeError('choice is invalid');
      const question = { askId, ref: docRef(value.ref), workspaceId: str(value.workspaceId, 'workspace id', 64), text: str(value.text, 'question', 8000), turns, choice };
      // The ask is an agent of its workspace: running now, waiting for you once its answer (or failure) has landed.
      started = track(() => projects.agentStarted(ctx, { id: askId, kind: 'bart', projectId: pid, workspaceId: question.workspaceId, doc: question.ref }));
      const out = await bart.ask(ctx, str(pid, 'project id', 64), question, { onProgress: (progress) => notify('engelbart:bart-progress', { askId, ...progress }) });
      if (started) track(() => projects.agentFinished(ctx, askId));
      return out;
    } catch (error) {
      const stopped = !!(error && error.kind === 'stopped');
      if (started) track(() => (stopped ? projects.agentStopped(ctx, askId) : projects.agentFinished(ctx, askId)));
      if (stopped) return { stopped: true };
      return { failed: true, lines: failureLines(error && error.message) };
    }
  }));
  handle('stop-bart', (askId) => bart.stop(str(askId, 'ask id', 64)));
  // What the @bart line's selector offers and what its flags are checked against: the models file,
  // cut down to the providers config.json lists. Names and keys only; the file's prose stays here.
  handle('bart-models', () => { const { provider, providers } = readModels(); return { provider, providers }; });
  // Copy all under an answer: a question and its answer, as they read in the document.
  handle('copy-text', (text) => { writeClipboard(str(text, 'text', 400000)); return true; });

  handle('resolve-page-file', withCtx((ctx, pid, input) => projects.resolvePageFile(ctx, str(pid, 'project id', 64), str(input, 'path', 4096))));
  handle('read-text-file', withCtx((ctx, pid, input) => projects.readProjectTextFile(ctx, str(pid, 'project id', 64), str(input, 'path', 4096))));
  // The Stage: what is at a path, and what drawing it needs (a pdf's bytes, a picture's, text, a page's address).
  handle('stage-file', withCtx((ctx, pid, input) => projects.readStageFile(ctx, str(pid, 'project id', 64), str(input, 'path', 4096))));
  handle('library', withCtx((ctx) => library.listLibrary(ctx)));
  // Both directions of "who holds what", derived from the workspaces on disk (no join table).
  handle('projects-for-library-item', withCtx((ctx, id) => library.projectsForLibraryItem(ctx, str(id, 'library id', 64))));
  handle('library-for-project', withCtx((ctx, pid) => library.libraryForProject(ctx, str(pid, 'project id', 64))));
  // Adding makes a new row or throws "Already in the library as …" (library.addItem). `options.name` names it (the Browser's Save card).
  handle('add-library-item', withCtx((ctx, input, options) => library.addItem(ctx, str(input, 'link or path', 4096), { describe, identifyRepo, inspectPdf, name: optStr(options && typeof options === 'object' ? options.name : null, 'name', 200) })));
  // A pdf read from the web, saved as a copy with its address (library.addPdfCopy; the Stage's Save sends its bytes).
  handle('add-library-pdf', withCtx((ctx, input, bytes, options) => {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('pdf bytes are missing');
    return library.addPdfCopy(ctx, str(input, 'address', 8192), bytes, { inspectPdf, name: optStr(options && typeof options === 'object' ? options.name : null, 'name', 200) });
  }));
  handle('lookup-library-item', withCtx((ctx, input) => library.lookupItem(ctx, str(input, 'link or path', 4096))));
  // "Choose from disk…": the native picker, files and folders, several at once.
  handle('pick-library-paths', () => pickPaths());
  handle('preview-library-item', withCtx((ctx, id) => library.previewItem(ctx, str(id, 'library id', 64), { listRemoteFiles })));
  handle('rename-library-item', withCtx(async (ctx, id, name) => {
    const row = await ctx.libraryDb.get(str(id, 'library id', 64));
    if (!row) throw new Error('Unknown library item');
    if (row.tags.includes('note') && row.project_id) {
      const note = await projects.renameNote(ctx, row.project_id, row.id, str(name, 'name'));
      return ctx.libraryDb.get(note.id);
    }
    return ctx.libraryDb.rename(row.id, str(name, 'name'));
  }));
  handle('read-library-file', withCtx((ctx, id) => library.readLibraryFile(ctx, str(id, 'library id', 64))));
  handle('read-annotations', withCtx((ctx, id) => library.readAnnotations(ctx, str(id, 'library id', 64))));
  handle('write-annotations', withCtx((ctx, id, value) => library.writeAnnotations(ctx, str(id, 'library id', 64), value)));
  // Ink on a pdf in the Browser pane, by its address (a link, or a file: address inside the home directory).
  handle('read-page-annotations', withCtx((ctx, input) => library.readPageAnnotations(ctx, str(input, 'address', 8192))));
  handle('write-page-annotations', withCtx((ctx, input, value) => library.writePageAnnotations(ctx, str(input, 'address', 8192), value)));

  handle('shell-history', () => readShellHistory({ homeDir: require('node:os').homedir() }));
  handle('open-external', (url) => openExternal(url));
  handle('reveal', async (target) => {
    const value = path.resolve(str(target, 'path', 4096));
    if (!value.startsWith(store.layout.root + path.sep) && value !== store.layout.root) throw new Error('Only paths inside ~/.engelbart can be revealed');
    return revealItem(value);
  });
}

module.exports = { createStore, registerEngelbartIpc };
