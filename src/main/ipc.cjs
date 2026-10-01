'use strict';

// engelbart:* IPC. Every handler runs behind the trusted-renderer check and validates
// its arguments before touching the store. The data root follows the test toggle:
// ~/.engelbart (test off) or ~/.engelbart/test (test on), each with its own library
// database; the test root is seeded once and can be reset from the settings gear.
// Only a developer's copy has the toggle (./developer.cjs); any other is always on ~/.engelbart.

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
const { TOOL_NAMES } = require('./tools/requirements.cjs');
const archive = require('./store/archive.cjs');
const onboarding = require('./store/onboarding.cjs');
const { buildChoices } = require('./bart/models.cjs');
const { githubRepo } = require('./sandbox/runs.cjs');

const BUILD_LINE_RE = /^build> ([a-z0-9]{6,32})$/;
const buildId = (value) => { if (typeof value !== 'string' || !/^[0-9a-f]{10}$/.test(value)) throw new TypeError('build id is invalid'); return value; };

const MAX_NAME = 512;
// In ~/.engelbart/test after "Start as a new user": the sample library is not seeded.
const FRESH_MARK = '.fresh';

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
// `testMode`: whether this copy has test mode at all (./developer.cjs). Without it config.json's `testMode` is read as
// off but never rewritten, so a developer's copy sharing the file keeps its setting.
function createStore({ homeDir, rootDir = null, fixturesDir, inspectPdf: readPdf = null, afterOpen = null, testMode: available = false }) {
  const layout = home.ensureHome(homeDir, rootDir, { test: available });
  const contexts = new Map();

  function mode() {
    return available && home.readConfig(layout.root).testMode ? 'test' : 'normal';
  }

  function describe() {
    const current = mode();
    return { ...home.readConfig(layout.root), testMode: current === 'test', testModeAvailable: available, mode: current, home: layout.root, testRoot: layout.testRoot, dataRoot: current === 'test' ? layout.testRoot : layout.root };
  }

  function requireTestMode() {
    if (!available) throw new Error('Test mode is only in developer builds of Engelbart');
  }

  async function context() {
    const current = mode();
    if (contexts.has(current)) return contexts.get(current);
    const opening = (async () => {
      home.ensureHome(homeDir, rootDir, { test: available });
      const dataRoot = current === 'test' ? layout.testRoot : layout.root;
      const libraryDb = await db.openLibraryDb(dataRoot);
      const next = { homeDir, root: layout.root, dataRoot, mode: current, libraryDb };
      // Test mode's sample library, except after "Start as a new user" (a new install has an empty library).
      if (current === 'test' && !fs.existsSync(path.join(dataRoot, FRESH_MARK))) await library.seedIfEmpty(next, fixturesDir);
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
    requireTestMode();
    if (typeof value !== 'boolean') throw new TypeError('testMode must be a boolean');
    await closeAll();
    home.writeConfig(layout.root, { testMode: value });
    return describe();
  }

  // Wipes ~/.engelbart/test entirely (projects, library, annotations, seeds, instructions, test mode's GitHub sign-in)
  // and recreates it. `fresh` (the gear's "Start as a new user…", 2026-09-28) leaves the library empty, as a new install
  // has it, until the next plain reset: onboarding then runs exactly as it would on a new machine.
  async function resetTestData({ fresh = false } = {}) {
    requireTestMode();
    if (mode() !== 'test') throw new Error('Test mode is off');
    await closeAll();
    fs.rmSync(layout.testRoot, { recursive: true, force: true });
    home.ensureHome(homeDir, rootDir);
    if (fresh) fs.writeFileSync(path.join(layout.testRoot, FRESH_MARK), `${new Date().toISOString()}\n`);
    return describe();
  }

  return { layout, context, config: describe, setTestMode, resetTestData, requireTestMode, close: closeAll };
}

function registerEngelbartIpc({ ipcMain, trustedHandler, store, openExternal, revealItem, confirmReset, writeClipboard, bart, readModels, rememberModelChoice = () => null, notify, pickPaths = async () => [], beforeContextChange = async () => {}, describe = createDescriber(), identifyRepo = createRepoIdentifier(), listRemoteFiles = createRemoteFileLister(), github = null, openGithubPage = () => {}, tools = null, builds = null, sandbox = null }) {
  const handle = (channel, handler) => ipcMain.handle(`engelbart:${channel}`, trustedHandler(handler));
  const withCtx = (fn) => async (...args) => fn(await store.context(), ...args);
  // E2B previews (src/main/sandbox): library additions and workspace links that can start one run one at a time, and a
  // change of data mode waits for them, then stops every sandbox, before the old library closes.
  let changingMode = false;
  let additions = Promise.resolve();
  const changing = async (change) => {
    if (changingMode) throw new Error('Data mode is already changing');
    changingMode = true;
    try {
      await additions.catch(() => {});
      await beforeContextChange();
      await sandbox?.close();
      return await change();
    } finally { changingMode = false; }
  };
  const queued = (work) => {
    if (changingMode) throw new Error('Wait for the data mode change to finish');
    const next = additions.catch(() => {}).then(work);
    additions = next;
    return next;
  };
  // A saved GitHub repository newly in a workspace is a request to use it: its sandbox starts, or the one already running
  // is reused (even after this session's automatic preparation failed or was stopped). What was already there is left be.
  const startLinked = async (ctx, before, workspace) => {
    if (!sandbox) return workspace;
    const errors = [];
    for (const id of workspace.context) {
      if (before.has(id)) continue;
      const row = await ctx.libraryDb.get(id);
      if (!githubRepo(row?.url)) continue;
      try { await sandbox.start(ctx, id); } catch (error) { errors.push(`${row.name}: ${error.message}`); }
    }
    return errors.length ? { ...workspace, sandbox_error: errors.join('\n') } : workspace;
  };
  const changeWorkspaceContext = (pid, wid, change) => {
    const projectId = str(pid, 'project id', 64), workspaceId = str(wid, 'workspace id', 64);
    return queued(async () => {
      const ctx = await store.context();
      const held = projects.findWorkspace(ctx, projectId, workspaceId).workspace;
      const before = new Set(held.context.filter((id) => !held.removed.includes(id)));
      return startLinked(ctx, before, await change(ctx, projectId, workspaceId));
    });
  };

  handle('config', () => store.config());
  // Refused before anything closes or asks in a copy without test mode.
  handle('set-test-mode', async (value) => { store.requireTestMode(); return changing(() => store.setTestMode(value)); });
  handle('reset-test-data', async (options) => {
    store.requireTestMode();
    const fresh = !!(options && typeof options === 'object' && options.fresh === true);
    if (!(await confirmReset({ fresh }))) return { reset: false, ...store.config() };
    const config = await changing(() => store.resetTestData({ fresh }));
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

  // GitHub (src/main/github/connection.cjs): signing in through the default browser, and the repositories the App can read.
  // Every change of the sign-in is announced on `engelbart:github` with the status. `github-open` shows GitHub's device
  // authorization page again, or the App's install page, in the default browser.
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
  handle('record-edit', withCtx((ctx, pid, wid) => { projects.recordEdit(ctx, str(pid, 'project id', 64), str(wid, 'workspace id', 64)); navChanged(); return true; }));
  handle('seen-agents', withCtx((ctx, pid, wid) => { const seen = projects.seenAgents(ctx, str(pid, 'project id', 64), str(wid, 'workspace id', 64)); if (seen) navChanged(); return seen; }));
  handle('list-projects', withCtx((ctx) => projects.listProjects(ctx)));
  handle('create-project', withCtx((ctx, input) => projects.createProject(ctx, projectInput(input))));
  handle('create-project-with-welcome', withCtx((ctx, input) => projects.createProjectWithWelcome(ctx, projectInput(input))));
  // Onboarding (./store/onboarding.cjs): custom instructions, the folder "Create a folder for me" would make, the project
  // the last two screens describe, and a repository unticked again before the project exists.
  handle('instructions', withCtx((ctx) => onboarding.readInstructions(ctx)));
  handle('set-instructions', withCtx((ctx, text) => onboarding.writeInstructions(ctx, str(text, 'instructions', 40000))));
  handle('free-folder', withCtx((ctx, name) => onboarding.freeFolder(ctx, str(name, 'name'))));
  handle('check-folder', withCtx((ctx, value) => onboarding.existingFolder(ctx, str(value, 'directory', 4096))));
  // The launch check's first answer (a minute at most): until then Git's record may still be last launch's.
  const toolsChecked = async () => { for (let n = 0; n < 60 && tools && !tools.snapshot().checked; n += 1) await new Promise((resolve) => { setTimeout(resolve, 1000); }); };
  handle('start-project', withCtx((ctx, input) => {
    const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const folder = value.folder === 'existing' ? 'existing' : 'new';
    const context = (Array.isArray(value.context) ? value.context : []).slice(0, 500).map((id) => str(id, 'library id', 64));
    return onboarding.startProject(ctx, { name: str(value.name, 'name'), description: optStr(value.description, 'description', 8000) || '', folder, directory: folder === 'existing' ? str(value.directory, 'directory', 4096) : '', context }).then((made) => {
      // A folder Engelbart made gets its Build repository and first commit now, in the background, once the tool check
      // has found Git (build/manager.cjs prepareDefault): the first Build never meets a folder without a history.
      if (folder === 'new' && builds) void toolsChecked().then(() => builds.prepareDefault(ctx, made.project.id)).catch(() => {});
      return made;
    });
  }));
  // A repository's sandbox is stopped (and its runs forgotten) before its row can go.
  handle('discard-library-item', (id) => queued(async () => {
    const ctx = await store.context();
    const libraryId = str(id, 'library id', 64);
    return onboarding.discardItem(ctx, libraryId, { release: sandbox ? () => sandbox.release(ctx, libraryId) : null });
  }));
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
  // Delete in the switcher: the workspace, and all nested in it, into the sidebar's trash for a week; Restore there.
  handle('trash-workspace', withCtx((ctx, pid, wid) => { const out = projects.trashWorkspace(ctx, str(pid, 'project id', 64), str(wid, 'workspace id', 64)); navChanged(); return out; }));
  handle('restore-workspace', withCtx((ctx, pid, wid) => { const out = projects.restoreWorkspace(ctx, str(pid, 'project id', 64), str(wid, 'workspace id', 64)); navChanged(); return out; }));
  handle('set-workspace-context', (pid, wid, entries) => changeWorkspaceContext(pid, wid, (ctx, projectId, workspaceId) => projects.setWorkspaceContext(ctx, projectId, workspaceId, entries)));
  // The sidebar: search, +, Save and an @mention bring a library item into a workspace; the trash takes it out (and remembers that it did).
  handle('link-to-workspace', (pid, wid, ids) => {
    const adding = (Array.isArray(ids) ? ids : [ids]).slice(0, 200).map((id) => str(id, 'library id', 64));
    return changeWorkspaceContext(pid, wid, (ctx, projectId, workspaceId) => projects.linkToWorkspace(ctx, projectId, workspaceId, adding));
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

  // @bart and @brainstorm: the answer comes back as draft lines for the document. A run that fails answers too, so
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
      // `agent`: which line asked, @bart, @brainstorm or @discover (2026-09-30), the same run with other instructions.
      const agent = value.agent == null ? 'bart' : value.agent;
      if (!['bart', 'brainstorm', 'discover'].includes(agent)) throw new TypeError('agent must be bart, brainstorm or discover');
      const question = { askId, ref: docRef(value.ref), workspaceId: str(value.workspaceId, 'workspace id', 64), text: str(value.text, 'question', 8000), turns, choice, agent };
      // The ask is an agent of its workspace: running now, waiting for you once its answer (or failure) has landed.
      started = track(() => projects.agentStarted(ctx, { id: askId, kind: agent, projectId: pid, workspaceId: question.workspaceId, doc: question.ref }));
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
  // A provider's `start` is where a question without flags starts: the last model and effort picked by hand (bart/choices.cjs).
  handle('bart-models', () => { const { provider, providers } = readModels('bart'); return { provider, providers }; });
  // The model and effort just picked in a Build panel ('build') or a post-it's Build ('quick'), kept as where the next one
  // starts. @bart's are kept by the question that uses them (bart/ask.cjs onPicked).
  handle('remember-model-choice', (place, choice) => {
    if (place !== 'build' && place !== 'quick') throw new TypeError('place must be build or quick');
    const value = choice && typeof choice === 'object' ? choice : {};
    return rememberModelChoice(place, { provider: str(value.provider, 'provider', 24), model: str(value.model, 'model', 24), effort: str(value.effort, 'effort', 24) });
  });
  // Copy all under an answer: a question and its answer, as they read in the document.
  handle('copy-text', (text) => { writeClipboard(str(text, 'text', 400000)); return true; });

  // Build (src/main/build; docs/superpowers/specs/2026-09-25-build-workflow-design.md): a workspace handed to Claude Code
  // or Codex in a worktree of its own. Every change of a Build is announced on `engelbart:build` with its public record,
  // and what its turn is doing on `engelbart:build-progress`.
  if (builds) {
    const b = () => builds;
    const pidOf = (pid) => str(pid, 'project id', 64);
    // The repository a Build works in: the renderer names it (the default repo, the project folder, a library row);
    // main finds its folder. A path never comes from the renderer.
    const targetOf = (value) => {
      if (value == null) return null;
      if (typeof value !== 'object' || Array.isArray(value) || !['default', 'project', 'library'].includes(value.kind)) throw new TypeError('target must name the default repo, the project folder or a library row');
      return value.kind === 'library' ? { kind: 'library', id: str(value.id, 'library id', 64) } : { kind: value.kind };
    };
    // What a Build panel ('build', the default) or a post-it's Build ('quick') offers, starting on what was last picked there.
    handle('build-models', (place) => buildChoices(readModels(place === 'quick' ? 'quick' : 'build')));
    handle('build-targets', withCtx((ctx, pid) => b().targets(ctx, pidOf(pid))));
    // The project's default repo (Make default in the picker): the code directory or a library row, never a path.
    handle('build-set-default', withCtx((ctx, pid, target) => b().setDefault(ctx, pidOf(pid), targetOf(target))));
    handle('build-preflight', withCtx((ctx, pid, target) => b().preflight(ctx, pidOf(pid), targetOf(target))));
    handle('build-init', withCtx((ctx, pid, target) => b().initRepository(ctx, pidOf(pid), targetOf(target))));
    handle('build-clone', withCtx((ctx, pid, target) => b().cloneRepository(ctx, pidOf(pid), targetOf(target))));
    handle('build-start', withCtx((ctx, pid, input) => {
      const value = input && typeof input === 'object' ? input : {};
      return b().start(ctx, pidOf(pid), {
        kind: value.kind === 'quick' ? 'quick' : 'build',
        workspaceId: optStr(value.workspaceId, 'workspace id', 64),
        postItId: optStr(value.postItId, 'post-it id', 64),
        text: optStr(value.text, 'text', 200000),
        provider: optStr(value.provider, 'provider', 24),
        model: optStr(value.model, 'model', 24),
        effort: optStr(value.effort, 'effort', 24),
        attach: (Array.isArray(value.attach) ? value.attach : []).slice(0, 50).map((id) => str(id, 'library id', 64)),
        target: targetOf(value.target),
      });
    }));
    handle('build-list', withCtx((ctx, pid) => b().list(ctx, pidOf(pid))));
    handle('build-get', withCtx((ctx, pid, id) => b().get(ctx, pidOf(pid), buildId(id))));
    handle('build-reply', withCtx((ctx, pid, id, text, options) => b().reply(ctx, pidOf(pid), buildId(id), str(text, 'reply', 100000), { interrupt: !!(options && options.interrupt), images: options && Array.isArray(options.images) ? options.images.slice(0, 50).map((image) => ({ n: image && image.n, id: image && image.id })) : [] })));
    handle('build-stop', (pid, id) => b().stop(pidOf(pid), buildId(id)));
    handle('build-resume', withCtx((ctx, pid, id) => b().resume(ctx, pidOf(pid), buildId(id))));
    handle('build-review', withCtx((ctx, pid, id) => b().review(ctx, pidOf(pid), buildId(id))));
    handle('build-accept', withCtx((ctx, pid, id) => b().accept(ctx, pidOf(pid), buildId(id))));
    handle('build-fix', withCtx((ctx, pid, id) => b().fix(ctx, pidOf(pid), buildId(id))));
    handle('build-discard', withCtx((ctx, pid, id) => b().discard(ctx, pidOf(pid), buildId(id))));
    // Its run step (build/run-step.cjs): a runnable it got running shown again (a UI's Stage tab, a terminal program's
    // session), and Stop for one still working.
    handle('build-run-show', withCtx((ctx, pid, id, name) => b().showRunnable(ctx, pidOf(pid), buildId(id), str(name, 'runnable name', 64))));
    handle('build-run-stop', withCtx((ctx, pid, id) => b().stopRunning(ctx, pidOf(pid), buildId(id))));
    handle('build-run-stop-runnable', withCtx((ctx, pid, id, name) => b().stopRunnable(ctx, pidOf(pid), buildId(id), name === null ? null : str(name, 'runnable name', 64))));
    handle('build-promote', withCtx((ctx, pid, id, wid, choice) => {
      const value = choice && typeof choice === 'object' ? choice : null;
      const picked = value ? { provider: optStr(value.provider, 'provider', 24), model: optStr(value.model, 'model', 24), effort: optStr(value.effort, 'effort', 24) } : null;
      return b().promote(ctx, pidOf(pid), buildId(id), str(wid, 'workspace id', 64), picked);
    }));
  }
  // Clear (B21): the document archived and started blank, keeping the lines of Builds still open; what it mentioned stays
  // on the sidebar. Restore (B22) brings an archived version back, the current one archived first.
  const keepOpenBuilds = (ctx, pid) => {
    const open = builds ? builds.openIds(ctx, pid) : new Set();
    return (line) => { const m = BUILD_LINE_RE.exec(line.trim()); return !!m && open.has(m[1]); };
  };
  handle('clear-workspace', withCtx((ctx, pid, wid) => archive.clearWorkspace(ctx, str(pid, 'project id', 64), str(wid, 'workspace id', 64), { keep: keepOpenBuilds(ctx, pid) })));
  handle('restore-archive', withCtx((ctx, pid, wid, file) => archive.restoreArchive(ctx, str(pid, 'project id', 64), str(wid, 'workspace id', 64), str(file, 'archive', 64), { keep: keepOpenBuilds(ctx, pid) })));
  handle('read-archive', withCtx((ctx, pid, wid, file) => { const got = archive.readArchive(ctx, str(pid, 'project id', 64), str(wid, 'workspace id', 64), str(file, 'archive', 64)); return { path: got.path, text: got.text }; }));

  handle('resolve-page-file', withCtx((ctx, pid, input) => projects.resolvePageFile(ctx, str(pid, 'project id', 64), str(input, 'path', 4096))));
  handle('read-text-file', withCtx((ctx, pid, input) => projects.readProjectTextFile(ctx, str(pid, 'project id', 64), str(input, 'path', 4096))));
  // The Stage: what is at a path, and what drawing it needs (a pdf's bytes, a picture's, text, a page's address).
  handle('stage-file', withCtx((ctx, pid, input) => projects.readStageFile(ctx, str(pid, 'project id', 64), str(input, 'path', 4096))));
  handle('library', withCtx((ctx) => library.listLibrary(ctx)));
  // Both directions of "who holds what", derived from the workspaces on disk (no join table).
  handle('projects-for-library-item', withCtx((ctx, id) => library.projectsForLibraryItem(ctx, str(id, 'library id', 64))));
  handle('library-for-project', withCtx((ctx, pid) => library.libraryForProject(ctx, str(pid, 'project id', 64))));
  // Adding makes a new row or throws "Already in the library as …" (library.addItem). `options.name` names it (the Browser's Save card).
  // A GitHub repository's sandbox starts once the row is saved; a failure to start it leaves the row saved and says why.
  handle('add-library-item', (input, options) => {
    const value = str(input, 'link or path', 4096);
    const name = optStr(options && typeof options === 'object' ? options.name : null, 'name', 200);
    return queued(async () => {
      const ctx = await store.context();
      const row = await library.addItem(ctx, value, { describe, identifyRepo, inspectPdf, name });
      // Adding a local clone or a non-GitHub item does not start remote work.
      if (sandbox && /^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:)/i.test(value.trim())) {
        try { await sandbox.start(ctx, row.id); } catch (error) { return { ...row, sandbox_error: error.message }; }
      }
      return row;
    });
  });
  // E2B previews of saved GitHub repositories (src/main/sandbox; docs/sandbox-runs.md). Each renderer call names a library
  // row or a run; sandbox ids, keys and paths never come from the renderer.
  if (sandbox) {
    handle('sandbox-runs', withCtx((ctx) => sandbox.list(ctx)));
    // Every saved GitHub repository is prepared once per app session (manager.start's `automatic`).
    handle('sandbox-ensure', () => queued(async () => {
      const ctx = await store.context();
      const errors = [];
      for (const row of await ctx.libraryDb.list()) {
        if (!row.tags.includes('git')) continue;
        try { await sandbox.start(ctx, row.id, { automatic: true }); } catch (error) { errors.push(`${row.name}: ${error.message}`); }
      }
      if (errors.length) throw new Error(errors.join('\n'));
      return sandbox.list(ctx);
    }));
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
  } else {
    // Turned off (ENGELBART_SANDBOXES=off): nothing to show, and nothing starts.
    handle('sandbox-runs', () => []);
    handle('sandbox-ensure', () => []);
    for (const channel of ['sandbox-start', 'sandbox-stop', 'sandbox-environment', 'sandbox-save-environment', 'sandbox-restart']) {
      handle(channel, () => { throw new Error('Sandboxes are turned off in this copy of Engelbart'); });
    }
  }
  // A pdf read from the web, saved as a copy with its address (library.addPdfCopy; the Stage's Save sends its bytes).
  handle('add-library-pdf', withCtx((ctx, input, bytes, options) => {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('pdf bytes are missing');
    return library.addPdfCopy(ctx, str(input, 'address', 8192), bytes, { inspectPdf, name: optStr(options && typeof options === 'object' ? options.name : null, 'name', 200) });
  }));
  handle('lookup-library-item', withCtx((ctx, input) => library.lookupItem(ctx, str(input, 'link or path', 4096))));
  // "Choose from disk…": the native picker, files and folders, several at once.
  handle('pick-library-paths', (kind) => pickPaths(kind === 'pdf' ? 'pdf' : 'any'));
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

  // Git, Claude Code and Codex (src/main/tools/manager.cjs): the setup dialog's snapshot and its buttons. Installs,
  // updates and sign-ins answer at once and report through `engelbart:tools` as they go.
  if (tools) {
    const toolName = (value) => { if (!TOOL_NAMES.includes(value)) throw new TypeError('Unknown tool'); return value; };
    const toolNames = (value) => (Array.isArray(value) ? value : [value]).slice(0, 3).map(toolName);
    handle('tools', () => tools.snapshot());
    handle('tools-check', () => tools.check());
    handle('tools-install', (names) => { void tools.install(toolNames(names)).catch(() => {}); return tools.snapshot(); });
    handle('tools-update', (name) => { void tools.update(toolName(name)).catch(() => {}); return tools.snapshot(); });
    handle('tools-sign-in', (name) => { void tools.signIn(toolName(name)).catch(() => {}); return tools.snapshot(); });
    handle('tools-cancel-sign-in', (name) => tools.cancelSignIn(toolName(name)));
    handle('tools-skip', (names) => tools.skip(toolNames(names)));
    handle('tools-ask-again', (name) => tools.askAgain(toolName(name)));
    handle('tools-set-updates', (value) => tools.setUpdates(value === 'ask' ? 'ask' : 'auto'));
  }

  handle('shell-history', () => readShellHistory({ homeDir: require('node:os').homedir() }));
  handle('open-external', (url) => openExternal(url));
  handle('reveal', async (target) => {
    const value = path.resolve(str(target, 'path', 4096));
    if (!value.startsWith(store.layout.root + path.sep) && value !== store.layout.root) throw new Error('Only paths inside ~/.engelbart can be revealed');
    return revealItem(value);
  });
}

module.exports = { createStore, registerEngelbartIpc };
