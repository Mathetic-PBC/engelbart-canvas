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
const { githubRepo } = require('./sandbox/runs.cjs');

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
function createStore({ homeDir, fixturesDir, inspectPdf: readPdf = null }) {
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

function registerEngelbartIpc({ ipcMain, trustedHandler, store, openExternal, revealItem, confirmReset, writeClipboard, bart, sandbox, readModels, notify, pickPaths = async () => [], beforeContextChange = async () => {}, describe = createDescriber(), identifyRepo = createRepoIdentifier(), listRemoteFiles = createRemoteFileLister() }) {
  const handle = (channel, handler) => ipcMain.handle(`engelbart:${channel}`, trustedHandler(handler));
  const withCtx = (fn) => async (...args) => fn(await store.context(), ...args);
  let changingMode = false;
  let additions = Promise.resolve();

  handle('config', () => store.config());
  handle('set-test-mode', async (value) => {
    if (typeof value !== 'boolean') throw new TypeError('testMode must be a boolean');
    if (changingMode) throw new Error('Data mode is already changing');
    changingMode = true;
    try { await additions.catch(() => {}); await beforeContextChange(); await sandbox?.close(); return await store.setTestMode(value); }
    finally { changingMode = false; }
  });
  handle('reset-test-data', async () => {
    if (!(await confirmReset())) return { reset: false, ...store.config() };
    if (changingMode) throw new Error('Data mode is already changing');
    changingMode = true;
    try {
      await additions.catch(() => {});
      await beforeContextChange();
      await sandbox?.close();
      const config = await store.resetTestData();
      return { reset: true, ...config };
    } finally { changingMode = false; }
  });

  handle('last-open', withCtx((ctx) => projects.readLastOpen(ctx)));
  handle('set-last-open', withCtx((ctx, value) => projects.writeLastOpen(ctx, value)));
  handle('views', withCtx((ctx, projectId) => projects.readViews(ctx, projectId)));
  handle('set-view', withCtx((ctx, projectId, workspaceId, view) => projects.writeView(ctx, projectId, workspaceId, view)));
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
  // All attachment paths share the same handoff: persist context first, then
  // prepare newly linked repositories. Mode changes drain this queue too.
  const changeWorkspaceContext = (pid, wid, change) => {
    if (changingMode) throw new Error('Wait for the data mode change to finish');
    const projectId = str(pid, 'project id', 64), workspaceId = str(wid, 'workspace id', 64);
    const attached = additions.catch(() => {}).then(async () => {
      const ctx = await store.context();
      const held = projects.findWorkspace(ctx, projectId, workspaceId).workspace;
      const previous = new Set(held.context.filter((id) => !held.removed.includes(id)));
      const workspace = await change(ctx, projectId, workspaceId);
      const errors = [];
      if (sandbox) for (const id of workspace.context) {
        if (previous.has(id)) continue;
        const row = await ctx.libraryDb.get(id);
        if (!githubRepo(row?.url)) continue;
        // Attaching a repo is a new request to use it, even if the session's
        // automatic library preparation already failed or was stopped.
        try { await sandbox.start(ctx, id); }
        catch (error) { errors.push(`${row.name}: ${error.message}`); }
      }
      return errors.length ? { ...workspace, sandbox_error: errors.join('\n') } : workspace;
    });
    additions = attached;
    return attached;
  };
  handle('set-workspace-context', (pid, wid, entries) => changeWorkspaceContext(pid, wid, (ctx, projectId, workspaceId) => projects.setWorkspaceContext(ctx, projectId, workspaceId, entries)));
  // The sidebar: search, +, Save and an @mention bring a library item into a workspace; the trash takes it out (and remembers that it did).
  handle('link-to-workspace', (pid, wid, ids) => {
    const entries = (Array.isArray(ids) ? ids : [ids]).slice(0, 200).map((id) => str(id, 'library id', 64));
    return changeWorkspaceContext(pid, wid, (ctx, projectId, workspaceId) => projects.linkToWorkspace(ctx, projectId, workspaceId, entries));
  });
  handle('unlink-from-workspace', (pid, wid, id) => {
    const entry = str(id, 'library id', 64);
    return changeWorkspaceContext(pid, wid, (ctx, projectId, workspaceId) => projects.unlinkFromWorkspace(ctx, projectId, workspaceId, entry));
  });

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
      // `turns`: the earlier turns of the exchange this question continues, read from the document. `choice`: Regenerate's selector.
      const turns = (Array.isArray(value.turns) ? value.turns : []).slice(-40).map((turn) => ({ question: str(turn && turn.question, 'earlier question', 8000), answer: str(turn && turn.answer, 'earlier answer', 40000) }));
      const choice = value.choice && typeof value.choice === 'object' ? { model: str(value.choice.model, 'model', 24), effort: str(value.choice.effort, 'effort', 24) } : null;
      if (choice && !/^[a-z][a-z0-9]*$/.test(choice.model + choice.effort)) throw new TypeError('choice is invalid');
      return await bart.ask(ctx, str(pid, 'project id', 64), { askId, ref: docRef(value.ref), workspaceId: str(value.workspaceId, 'workspace id', 64), text: str(value.text, 'question', 8000), turns, choice }, { onProgress: (progress) => notify('engelbart:bart-progress', { askId, ...progress }) });
    } catch (error) {
      if (error && error.kind === 'stopped') return { stopped: true };
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
  handle('library', withCtx((ctx) => library.listLibrary(ctx)));
  // Both directions of "who holds what", derived from the workspaces on disk (no join table).
  handle('projects-for-library-item', withCtx((ctx, id) => library.projectsForLibraryItem(ctx, str(id, 'library id', 64))));
  handle('library-for-project', withCtx((ctx, pid) => library.libraryForProject(ctx, str(pid, 'project id', 64))));
  // Duplicate adds retain the library's explicit error; existing items enter
  // a workspace via lookup + link. Browser Save may supply a display name.
  handle('add-library-item', (input, options) => {
    if (changingMode) throw new Error('Wait for the data mode change to finish');
    const value = str(input, 'link or path', 4096);
    const name = optStr(options && typeof options === 'object' ? options.name : null, 'name', 200);
    const added = additions.catch(() => {}).then(async () => {
      const ctx = await store.context();
      const row = await library.addItem(ctx, value, { describe, identifyRepo, inspectPdf, name });
      // Adding a local clone or a non-GitHub item does not start remote work.
      if (sandbox && /^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:)/i.test(value.trim())) {
        try { await sandbox.start(ctx, row.id); }
        catch (error) { return { ...row, sandbox_error: error.message }; }
      }
      return row;
    });
    additions = added;
    return added;
  });
  handle('sandbox-runs', withCtx((ctx) => sandbox.list(ctx)));
  handle('sandbox-ensure', () => {
    if (changingMode) throw new Error('Wait for the data mode change to finish');
    const ensured = additions.catch(() => {}).then(async () => {
      const ctx = await store.context();
      const errors = [];
      for (const row of await ctx.libraryDb.list()) {
        if (!row.tags.includes('git')) continue;
        try { await sandbox.start(ctx, row.id, { automatic: true }); }
        catch (error) { errors.push(`${row.name}: ${error.message}`); }
      }
      if (errors.length) throw new Error(errors.join('\n'));
      return sandbox.list(ctx);
    });
    additions = ensured;
    return ensured;
  });
  handle('sandbox-start', withCtx((ctx, id) => {
    if (changingMode) throw new Error('Wait for the data mode change to finish');
    return sandbox.start(ctx, str(id, 'library id', 64));
  }));
  handle('sandbox-stop', withCtx((ctx, id) => sandbox.stop(ctx, str(id, 'run id', 64))));
  handle('sandbox-environment', withCtx((ctx, id) => sandbox.environment(ctx, str(id, 'library id', 64))));
  handle('sandbox-save-environment', withCtx((ctx, id, changes, revision) => {
    if (changingMode) throw new Error('Wait for the data mode change to finish');
    return sandbox.saveEnvironment(ctx, str(id, 'library id', 64), changes, revision);
  }));
  handle('sandbox-restart', withCtx((ctx, id) => {
    if (changingMode) throw new Error('Wait for the data mode change to finish');
    return sandbox.restart(ctx, str(id, 'library id', 64));
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

  handle('shell-history', () => readShellHistory({ homeDir: require('node:os').homedir() }));
  handle('open-external', (url) => openExternal(url));
  handle('reveal', async (target) => {
    const value = path.resolve(str(target, 'path', 4096));
    if (!value.startsWith(store.layout.root + path.sep) && value !== store.layout.root) throw new Error('Only paths inside ~/.engelbart can be revealed');
    return revealItem(value);
  });
}

module.exports = { createStore, registerEngelbartIpc };
