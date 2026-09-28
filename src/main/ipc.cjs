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
const interfaceAnnotations = require('./store/interface-annotations.cjs');
const { expandDoc } = require('./context/expand-mentions.cjs');
const { failureLines } = require('./bart/reply.cjs');
const { readShellHistory } = require('./shell-history.cjs');
const { createDescriber, createRepoIdentifier, createRemoteFileLister } = require('./store/page-meta.cjs');
const { createRepoReadmeReader } = require('./store/repo-readme.cjs');
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
// `afterOpen(ctx)` runs each time a library is opened and ready, not awaited: background work that must not hold the
// library back (the app checks for pdfs saved as links: store/web-pdfs.cjs).
function createStore({ homeDir, fixturesDir, inspectPdf: readPdf = null, afterOpen = null }) {
  const layout = home.ensureHome(homeDir);
  // The app starts in normal mode now that the test controls are gone. Keep the old
  // test data intact; scripted tests can still opt in with setTestMode after opening.
  if (home.readConfig(layout.root).testMode) home.writeConfig(layout.root, { testMode: false });
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
      // Restore old captures before the initial library read, including sites
      // that had never been explicitly saved to the library.
      try { await interfaceAnnotations.restore(next); await require('./store/recordings.cjs').restore(next); }
      catch (error) { console.warn('Could not restore capture sources:', error.message); }
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

function registerEngelbartIpc({ ipcMain, trustedHandler, store, openExternal, revealItem, confirmReset, writeClipboard, bart, localPreviews = null, sandbox, readModels, notify, pickPaths = async () => [], beforeContextChange = async () => {}, describe = createDescriber(), identifyRepo = createRepoIdentifier(), listRemoteFiles = createRemoteFileLister(), readRepoReadme = createRepoReadmeReader(), github = null, google = null, zotero = null, overleaf = null, openGithubPage = () => {} }) {
  const handle = (channel, handler) => ipcMain.handle(`engelbart:${channel}`, trustedHandler(handler));
  const withCtx = (fn) => async (...args) => fn(await store.context(), ...args);
  let changingMode = false;
  let additions = Promise.resolve();

  handle('config', () => store.config());
  handle('set-test-mode', async (value) => {
    if (typeof value !== 'boolean') throw new TypeError('testMode must be a boolean');
    if (changingMode) throw new Error('Data mode is already changing');
    changingMode = true;
    try { await additions.catch(() => {}); await beforeContextChange(); await localPreviews?.close(); await sandbox?.close(); return await store.setTestMode(value); }
    finally { changingMode = false; }
  });
  handle('reset-test-data', async () => {
    if (!(await confirmReset())) return { reset: false, ...store.config() };
    if (changingMode) throw new Error('Data mode is already changing');
    changingMode = true;
    try {
      await additions.catch(() => {});
      await beforeContextChange();
      await localPreviews?.close();
      await sandbox?.close();
      const config = await store.resetTestData();
      return { reset: true, ...config };
    } finally { changingMode = false; }
  });

  handle('last-open', withCtx((ctx) => projects.readLastOpen(ctx)));
  handle('set-last-open', withCtx((ctx, value) => projects.writeLastOpen(ctx, value)));
  handle('views', withCtx((ctx, projectId) => projects.readViews(ctx, projectId)));
  handle('set-view', withCtx((ctx, projectId, workspaceId, view) => projects.writeView(ctx, projectId, workspaceId, view)));
  // Where to go next (the sidebar's next row, ⌘J): the workspaces written in last and the agents running or waiting.
  // Every change is announced on `engelbart:nav`; the renderer reads `nav` again.
  const navChanged = () => notify('engelbart:nav', {});
  handle('nav', withCtx((ctx) => projects.readNav(ctx)));

  // GitHub (src/main/github/connection.cjs): signing in through Stage, and the repositories the App can read.
  // Every change of the sign-in is announced on `engelbart:github` with the status. `github-open` shows GitHub's device
  // authorization page again, or the App's install page, in Stage.
  const gh = () => { if (!github) throw new Error('GitHub is not available'); return github; };
  handle('github-status', () => (github ? github.status() : { configured: false, connected: false, pending: null, error: '', installUrl: '' }));
  handle('github-connect', () => gh().connect());
  handle('github-cancel', () => gh().cancel());
  handle('github-disconnect', () => gh().disconnect());
  handle('github-repos', () => gh().repos());
  handle('github-open', async (which) => {
    const status = gh().status();
    const url = which === 'install' ? status.installUrl : status.pending && status.pending.verificationUri;
    if (!url) throw new Error(which === 'install' ? 'The GitHub App has no slug in ~/.engelbart/config.json (github.appSlug).' : 'No sign-in is waiting');
    await openGithubPage(url);
    return true;
  });
  // Google Docs exposes only account status, explicit auth actions and recent
  // document metadata. Authentication stays in Stage's browser session.
  const docs = () => { if (!google) throw new Error('Google Docs is not available'); return google; };
  handle('google-status', () => google ? google.status() : { configured: false, connected: false, pending: null, account: null, error: '' });
  handle('google-connect', () => docs().connect());
  handle('google-cancel', () => docs().cancel());
  handle('google-disconnect', () => docs().disconnect());
  handle('google-reopen', () => docs().reopen());
  handle('google-documents', (refresh = false) => {
    if (typeof refresh !== 'boolean') throw new TypeError('Refresh must be a boolean');
    return docs().documents(refresh);
  });
  handle('google-open-document', id => docs().openDocument(str(id, 'Google document id', 200)));
  const papers = () => { if (!zotero) throw new Error('Zotero is not available'); return zotero; };
  handle('zotero-status', () => zotero ? zotero.status() : { configured: false, connected: false, pending: null, account: null, error: '' });
  handle('zotero-connect', () => papers().connect());
  handle('zotero-cancel', () => papers().cancel());
  handle('zotero-disconnect', () => papers().disconnect());
  handle('zotero-reopen', () => papers().reopen());
  handle('zotero-papers', (refresh = false) => {
    if (typeof refresh !== 'boolean') throw new TypeError('Refresh must be a boolean');
    return papers().papers(refresh);
  });
  handle('zotero-open-paper', id => papers().openPaper(str(id, 'Zotero item key', 8)));

  const leaf = () => { if (!overleaf) throw new Error('Overleaf is not available'); return overleaf; };
  handle('overleaf-status', () => overleaf ? overleaf.status() : { configured: false, connected: false, pending: null, account: null, error: '' });
  handle('overleaf-connect', () => leaf().connect());
  handle('overleaf-cancel', () => leaf().cancel());
  handle('overleaf-disconnect', () => leaf().disconnect());
  handle('overleaf-reopen', () => leaf().reopen());
  handle('overleaf-projects', (refresh = false) => {
    if (typeof refresh !== 'boolean') throw new TypeError('Refresh must be a boolean');
    return leaf().projects(refresh);
  });
  handle('overleaf-open-project', id => leaf().openProject(str(id, 'Overleaf project id', 24)));
  handle('record-edit', withCtx((ctx, pid, wid) => { projects.recordEdit(ctx, str(pid, 'project id', 64), str(wid, 'workspace id', 64)); navChanged(); return true; }));
  handle('seen-agents', withCtx((ctx, pid, wid) => { const seen = projects.seenAgents(ctx, str(pid, 'project id', 64), str(wid, 'workspace id', 64)); if (seen) navChanged(); return seen; }));
  handle('list-projects', withCtx((ctx) => projects.listProjects(ctx)));
  handle('create-project', withCtx((ctx, input) => projects.createProject(ctx, projectInput(input))));
  handle('create-project-with-welcome', withCtx((ctx, input) => projects.createProjectWithWelcome(ctx, projectInput(input))));
  handle('rename-project', withCtx((ctx, id, name) => projects.renameProject(ctx, str(id, 'project id', 64), str(name, 'name'))));
  handle('load-project', withCtx((ctx, id) => projects.loadProject(ctx, str(id, 'project id', 64))));

  handle('set-project-directory', withCtx((ctx, id, directory) => projects.setProjectDirectory(ctx, str(id, 'project id', 64), str(directory, 'directory', 4096))));

  // Making a workspace counts as writing in it (⌘J's recent ones), typed in or not (2026-09-23).
  handle('create-workspace', withCtx(async (ctx, pid, input) => {
    const value = input && typeof input === 'object' ? input : {};
    const projectId = str(pid, 'project id', 64);
    const created = await projects.createWorkspace(ctx, projectId, { name: optStr(value.name, 'name'), parentId: optStr(value.parentId, 'parent id', 64) });
    projects.recordEdit(ctx, projectId, created.id);
    navChanged();
    return created;
  }));
  handle('rename-workspace', withCtx((ctx, pid, wid, name) => projects.renameWorkspace(ctx, str(pid, 'project id', 64), str(wid, 'workspace id', 64), str(name, 'name'))));
  handle('delete-workspace', withCtx(async (ctx, pid, wid) => {
    if (localPreviews) {
      const { workspace } = projects.findWorkspace(ctx, pid, wid);
      for (const id of [workspace.id, ...projects.flattenWorkspaces(workspace.dir).map(child => child.id)]) await localPreviews.stop(ctx, pid, id);
    }
    const result = await projects.deleteWorkspace(ctx, str(pid, 'project id', 64), str(wid, 'workspace id', 64));
    navChanged();
    return result;
  }));
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
    // Keeping the agent's row is bookkeeping: it never stands between a question and its answer.
    const track = (change) => { try { change(); navChanged(); return true; } catch { return false; } };
    let started = false;
    try {
      // `turns`: the earlier turns of the exchange this question continues, read from the document. `choice`: Regenerate's selector.
      const turns = (Array.isArray(value.turns) ? value.turns : []).slice(-40).map((turn) => ({ question: str(turn && turn.question, 'earlier question', 8000), answer: str(turn && turn.answer, 'earlier answer', 40000) }));
      const choice = value.choice && typeof value.choice === 'object' ? { model: str(value.choice.model, 'model', 24), effort: str(value.choice.effort, 'effort', 24) } : null;
      if (choice && !/^[a-z][a-z0-9]*$/.test(choice.model + choice.effort)) throw new TypeError('choice is invalid');
      const question = { askId, ref: docRef(value.ref), workspaceId: str(value.workspaceId, 'workspace id', 64), text: str(value.text, 'question', 8000), turns, choice };
      if (changingMode) throw new Error('Data mode is changing. Try again when it finishes.');
      const building = require('./bart/question.cjs').readFlags(question.text, readModels()).build;
      if (building && !localPreviews) throw new Error('Local interface builds are not available.');
      // The ask is an agent of its workspace: running now, waiting for you once its answer (or failure) has landed.
      started = track(() => projects.agentStarted(ctx, { id: askId, kind: 'bart', projectId: pid, workspaceId: question.workspaceId, doc: question.ref }));
      const options = { onProgress: progress => notify('engelbart:bart-progress', { askId, ...progress }) };
      const projectId = str(pid, 'project id', 64);
      let out = await (building ? localPreviews.build : bart.ask)(ctx, projectId, question, options);
      if (!building && out.buildProposal) {
        if (changingMode) throw new Error('Data mode is changing. Try again when it finishes.');
        if (!localPreviews) throw new Error('Local interface builds are not available.');
        out = await localPreviews.build(ctx, projectId, { ...question, buildRequest: out.buildProposal.request }, options);
      }
      if (started) track(() => projects.agentFinished(ctx, askId));
      return out;
    } catch (error) {
      const stopped = !!(error && error.kind === 'stopped');
      if (started) track(() => (stopped ? projects.agentStopped(ctx, askId) : projects.agentFinished(ctx, askId)));
      if (stopped) return { stopped: true };
      return { failed: true, lines: failureLines(error && error.message) };
    }
  }));
  handle('stop-bart', (askId) => {
    const id = str(askId, 'ask id', 64);
    return localPreviews?.stopAsk(id) || bart.stop(id);
  });
  const local = () => { if (!localPreviews) throw new Error('Local previews are not available.'); return localPreviews; };
  handle('local-preview-list', withCtx(ctx => local().list(ctx)));
  handle('local-preview', withCtx((ctx, pid, wid) => local().get(ctx, str(pid, 'project id', 64), str(wid, 'workspace id', 64))));
  handle('local-preview-stop', withCtx((ctx, pid, wid) => local().stop(ctx, str(pid, 'project id', 64), str(wid, 'workspace id', 64))));
  handle('local-preview-approve', withCtx((ctx, pid, wid, approvalId, approved) => {
    if (changingMode) throw new Error('Data mode is changing.');
    if (typeof approved !== 'boolean') throw new TypeError('Approval must be true or false.');
    return local().approve(ctx, str(pid, 'project id', 64), str(wid, 'workspace id', 64), str(approvalId, 'approval id', 64), approved);
  }));
  handle('local-preview-reveal', withCtx((ctx, pid, wid) => {
    const preview = local().get(ctx, str(pid, 'project id', 64), str(wid, 'workspace id', 64));
    if (!preview) throw new Error('No local interface has been built in this workspace.');
    return revealItem(preview.directory);
  }));
  handle('local-preview-restart', withCtx(async (ctx, pid, wid) => {
    if (changingMode) throw new Error('Data mode is changing.');
    const projectId = str(pid, 'project id', 64), workspaceId = str(wid, 'workspace id', 64);
    try { return await local().restart(ctx, projectId, workspaceId); }
    catch (error) { if (error.kind === 'stopped') return local().get(ctx, projectId, workspaceId); throw error; }
  }));
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
  // A pdf read from the web, saved as a copy with its address (library.addPdfCopy; the Stage's Save sends its bytes).
  handle('add-library-pdf', withCtx((ctx, input, bytes, options) => {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('pdf bytes are missing');
    return library.addPdfCopy(ctx, str(input, 'address', 8192), bytes, { inspectPdf, name: optStr(options && typeof options === 'object' ? options.name : null, 'name', 200) });
  }));
  handle('lookup-library-item', withCtx((ctx, input) => library.lookupItem(ctx, str(input, 'link or path', 4096))));
  // "Choose from disk…": the native picker, files and folders, several at once.
  handle('pick-library-paths', () => pickPaths());
  handle('preview-library-item', withCtx((ctx, id) => library.previewItem(ctx, str(id, 'library id', 64), { listRemoteFiles })));
  handle('repository-readme', withCtx(async (ctx, id, options = {}) => {
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some((key) => key !== 'refresh')
        || (options.refresh !== undefined && typeof options.refresh !== 'boolean')) throw new TypeError('Invalid README options');
    const row = await ctx.libraryDb.get(str(id, 'library id', 64));
    if (!row || !githubRepo(row.url)) throw new Error('Choose a saved GitHub repository.');
    return readRepoReadme(row.url, { refresh: options.refresh === true });
  }));
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
  handle('interface-annotations', withCtx((ctx, scope) => interfaceAnnotations.list(ctx, scope)));
  const annotationChange = fn => withCtx(async (...args) => {
    const result = await fn(...args);
    notify('engelbart:library-changed', {});
    return result;
  });
  handle('create-interface-annotation', annotationChange((ctx, scope, note) => interfaceAnnotations.create(ctx, scope, note)));
  handle('edit-interface-annotation', annotationChange((ctx, scope, id, body) => interfaceAnnotations.edit(ctx, scope, str(id, 'annotation id', 64), body)));
  handle('delete-interface-annotation', annotationChange((ctx, scope, id) => interfaceAnnotations.remove(ctx, scope, str(id, 'annotation id', 64))));
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
