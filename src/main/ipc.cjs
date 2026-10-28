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
const elsewhere = require('./store/elsewhere.cjs');
const folderFiles = require('./store/folder-files.cjs');
const zoteroMirror = require('./zotero/mirror.cjs');
const { expandDoc } = require('./context/expand-mentions.cjs');
const { failureLines } = require('./bart/reply.cjs');
const createdFiles = require('./bart/create.cjs');
const { clipMiddle } = require('./bart/clip.cjs');
const { askEntry } = require('../shared/mark-answers.cjs');
const { readShellHistory } = require('./shell-history.cjs');
const { createDescriber, createRepoIdentifier, createRemoteFileLister } = require('./store/page-meta.cjs');
const { inspectPdf } = require('./context/pdf-kind.cjs');
const { TOOL_NAMES } = require('./tools/requirements.cjs');
const archive = require('./store/archive.cjs');
const onboarding = require('./store/onboarding.cjs');
const gettingStarted = require('./store/getting-started.cjs');
const history = require('./store/history.cjs');
const { buildChoices } = require('./bart/models.cjs');
const { providerOf, namingStep, fallbackTitle } = require('./bart/name-chat.cjs');
const { githubRepo } = require('./sandbox/runs.cjs');
const { candidate: pdfCandidate } = require('./store/web-pdfs.cjs');
const { detect: detectSources } = require('./connect/scan.cjs');
const folderAccess = require('./connect/folder-access.cjs');

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

// A document an agent is asked from: a note, a workspace, or (MATH-27, 2026-10-06) a highlight on a pdf in the Stage,
// `{ kind: 'mark', id, rowId | url, page }`: the mark's id, the library row the pdf is (else the address its ink is kept
// by), and its page. A highlight on a web page (MATH-54) has no page: `{ kind: 'mark', id, rowId | url, source: 'web' }`,
// its mark in the ink's "web" list. A mark is no document: reading, writing or copying one is refused further on
// (projects.resolveDoc).
function docRef(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('doc ref must be an object');
  if (value.kind === 'note') return { kind: 'note', id: str(value.id, 'note id', 64) };
  if (value.kind === 'workspace') return { kind: 'workspace', workspaceId: str(value.workspaceId, 'workspace id', 64) };
  if (value.kind === 'project') return { kind: 'project' }; // the top-level project's page (projects.cjs PROJECT_PAGE)
  if (value.kind === 'mark') {
    const id = str(value.id, 'mark id', 64);
    if (!/^[\w-]+$/.test(id)) throw new TypeError('mark id is invalid');
    const web = value.source === 'web';
    if (value.source != null && !web) throw new TypeError('a highlight is on a pdf or on a web page (source "web")');
    if (web ? value.page != null : !Number.isInteger(value.page) || value.page < 1 || value.page > 100000) throw new TypeError(web ? 'a highlight on a web page has no page' : 'page must be a page number');
    const rowId = value.rowId == null ? null : str(value.rowId, 'library id', 64), url = value.url == null ? null : str(value.url, 'address', 8192);
    if (!rowId === !url) throw new TypeError('a highlight is on a library item (rowId) or on an address (url): one of the two');
    const on = web ? { source: 'web' } : { page: value.page };
    return rowId ? { kind: 'mark', id, rowId, ...on } : { kind: 'mark', id, url, ...on };
  }
  throw new TypeError('Unknown doc kind');
}

// Where an ask came from (2026-10-12, the Agent Viewer's click): the line's number when it was asked and the line as typed
// (`place` from the editor), with the project and the document. Bookkeeping only: anything odd is left out, never refused.
function placeOf(value, projectId, ref) {
  const held = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const line = Number.isInteger(held.line) && held.line >= 0 && held.line < 1e7 ? held.line : null;
  const text = typeof held.text === 'string' ? held.text.slice(0, 8000) : null;
  return { projectId, ref: ref || null, line, text };
}

/** A document ref, or null when there is none or it is not one (bookkeeping: `place`). */
function refOrNull(value) {
  try { return value == null ? null : docRef(value); } catch { return null; }
}

/** How the renderer keys a document (`ws:<id>`, `note:<id>`); a highlight is `mark:<id>`, never a note's key. */
const docKeyOf = (ref) => (ref.kind === 'workspace' ? `ws:${ref.workspaceId}` : ref.kind === 'project' ? 'project' : ref.kind === 'mark' ? `mark:${ref.id}` : `note:${ref.id}`);

// A string past `max` cut in the middle (bart/clip.cjs) rather than refused: a passage highlighted across many pages, an
// earlier turn longer than a turn may be (MATH-27 second pass, 2026-10-06).
/** A string cut to its first `max` characters instead of refused for its length; still refused when not a string. Null stays null. */
function cutStr(value, what, max) {
  if (value == null) return null;
  if (typeof value !== 'string') throw new TypeError(`${what} must be a string`);
  return value.length > max ? value.slice(0, max) : value;
}

/** The same, kept to its last `max` characters. */
function tailStr(value, what, max) {
  if (value == null) return null;
  if (typeof value !== 'string') throw new TypeError(`${what} must be a string`);
  return value.length > max ? value.slice(value.length - max) : value;
}

function clipped(value, what, max) {
  if (typeof value !== 'string') throw new TypeError(`${what} must be a string`);
  return clipMiddle(value, max);
}

/**
 * What a question asked from a highlight carries besides its ref: the passage (its start and end past 20,000 characters),
 * the note as it stands, the paper's name, and the page's text around the passage (pdf/marks.js pageWindow, about 4,000
 * characters; cut in the middle past 8,000). A web page's highlight (MATH-54) is the same, its `paper` the page's title;
 * its quote may come as the mark keeps it, { exact, prefix, suffix }, of which the passage is `exact`.
 */
function highlightInput(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const quote = input.quote && typeof input.quote === 'object' && !Array.isArray(input.quote) ? input.quote.exact : input.quote;
  return { quote: clipped(quote == null ? '' : quote, 'quote', 20000), note: str(input.note == null ? '' : input.note, 'note', 20000), paper: optStr(input.paper, 'paper name'), pageText: clipped(input.pageText == null ? '' : input.pageText, 'page text', 8000) };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What is in front in the Stage when @bart is asked (MATH-27, 2026-10-06): { rowId, url, page, kind }, the library row
 * the tab shows (else its address) and the page in view. A web page (MATH-54) is { kind: 'web', url, title }: where the
 * tab is and what the page calls itself. Only those two are read (bart/context.cjs <stage>): anything else, and no
 * Stage, is null. With `tab`, the Stage tab that shows it (MATH-54 build 3a), whose selection and picture are asked for.
 */
function stageInput(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('stage must be an object');
  const kind = str(value.kind == null ? '' : value.kind, 'stage kind', 24);
  if (kind === 'web') {
    const url = str(value.url, 'address', 4096).trim();
    const title = clipped(value.title == null ? '' : value.title, 'page title', 300).replace(/\s+/g, ' ').trim();
    const tab = value.tab == null ? null : str(value.tab, 'tab id', 128);
    if (tab && !/^[\w.-]+$/.test(tab)) throw new TypeError('tab id is invalid');
    return url ? { kind, url, title, ...(tab ? { tab } : {}) } : null;
  }
  if (kind !== 'pdf') return null;
  const rowId = value.rowId == null ? null : str(value.rowId, 'library id', 64);
  if (rowId && !UUID_RE.test(rowId)) throw new TypeError('library id is invalid');
  const url = value.url == null ? null : str(value.url, 'address', 4096);
  if (!Number.isInteger(value.page) || value.page < 1 || value.page > 100000) throw new TypeError('page must be a page number');
  return rowId || url ? { rowId, url, page: value.page, kind } : null;
}

/** The earlier turns of an exchange, the last 40, each cut in the middle past what a turn may hold. */
// The agents an earlier turn can say answered it (2026-10-13; bart/ask.cjs AGENTS).
const TURN_AGENTS = ['bart', 'brainstorm', 'discover', 'create'];
function turnsInput(value) {
  return (Array.isArray(value) ? value : []).slice(-40).map((turn) => ({ question: clipped(turn && turn.question, 'earlier question', 8000), answer: clipped(turn && turn.answer, 'earlier answer', 40000), ...(turn && TURN_AGENTS.includes(turn.agent) ? { agent: turn.agent } : {}) }));
}

// What Bart, the router, can pick (bart/route.cjs PICKS), and the agents a routed ask can say the person picked instead.
const ROUTE_PICKS = ['chat', 'brainstorm', 'discover', 'create', 'build'];

/**
 * An ask's `routed` ({ id?, build?, corrected?, by?, error? }), or null for a line Bart did not hand over. `by: 'error'`:
 * routing failed and the line went to its fallback, `error` saying why.
 */
function routedInput(value) {
  if (!value || typeof value !== 'object') return null;
  const id = optStr(value.id, 'route id', 80);
  const corrected = value.corrected == null ? null : str(value.corrected, 'corrected agent', 20);
  if (corrected && !ROUTE_PICKS.includes(corrected)) throw new TypeError('corrected must be chat, brainstorm, discover, create or build');
  const failed = value.by === 'error' ? { by: 'error', ...(value.error != null ? { error: cutStr(value.error, 'route error', 400) } : {}) } : {};
  return { ...(id ? { id } : {}), build: !!value.build, ...(corrected ? { corrected } : {}), ...failed };
}

function projectInput(value) {
  const input = typeof value === 'string' ? { name: value } : (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
  return { name: str(input.name, 'name'), path: optStr(input.path, 'path', 200), directory: optStr(input.directory, 'directory', 4096) };
}

// `inspectPdf` (the app passes pdf-kind's) is how a pdf is read for whether it is a paper when a library is re-categorized.
// `afterOpen(ctx)` runs each time a library is opened and ready, not awaited: background work that must not hold the
// library back (the app checks for pdfs saved as links: store/web-pdfs.cjs). `recheck(ctx)` runs it again for a library
// that is open, as `afterOpen(ctx, { again: true })`, when a row it would act on has just been added (2026-10-02).
// `testMode`: whether this copy has test mode at all (./developer.cjs). Without it config.json's `testMode` is read as
// off but never rewritten, so a developer's copy sharing the file keeps its setting.
function createStore({ homeDir, rootDir = null, fixturesDir, inspectPdf: readPdf = null, pdfTitle: readTitle = null, afterOpen = null, testMode: available = false, zotero = null }) {
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
      // `zotero()`: main's Zotero library (zotero/sync.cjs), for a mentioned item's file to be downloaded (MATH-65 build 2).
      const next = { homeDir, root: layout.root, dataRoot, mode: current, libraryDb, ...(zotero ? { zotero } : {}) };
      // Test mode's sample library, except after "Start as a new user" (a new install has an empty library).
      if (current === 'test' && !fs.existsSync(path.join(dataRoot, FRESH_MARK))) await library.seedIfEmpty(next, fixturesDir);
      // A library behind the category rules (converted from the old types, or from before a change of
      // rules) is brought up to them before anyone reads it: about 30 ms a pdf, once. Summaries are
      // not touched. A failure leaves the rows due for the next launch; the library still opens.
      try { await library.recategorize(next, { inspectPdf: readPdf }); } catch { /* still due */ }
      // The same, once per row per version of the title rules: a row from before Library Phase B is told where it came
      // from (an import's head line, or what it is), and a row still named by its file takes the name the file gives.
      try { await library.describeRows(next, { pdfTitle: readTitle }); } catch { /* still due */ }
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

  function recheck(ctx) {
    if (afterOpen) Promise.resolve().then(() => afterOpen(ctx, { again: true })).catch(() => {});
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

  return { layout, context, recheck, config: describe, setTestMode, resetTestData, requireTestMode, close: closeAll };
}

// Several windows (2026-10-03, src/main/windows.cjs): `windowHandler(fn)` is a trusted handler that calls fn(win, ...args)
// with the calling window, `reply(win, channel, payload)` answers that window alone, and `announce(channel, payload,
// { except })` tells every window but the one that saved. Without them (one window, the tests) win is null, a reply goes
// out on `notify`, and nothing is announced. `fetchUrl` is how a dropped link is read (add-library-url; the app passes
// the Stage's session, so a picture or a pdf behind a sign-in comes too).
// `savePageFor(win, tabId, dir)` writes the page a window's Stage tab shows into dir (add-library-page; the app passes
// that window's browser views' savePage). `stagePageFor(win, tabId)` reaches a window's Stage tab for an @bart turn
// (MATH-54 build 3a): { selection(), screenshot() } (the app passes that window's browser views'), or null.
// `overleafFor(win, stage)`: a window's Overleaf tabs for an @bart turn (MATH-65; overleaf/stage.cjs forTurn), or null.
// `getUpdates()`: the updater (updates.cjs), made after this is registered; null until then, and in the tests.
// `snapshotHtml(file, out)`: a picture of a page @create made (bart/created-preview.cjs); null in the tests.
function registerEngelbartIpc({ ipcMain, trustedHandler, store, openExternal, revealItem, confirmReset, writeClipboard, writeImage = () => {}, bart, readModels, menuModels = readModels, rememberModelChoice = () => null, nameChat = null, modelSettings = null, notify, pickPaths = async () => [], beforeContextChange = async () => {}, describe = createDescriber(), identifyRepo = createRepoIdentifier(), listRemoteFiles = createRemoteFileLister(), github = null, openGithubPage = () => {}, zotero = null, zoteroLibrary = null, tools = null, builds = null, sandbox = null, windowHandler = null, reply = null, announce = () => {}, pdfAdded = () => {}, fetchUrl = globalThis.fetch, savePageFor = null, stagePageFor = null, overleafFor = null, getUpdates = () => null, connect = null, connectors = null, appleNotes = null, connectSignedIn = async () => [], warmBrowsers = () => {}, onboarding: importFlow = null, scanner = null, agentMap = null, snapshotHtml = null, afterTestReset = async () => {} }) {
  const handle = (channel, handler) => ipcMain.handle(`engelbart:${channel}`, trustedHandler(handler));
  const fromWindow = windowHandler || ((fn) => trustedHandler((...args) => fn(null, ...args)));
  const handleFor = (channel, handler) => ipcMain.handle(`engelbart:${channel}`, fromWindow(handler));
  const answer = (win, channel, payload) => (reply && win ? reply(win, channel, payload) : notify && notify(channel, payload));
  // What a handler saved is told to the other windows: a project's tree (`engelbart:project-changed`, which they read
  // again; on the projects screen, the list of projects), or the library (`engelbart:library-changed`).
  // The handler is called as it was: one that refuses at once (a data mode change under way) still throws at once. With
  // `window`, it is called with the calling window first, as handleFor's are.
  const saving = (channel, handler, { project = null, library: rows = false, window: withWindow = false } = {}) => handleFor(channel, (win, ...args) => {
    const told = (out) => {
      const projectId = project ? project(args, out) : null;
      if (typeof projectId === 'string') announce('engelbart:project-changed', { projectId }, { except: win });
      if (rows) announce('engelbart:library-changed', {}, { except: win });
      return out;
    };
    const out = withWindow ? handler(win, ...args) : handler(...args);
    return out && typeof out.then === 'function' ? out.then(told) : told(out);
  });
  const first = ([pid]) => pid;
  const withCtx = (fn) => async (...args) => fn(await store.context(), ...args);
  // A document's saves (2026-10-03), whichever window makes them, one at a time: each that changes its text counts up its
  // revision, is told to every other window as `doc:changed { projectId, key, text, revision }` (key: as the renderer keys
  // documents, `ws:<id>` or `note:<id>`), and answers the window that saved with the revision, so a window can tell an
  // announcement from before its own save from one after it. Clear and Restore rewrite a workspace's document the same way.
  const revisions = new Map(); // `${projectId} ${key}` → revision
  const docTurns = new Map(); // `${projectId} ${key}` → the save in progress
  const inTurn = (projectId, key, work) => {
    const id = `${projectId} ${key}`;
    const run = (docTurns.get(id) || Promise.resolve()).catch(() => {}).then(work);
    docTurns.set(id, run);
    const done = () => { if (docTurns.get(id) === run) docTurns.delete(id); };
    run.then(done, done);
    return run;
  };
  const revised = (win, projectId, key, text) => {
    const id = `${projectId} ${key}`;
    const revision = (revisions.get(id) || 0) + 1;
    revisions.set(id, revision);
    announce('doc:changed', { projectId, key, text, revision }, { except: win });
    return revision;
  };
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
      connect?.suspendAll(); // its imports write into the library about to close: saved, to go on when it is open again
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
      try { await sandbox.start(ctx, id, { waitForClaude: true }); } catch (error) { errors.push(`${row.name}: ${error.message}`); }
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
  // The data root is the app's: every other window starts over on the new one (`engelbart:data-root-changed`).
  // The Agent map (agent-map/window.cjs) is for test mode alone: turned off, its window closes. Runs are still recorded.
  handleFor('set-test-mode', async (win, value) => {
    store.requireTestMode();
    const config = await changing(() => store.setTestMode(value));
    if (agentMap) agentMap.closeUnlessAvailable();
    announce('engelbart:data-root-changed', { config, fresh: false }, { except: win });
    return config;
  });
  handleFor('reset-test-data', async (win, options) => {
    store.requireTestMode();
    const fresh = !!(options && typeof options === 'object' && options.fresh === true);
    if (!(await confirmReset({ fresh }))) return { reset: false, ...store.config() };
    const config = await changing(() => store.resetTestData({ fresh }));
    // Everything kept about that data root outside it forgotten too (2026-10-15, Hudson: "resetting test data also
    // resets states so i see popups again"): its import runs, what discovery found, the provider and sign-in answers.
    try { if (connect && connect.forget) connect.forget(config.dataRoot); } catch { /* nothing kept */ }
    try { if (importFlow && importFlow.discovery && importFlow.discovery.forget) importFlow.discovery.forget(config.dataRoot); } catch { /* nothing kept */ }
    try { if (importFlow && importFlow.providers && importFlow.providers.forget) importFlow.providers.forget(); } catch { /* nothing kept */ }
    await Promise.resolve().then(() => afterTestReset({ dataRoot: config.dataRoot, fresh })).catch(() => {});
    announce('engelbart:data-root-changed', { config, fresh }, { except: win });
    return { reset: true, ...config };
  });

  handle('last-open', withCtx((ctx) => projects.readLastOpen(ctx)));
  handle('set-last-open', withCtx((ctx, value) => projects.writeLastOpen(ctx, value)));
  handle('views', withCtx((ctx, projectId) => projects.readViews(ctx, projectId)));
  handle('set-view', withCtx((ctx, projectId, workspaceId, view) => projects.writeView(ctx, projectId, workspaceId, view)));
  // A project's Stage tabs (MATH-10): read once when its Stage opens, written as they change.
  handle('stage', withCtx((ctx, projectId) => projects.readStage(ctx, projectId)));
  handle('set-stage', withCtx((ctx, projectId, value) => projects.writeStage(ctx, projectId, value)));
  // A page a Stage tab arrived at (MATH-127), kept in the project's .context/history.json. Never refuses: the write is
  // queued, and a failure is logged rather than told to the page.
  handle('record-visit', withCtx((ctx, projectId, visit) => { void history.record(ctx, projectId, visit); return true; }));
  // Where to go next (the sidebar's next row, ⌘J): the workspaces written in last and the agents running or waiting.
  // Every change is announced on `engelbart:nav`; the renderer reads `nav` again.
  const navChanged = () => notify('engelbart:nav', {});
  handle('nav', withCtx((ctx) => projects.readNav(ctx)));
  // The sidebar's Starred (2026-10-07): a project's starred library ids. Every change is announced on `engelbart:starred`
  // with the project's list, so its other windows show it too.
  handle('starred', withCtx((ctx, projectId) => projects.readStarred(ctx, projectId)));
  handle('set-starred', withCtx((ctx, projectId, itemId, on) => {
    const ids = projects.setStarred(ctx, str(projectId, 'project id', 64), str(itemId, 'library id', 64), on === true);
    if (notify) notify('engelbart:starred', { projectId, ids });
    return ids;
  }));

  // The sidebar's folders (2026-10-13): the person's own, the same in every project, each a list of library items. Every
  // change is announced on `engelbart:folders` with the whole list, so every window shows it.
  const foldersChanged = (folders) => { if (notify) notify('engelbart:folders', { folders }); return folders; };
  handle('folders', withCtx((ctx) => projects.readFolders(ctx)));
  handle('create-folder', withCtx((ctx, name) => { const out = projects.createFolder(ctx, str(name, 'folder name', 400)); foldersChanged(out.folders); return out; }));
  handle('rename-folder', withCtx((ctx, id, name) => foldersChanged(projects.renameFolder(ctx, str(id, 'folder id', 64), str(name, 'folder name', 400)))));
  handle('delete-folder', withCtx((ctx, id) => foldersChanged(projects.deleteFolder(ctx, str(id, 'folder id', 64)))));
  handle('add-to-folder', withCtx((ctx, id, ids) => foldersChanged(projects.addToFolder(ctx, str(id, 'folder id', 64), (Array.isArray(ids) ? ids : [ids]).slice(0, 200).map((each) => str(each, 'library id', 64))))));
  handle('remove-from-folder', withCtx((ctx, id, item) => foldersChanged(projects.removeFromFolder(ctx, str(id, 'folder id', 64), str(item, 'library id', 64)))));

  // GitHub (src/main/github/connection.cjs): signing in through the default browser, and the repositories the App can read.
  // Every change of the sign-in is announced on `engelbart:github` with the status. `github-open` shows GitHub's device
  // authorization page again, or the App's install page, in the default browser: 'install' with a url opens that one, an
  // organization's install page from github-repos's missingOrgs (MATH-111), only when it is the App's install page.
  const gh = () => { if (!github) throw new Error('GitHub is not available'); return github; };
  handle('github-status', () => (github ? github.status() : { configured: false, connected: false, pending: null, error: '', installUrl: '' }));
  handle('github-connect', () => gh().connect());
  handle('github-cancel', () => gh().cancel());
  handle('github-disconnect', () => gh().disconnect());
  handle('github-repos', () => gh().repos());
  handle('github-open', async (which, page) => {
    const status = gh().status();
    let url = which === 'install' ? status.installUrl : status.pending && status.pending.verificationUri;
    if (which === 'install' && page != null) {
      const asked = str(page, 'install page', 2048);
      const base = status.installUrl;
      if (!base || !(asked === base || asked.startsWith(`${base}/`) || asked.startsWith(`${base}?`))) throw new Error('Not the GitHub App\'s install page');
      url = asked;
    }
    if (!url) throw new Error(which === 'install' ? 'The GitHub App has no slug in ~/.engelbart/config.json (github.appSlug).' : 'No sign-in is waiting');
    await openGithubPage(url);
    return true;
  });
  // Zotero (src/main/zotero/connection.cjs, MATH-65): signing in through the default browser and the broker. Every change
  // is announced on `engelbart:zotero` with the status, which names the account and never carries the key.
  // The library (MATH-65 build 2, zotero/sync.cjs): the status carries the mirror's too (`sync`: { state, items, syncedAt,
  // error }); zotero-sync starts a sync and answers at once, its progress following on `engelbart:zotero`. Disconnecting
  // deletes the mirror. zotero-list is a level of the library for the @ menu, zotero-open what a mention's chip opens:
  // { path, source } a pdf for the paper viewer (its own, or a free copy found now, build 3), else { url, external } for
  // the default browser. While a free copy is looked for, main says so on `engelbart:zotero-finding` ({ key, finding }).
  // Build 4: a paper opened in the browser is answered `waiting: true`, and its pdf is waited for in the Downloads folder
  // (zotero/downloads.cjs), said on `engelbart:zotero-waiting` ({ key, waiting }; zotero-waiting lists them now), and,
  // once downloaded, opened on `engelbart:zotero-downloaded` ({ key, path }). zotero-attach makes a pdf dropped on a chip
  // the item's pdf: { path, source } to open, or { error } when the file is not a pdf.
  const zt = () => { if (!zotero) throw new Error('Zotero is not available'); return zotero; };
  const zoteroStatus = (status) => ({ ...status, sync: zoteroLibrary && status.connected ? zoteroLibrary.status() : null });
  handle('zotero-status', () => (zotero ? zoteroStatus(zotero.status()) : { configured: false, connected: false, username: '', userID: '', persisted: true, pending: null, error: '', sync: null }));
  handle('zotero-connect', async () => zoteroStatus(await zt().connect()));
  handle('zotero-cancel', () => zoteroStatus(zt().cancel()));
  handle('zotero-disconnect', async () => {
    const status = await zt().disconnect();
    if (zoteroLibrary) zoteroLibrary.clear();
    return zoteroStatus(status);
  });
  handle('zotero-sync', () => {
    if (!zotero || !zotero.status().connected) throw new Error('Zotero is not connected');
    if (zoteroLibrary) void zoteroLibrary.sync().catch(() => {});
    return zoteroStatus(zotero.status());
  });
  const zoteroRoot = () => (zoteroLibrary && zotero && zotero.status().connected ? zoteroLibrary.root() : null);
  // Build 5: group libraries. zotero-list's top is My Library and each group (zotero/mirror.cjs listLibraries); an item
  // is named by its ref, `<key>` for My Library's and `g<groupID>:<key>` for a group's (mirror.cjs parseRef), in
  // zotero-open and zotero-attach and on the finding, waiting and downloaded channels.
  handle('zotero-list', (rel) => {
    const root = zoteroRoot();
    if (!root) return { error: 'Zotero is not connected' };
    return zoteroMirror.listLibraries(root, rel == null ? '' : str(rel, 'path', 4096));
  });
  const zoteroRef = (value) => {
    const ref = str(value, 'item key', 64);
    const parsed = zoteroMirror.parseRef(ref);
    if (!parsed) throw new TypeError('item key is invalid');
    return { ref, ...parsed };
  };
  handle('zotero-open', async (key) => {
    const root = zoteroRoot();
    if (!root) return { error: 'Zotero is not connected' };
    const { ref, group, key: itemKey } = zoteroRef(key);
    const lib = typeof zoteroLibrary.library === 'function' ? zoteroLibrary.library(group) : null;
    if (!lib) return { error: 'Zotero is not connected' };
    const target = await zoteroMirror.openTarget(lib.root, itemKey, { download: lib.download, ...(lib.openAccess ? { openAccess: lib.openAccess } : {}), ...(lib.storageDir ? { storageDir: lib.storageDir } : {}), library: { group, name: lib.name } });
    if (target && target.external && typeof zoteroLibrary.awaitDownload === 'function' && zoteroLibrary.awaitDownload(ref)) return { ...target, waiting: true };
    return target;
  });
  handle('zotero-waiting', () => (zoteroRoot() && typeof zoteroLibrary.waitingFor === 'function' ? zoteroLibrary.waitingFor() : []));
  handle('zotero-attach', (key, file) => {
    const root = zoteroRoot();
    if (!root) return { error: 'Zotero is not connected' };
    const { ref } = zoteroRef(key);
    const from = str(file, 'file', 4096);
    if (!path.isAbsolute(from)) throw new TypeError('file must be an absolute path');
    try {
      const copy = zoteroLibrary.attach(ref, from);
      return copy ? { path: copy.path, source: copy.source } : { error: 'The PDF could not be kept.' };
    } catch (error) { return { error: error && error.message ? error.message : 'The PDF could not be kept.' }; }
  });
  handle('record-edit', withCtx((ctx, pid, wid) => { projects.recordEdit(ctx, str(pid, 'project id', 64), str(wid, 'workspace id', 64)); navChanged(); return true; }));
  handle('seen-agents', withCtx((ctx, pid, wid) => { const seen = projects.seenAgents(ctx, str(pid, 'project id', 64), str(wid, 'workspace id', 64)); if (seen) navChanged(); return seen; }));
  handle('list-projects', withCtx((ctx) => projects.listProjects(ctx)));
  saving('create-project', withCtx((ctx, input) => projects.createProject(ctx, projectInput(input))), { project: (_args, out) => out && out.id });
  saving('create-project-with-welcome', withCtx((ctx, input) => projects.createProjectWithWelcome(ctx, projectInput(input))), { project: (_args, out) => out && out.project && out.project.id });
  // Onboarding (./store/onboarding.cjs): custom instructions, the folder "Create a folder for me" would make, the project
  // the last two screens describe, and a repository unticked again before the project exists.
  handle('instructions', withCtx((ctx) => onboarding.readInstructions(ctx)));
  handle('set-instructions', withCtx((ctx, text) => onboarding.writeInstructions(ctx, str(text, 'instructions', 40000))));
  handle('free-folder', withCtx((ctx, name) => onboarding.freeFolder(ctx, str(name, 'name'))));
  handle('check-folder', withCtx((ctx, value) => onboarding.existingFolder(ctx, str(value, 'directory', 4096))));
  // The launch check's first answer (a minute at most): until then Git's record may still be last launch's.
  const toolsChecked = async () => { for (let n = 0; n < 60 && tools && !tools.snapshot().checked; n += 1) await new Promise((resolve) => { setTimeout(resolve, 1000); }); };
  saving('start-project', withCtx((ctx, input) => {
    const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const folder = value.folder === 'existing' ? 'existing' : 'new';
    const context = (Array.isArray(value.context) ? value.context : []).slice(0, 500).map((id) => str(id, 'library id', 64));
    const imported = optStr(value.connect, 'import id', 64);
    const welcome = value.onboarding === true; // a new user's onboarding, not + Project: the Welcome walkthrough
    return onboarding.startProject(ctx, { name: str(value.name, 'name'), description: optStr(value.description, 'description', 8000) || '', folder, directory: folder === 'existing' ? str(value.directory, 'directory', 4096) : '', context, ...(welcome ? { welcomePage: true } : {}) }).then(async (made) => {
      // A folder Engelbart made gets its Build repository and first commit now, in the background, once the tool check
      // has found Git (build/manager.cjs prepareDefault): the first Build never meets a folder without a history.
      if (folder === 'new' && builds) void toolsChecked().then(() => builds.prepareDefault(ctx, made.project.id)).catch(() => {});
      // Connect your library's notes, held until there was a project (connect/session.cjs attachProject), go into this one,
      // and what it brought into the library joins the Welcome workspace's context, now and as more comes in.
      if (imported && connect) made.importedNotes = await connect.attachProject(ctx, imported, made.project.id, made.workspaceId).catch(() => 0);
      // 2026-10-14: the Welcome! page in place of the walkthrough (store/projects.cjs createProjectWithWelcomePage).
      // A new user's onboarding is the guided setup: it is not offered to them afterwards.
      if (welcome) { try { gettingStarted.markGuidedOffer(ctx, 'onboarded'); } catch { /* offered once more at worst */ } }
      return made;
    });
  }), { project: (_args, out) => out && out.project && out.project.id, library: true });
  // The guided setup started inside a project (2026-10-10): start-project's end without the project. That project gets a
  // Welcome workspace (another one on every run; nothing already there is removed) with what the setup added in its
  // context, the walkthrough, and Connect your library's session attached as start-project attaches it.
  saving('welcome-workspace', withCtx((ctx, pid, input) => {
    const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const context = (Array.isArray(value.context) ? value.context : []).slice(0, 500).map((id) => str(id, 'library id', 64));
    const imported = optStr(value.connect, 'import id', 64);
    return onboarding.addWelcomeWorkspace(ctx, str(pid, 'project id', 64), { context }).then(async (made) => {
      if (imported && connect) made.importedNotes = await connect.attachProject(ctx, imported, made.project.id, made.workspaceId).catch(() => 0);
      made.gettingStarted = gettingStarted.startGettingStarted(ctx, made.project.id, { workspaceId: made.workspaceId });
      try { gettingStarted.markGuidedOffer(ctx, 'onboarded'); } catch { /* offered once more at worst */ }
      return made;
    });
  }), { project: first, library: true });
  // Connect your library (./connect, 2026-10-07): the chat that brings the person's notes, chats, papers, sites and code
  // into the library, in onboarding and, once, as a popup for someone who has projects already. In every library since
  // 2026-10-08 ("migrate the agent onboarding features to non-testing, too"); it was test mode's only until then, and
  // each data root keeps its own sessions, offer and MEMORY.md. connect-detect: which apps are on this Mac (and
  // signed in to in Engelbart's browser), so the choose screen starts with those ticked; connect-providers: Claude Code and
  // Codex, which can run and on which pinned model. connect-start: the choose screen's picks → the session (the scan, the
  // surveys and the librarian's first turn run in the background); connect-answer: a reply ({ text } | { picked, text? } |
  // { skipped }); connect-authorize: a button in the chat used ({ app, kind: 'signin' | 'connector' | 'permission' |
  // 'folder', path }); connect-need: a request an agent handed the person, opened, done or skipped; connect-import: Import,
  // every source not yet handed over goes now; connect-stop (all) and connect-stop-job; connect-list: the sessions the
  // dock shows. Every change of a session is sent as `engelbart:connect` with its snapshot.
  const cx = () => {
    if (!connect) throw new Error('Connect your library is not available');
    return connect;
  };
  const importId = (value) => str(value, 'import id', 64);
  const plainObject = (value, what) => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${what} is invalid`); return value; };
  const appName = (value) => str(value, 'app', 64);
  // Spotlight asked in the background which browsers are installed, as Connect opens (./browser/installed-apps.cjs).
  const warm = () => { try { void Promise.resolve(warmBrowsers()).catch(() => {}); } catch { /* not asked */ } };
  // `platform`: off the Mac, web apps' rows say "Not on Windows yet" and can't be ticked (2026-10-12, model/connect.js notOnYet).
  // Read in the scanner process when there is one (./connect/scan-child.cjs): on this process it froze the window ~4 s.
  handle('connect-detect', withCtx(async (ctx) => {
    cx(); warm();
    const guard = folderAccess.guard({ homeDir: ctx.homeDir, dataRoot: ctx.dataRoot });
    const signedIn = await connectSignedIn().catch(() => []);
    const applications = process.env.ENGELBART_CONNECT_APPLICATIONS != null ? { applications: process.env.ENGELBART_CONNECT_APPLICATIONS.split(':').filter(Boolean) } : {};
    if (scanner) {
      const connected = {};
      for (const [app, entry] of Object.entries(require('../shared/connect-sources.cjs').APPS)) {
        if (entry.reach !== 'connector') continue;
        try { connected[app] = !!(connectors && connectors.status(app).connected); } catch { connected[app] = false; }
      }
      const found = await scanner.run('detect', { homeDir: ctx.homeDir, access: { dataRoot: ctx.dataRoot, answers: guard.answers }, zotero: zotero ? zotero.status() : null, github: github ? github.status() : null, signedIn, connectors: connected, ...applications }).catch(() => null);
      if (found) return { platform: process.platform, ...found };
    }
    return { platform: process.platform, ...await detectSources({ homeDir: ctx.homeDir, access: guard, zotero: () => (zotero ? zotero.status() : null), github: () => (github ? github.status() : null), signedIn, connectors: (app) => !!(connectors && connectors.status(app).connected), ...applications }) };
  }));
  handle('connect-providers', () => { const out = cx().providers(); warm(); return out; });
  handle('connect-start', (input) => cx().start(plainObject(input, 'choices')));
  handle('connect-answer', (id, input) => cx().answer(importId(id), plainObject(input, 'answer')));
  handle('connect-grant', (id, input) => cx().grant(importId(id), plainObject(input, 'grant')));
  const authorizeInput = (input) => { const value = plainObject(input, 'choice'); return { app: appName(value.app), kind: str(value.kind, 'kind', 16), path: optStr(value.path, 'path', 4096) }; };
  handle('connect-authorize', (id, input) => cx().authorize(importId(id), authorizeInput(input)));
  handle('connect-chose', (id, input) => cx().authorize(importId(id), authorizeInput(input)));
  handle('connect-cancel-sign-in', (id, app) => cx().cancelSignIn(importId(id), appName(app)));
  // A web app ticked on the choose screen (2026-10-10): what to say before macOS is asked for a browser's sign-ins
  // ({ browser, note }, note '' when it won't be), then the check that brings the sign-in over, however long macOS's prompt
  // waits ({ status: 'signed-in' | 'refused' | 'signed-out' | 'no-browser' | '' (can't be checked), browser }); `retry` is Try
  // again after a refusal.
  // `route` 'browser' (Google's Sign in, 2026-10-12): the browser its page opens in too ({ …, opens }). `profiles`: the
  // profiles to pick from when several hold the sign-in and none was picked before.
  handle('connect-signin-note', (app, route) => cx().signInNote(appName(app), { route: route === 'browser' ? 'browser' : '' }));
  // The profile picked ({ browser, profile }, ids), remembered for the sign-in.
  handle('connect-signin-pick', (app, pick) => { const value = plainObject(pick, 'pick'); return cx().signInPick(appName(app), { browser: str(value.browser, 'browser', 64), profile: str(value.profile, 'profile', 120) }); });
  // Google's Sign in in the person's browser, waited for until signed in or cancelled (no time limit).
  handle('connect-signin-browser', (app) => cx().signInBrowser(appName(app)));
  handle('connect-signin-unlock', (app) => cx().signInUnlock(appName(app)));
  handle('connect-signin-another-account', (app) => cx().signInAnotherAccount(appName(app)));
  handle('connect-signin-browser-cancel', (app) => cx().signInBrowserCancel(app == null ? '' : appName(app)));
  // MATH-110: macOS's folder access, asked for once on the choose screen. connect-folders-needed: the protected folders
  // (Desktop, Documents, Downloads, iCloud Drive, the drives) these choices would read and never asked about → [{ id, name }];
  // connect-folders-ask: reads each in turn so macOS asks, → { [id]: 'allowed' | 'denied' }, kept in .connect/folders.json.
  handle('connect-folders-needed', withCtx((ctx, choices) => folderAccess.needed(plainObject(choices, 'choices'), { homeDir: ctx.homeDir, dataRoot: ctx.dataRoot })));
  // connect-folders-asked: what folders.json holds, { [id]: 'allowed' | 'denied' } (Import your context asks once, 2026-10-15).
  handle('connect-folders-asked', withCtx((ctx) => folderAccess.readAnswers(ctx.dataRoot)));
  handle('connect-folders-ask', withCtx((ctx, ids) => {
    if (!Array.isArray(ids) || ids.length > 40 || !ids.every((id) => typeof id === 'string' && id.length < 400)) throw new Error('ids must be a list of folder ids');
    return folderAccess.ask(ids, { homeDir: ctx.homeDir, dataRoot: ctx.dataRoot });
  }));
  handle('connect-signin-check', (app, retry) => cx().signInCheck(appName(app), { retry: retry === true }));
  handle('connect-signin-window', (app) => cx().signInWindowOpen(appName(app)));
  handle('connect-signin-window-close', () => cx().signInWindowClose());
  handle('connect-need', (id, needId, action) => cx().need(importId(id), str(needId, 'request id', 64), str(action, 'action', 8)));
  handle('connect-import', (id) => cx().importNow(importId(id)));
  handle('connect-stop', (id) => cx().stop(importId(id)));
  // A run waiting for its provider (session.cjs holdForProvider): it goes on, on `provider` when the other one was picked.
  handle('connect-unblock', (id, provider) => cx().unblock(importId(id), provider === 'anthropic' || provider === 'openai' ? provider : null));
  handle('connect-stop-job', (id, jobId) => cx().stopJob(importId(id), str(jobId, 'job id', 64)));
  handle('connect-provider', (id, provider) => cx().setProvider(importId(id), str(provider, 'provider', 16)));
  handle('connect-retry-memory', (id) => cx().retryMemory(importId(id)));
  handle('connect-minimize', (id, value) => cx().setMinimized(importId(id), !!value));
  handle('connect-dismiss', (id) => cx().dismiss(importId(id)));
  handle('connect-state', (id) => cx().state(importId(id)));
  // A session that was still going when Engelbart closed goes on now (resume), before the list is read.
  handle('connect-list', withCtx((ctx) => { if (!connect) return []; connect.resume(ctx); return connect.list(ctx.dataRoot); }));
  // macOS's Automation prompt for Notes, asked from the choose screen's permissions (./connect/apple-notes.cjs).
  handle('connect-notes-permission', () => { cx(); return appleNotes ? appleNotes.permission() : { allowed: false, error: 'Apple Notes cannot be read here' }; });
  // The connectors Engelbart signs in to for the agents (./connect/connectors.cjs): Granola and Notion.
  handle('connect-connectors', () => { cx(); return connectors ? connectors.list() : []; });
  handle('connect-connector-sign-in', (app) => { cx(); if (!connectors) throw new Error('Connectors are not available'); return connectors.signIn(appName(app)); });
  handle('connect-connector-cancel', (app) => { cx(); if (connectors) connectors.cancel(appName(app)); return true; });
  // The one-time popup for someone with projects (2026-10-07: "Existing users should see a popup to do this once, but not
  // as an onboarding flow just like a popup they can dismiss"): shown until it has been seen once in this data root.
  // ENGELBART_CONNECT_OFFER=off never shows it (the smokes that are not about Connect: it would cover their workspace).
  const offerFile = (ctx) => path.join(ctx.dataRoot, '.connect', 'offer.json');
  handle('connect-offer', withCtx((ctx) => {
    if (!connect || process.env.ENGELBART_CONNECT_OFFER === 'off') return { show: false };
    try { return { show: !JSON.parse(fs.readFileSync(offerFile(ctx), 'utf8')).seen }; } catch { return { show: true }; }
  }));
  handle('connect-offer-seen', withCtx((ctx, how) => {
    cx();
    fs.mkdirSync(path.dirname(offerFile(ctx)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(offerFile(ctx), JSON.stringify({ seen: true, how: how === 'started' ? 'started' : 'dismissed', at: new Date().toISOString() }), { mode: 0o600 });
    return true;
  }));
  // The guided setup's one-time offer to someone with projects (./store/getting-started.cjs guidedOfferDue).
  // ENGELBART_CONNECT_OFFER=off never shows it, as it never showed Connect your library's popup it replaced (the smokes).
  handle('guided-offer', withCtx((ctx) => ({ show: process.env.ENGELBART_CONNECT_OFFER !== 'off' && gettingStarted.guidedOfferDue(ctx) })));
  handle('guided-offer-seen', withCtx((ctx, how) => gettingStarted.markGuidedOffer(ctx, typeof how === 'string' ? how : 'dismissed')));
  // The Welcome walkthrough (2026-10-09, ./store/getting-started.cjs): its state, and the steps the window ticked (or a
  // circle unticked by hand) and Hide.
  handle('getting-started', withCtx((ctx, pid) => gettingStarted.readGettingStarted(ctx, str(pid, 'project id', 64))));
  handle('set-getting-started', withCtx((ctx, pid, input) => {
    const value = plainObject(input, 'change');
    const steps = (list) => (Array.isArray(list) ? list.slice(0, gettingStarted.STEPS) : []);
    return gettingStarted.setGettingStarted(ctx, str(pid, 'project id', 64), { tick: steps(value.tick), untick: steps(value.untick), hidden: value.hidden === true });
  }));
  // MEMORY.md (./connect/memory.cjs): whether there is one in this data root, for the window to name and reveal.
  // Import your context (2026-10-13, the "Onboarding" workspace; ./onboarding): which provider runs its agents, the
  // browsers whose sign-ins it may use, the project and tool discovery agents, Full Disk Access, where the flow was (kept
  // across the relaunch Full Disk Access needs), and the Agent trace.
  const ix = () => { if (!importFlow) throw new Error('Import your context is not available'); return importFlow; };
  const providerId = (value) => { const id = str(value, 'provider', 16); if (id !== 'anthropic' && id !== 'openai') throw new TypeError('provider is invalid'); return id; };
  handle('import-providers', (fresh) => ix().providers.status({ fresh: fresh === true }));
  handle('import-provider-remember', (provider) => { ix().providers.remember(providerId(provider)); return ix().providers.status(); });
  handle('import-browsers', () => ix().browsers.list());
  handle('import-browser-choose', (id) => ix().browsers.choose(str(id, 'browser', 32)));
  // Allow asks macOS for the chosen browser's sign-ins at once and answers once macOS did (2026-10-16, C5): { keychain:
  // 'allowed' | 'refused' | 'declined', browser? }.
  handle('import-keychain', (answer) => ix().browsers.setKeychain(str(answer, 'answer', 16)));
  // Browser agents (./onboarding/browser-agents.cjs): whether the web apps' imports can run in the person's own browser,
  // and their answer to "Let agents use your browser?" ('allowed' | 'declined'; null forgets it).
  handle('import-browser-agents', (input) => {
    const value = input == null ? {} : plainObject(input, 'input');
    if (!ix().browserAgents) return { available: false, use: false, ask: false, browser: null, others: [], allowedByCli: false, consent: null, why: 'Not on this Mac' };
    return ix().browserAgents.status({ provider: value.provider == null ? null : providerId(value.provider), browserId: value.browserId == null ? null : str(value.browserId, 'browser', 32) });
  });
  handle('import-browser-agents-answer', (answer) => {
    if (answer !== null && answer !== 'allowed' && answer !== 'declined') throw new TypeError('answer is invalid');
    if (!ix().browserAgents) throw new Error('Browser agents are not available');
    return ix().browserAgents.consent(answer);
  });
  handle('import-discovery', () => ix().discovery.state());
  handle('import-discover-projects', (input) => {
    const value = input == null ? {} : plainObject(input, 'input');
    return ix().discovery.startProjects({ provider: value.provider == null ? null : providerId(value.provider), again: value.again === true });
  });
  handle('import-discover-tools', (input) => {
    const value = input == null ? {} : plainObject(input, 'input');
    return ix().discovery.startTools({ provider: value.provider == null ? null : providerId(value.provider), browserId: value.browserId == null ? null : str(value.browserId, 'browser', 32), keychain: value.keychain === 'allowed' ? 'allowed' : value.keychain === 'declined' ? 'declined' : null, again: value.again === true });
  });
  handle('import-discovery-stop', () => ix().discovery.stop());
  handle('import-discovery-reset', () => ix().discovery.reset());
  // Whether the folders macOS guards may already be read (granted on the person's own; nothing asks for it, 2026-10-15).
  handle('import-disk-access', () => ix().diskAccess.status());
  // The browser's profile every copy reads (2026-10-16, C4: "Select your {browser} profile") → the same as import-browsers.
  handle('import-browser-profile', (browserId, profileId) => ix().browsers.chooseProfile(str(browserId, 'browser', 32), str(profileId, 'profile', 120)));
  // Safari's "Grant disk access" (S9): System Settings ▸ Privacy & Security ▸ Full Disk Access, nothing else → { opened }.
  handle('import-open-disk-access', () => (typeof ix().diskAccess.open === 'function' ? ix().diskAccess.open() : { opened: false }));
  handle('import-flow', () => (ix().prefs.get().flow || null));
  handle('import-flow-save', (flow) => { if (flow === null) { ix().prefs.set({ flow: null }); return true; } ix().prefs.set({ flow: plainObject(flow, 'flow') }); return true; });
  handle('import-trace-open', () => ix().openTrace());
  // Choose files under Obsidian (2026-10-14): its vaults as its file explorer shows them (./onboarding/obsidian-tree.cjs).
  handle('import-obsidian-tree', withCtx((ctx) => require('./onboarding/obsidian-tree.cjs').obsidianTree(ctx.homeDir)));
  handle('connect-memory', withCtx((ctx) => { const file = path.join(ctx.dataRoot, 'MEMORY.md'); try { const stat = fs.statSync(file); return { exists: true, path: file, updated: stat.mtime.toISOString(), bytes: stat.size }; } catch { return { exists: false, path: file }; } }));
  // A repository's sandbox is stopped (and its runs forgotten) before its row can go.
  saving('discard-library-item', (id) => queued(async () => {
    const ctx = await store.context();
    const libraryId = str(id, 'library id', 64);
    return onboarding.discardItem(ctx, libraryId, { release: sandbox ? () => sandbox.release(ctx, libraryId) : null });
  }), { library: true });
  saving('rename-project', withCtx((ctx, id, name) => projects.renameProject(ctx, str(id, 'project id', 64), str(name, 'name'))), { project: first });
  // Delete on the all-projects screen (2026-10-03): the project into <dataRoot>/.trash for a week, its @bart asks and its
  // Builds stopped first (store/projects.cjs trashProject). "Recently deleted" reads the trash, which purges what has been
  // in it a week (its Builds' worktrees with it); Restore brings a project back, its Builds' worktrees following it.
  // The other windows are told: one showing the project leaves it, the projects screen reads the list again.
  const removeWorktrees = builds ? (tasks) => builds.removeWorktrees(tasks) : null;
  handleFor('trash-project', async (win, id) => {
    const ctx = await store.context();
    const projectId = str(id, 'project id', 64);
    const stopBuilds = async (pid) => {
      for (const agent of projects.readNav(ctx).agents) if (agent.projectId === pid && agent.kind !== 'build' && agent.status === 'running' && bart) bart.stop(agent.id);
      if (builds) await builds.stopProject(ctx, pid);
    };
    const out = await projects.trashProject(ctx, projectId, { stopBuilds });
    navChanged();
    announce('engelbart:project-changed', { projectId, trashed: true }, { except: win });
    return out;
  });
  saving('restore-project', withCtx(async (ctx, id) => {
    const out = await projects.restoreProject(ctx, str(id, 'project id', 64), { moveWorktree: builds ? (task, to) => builds.moveWorktree(task, to) : null, removeWorktrees });
    navChanged();
    return out;
  }), { project: first });
  handle('trashed-projects', withCtx((ctx) => projects.trashedProjects(ctx, Date.now(), { removeWorktrees })));
  handle('load-project', withCtx((ctx, id) => projects.loadProject(ctx, str(id, 'project id', 64))));

  saving('set-project-directory', withCtx((ctx, id, directory) => projects.setProjectDirectory(ctx, str(id, 'project id', 64), str(directory, 'directory', 4096))), { project: first });

  // Making a workspace counts as writing in it (⌘J's recent ones), typed in or not (2026-09-23).
  saving('create-workspace', withCtx(async (ctx, pid, input) => {
    const value = input && typeof input === 'object' ? input : {};
    const projectId = str(pid, 'project id', 64);
    const created = await projects.createWorkspace(ctx, projectId, { name: optStr(value.name, 'name'), parentId: optStr(value.parentId, 'parent id', 64) });
    projects.recordEdit(ctx, projectId, created.id);
    navChanged();
    return created;
  }), { project: first });
  // Another project's workspaces (MATH-148): every project's listed for the @ menu and a mention's tab; "Copy to this
  // project" makes one of them again at the top of this one, its original only read.
  handle('workspaces-everywhere', withCtx((ctx) => projects.workspacesEverywhere(ctx)));
  saving('copy-workspace-here', withCtx(async (ctx, pid, fromPid, wid) => {
    const projectId = str(pid, 'project id', 64);
    const created = await projects.copyWorkspaceInto(ctx, projectId, str(fromPid, 'project id', 64), str(wid, 'workspace id', 64));
    projects.recordEdit(ctx, projectId, created.id);
    navChanged();
    return created;
  }), { project: first });
  saving('rename-workspace', withCtx((ctx, pid, wid, name) => projects.renameWorkspace(ctx, str(pid, 'project id', 64), str(wid, 'workspace id', 64), str(name, 'name'))), { project: first });
  // Delete in the switcher: the workspace, and all nested in it, into the sidebar's trash for a week; Restore there.
  saving('trash-workspace', withCtx((ctx, pid, wid) => { const out = projects.trashWorkspace(ctx, str(pid, 'project id', 64), str(wid, 'workspace id', 64)); navChanged(); return out; }), { project: first });
  saving('restore-workspace', withCtx((ctx, pid, wid) => { const out = projects.restoreWorkspace(ctx, str(pid, 'project id', 64), str(wid, 'workspace id', 64)); navChanged(); return out; }), { project: first });
  saving('set-workspace-context', (pid, wid, entries) => changeWorkspaceContext(pid, wid, (ctx, projectId, workspaceId) => projects.setWorkspaceContext(ctx, projectId, workspaceId, entries)), { project: first });
  // The sidebar: search, +, Save and an @mention bring a library item into a workspace; the trash takes it out (and remembers that it did).
  // `picked`: the @ menu linked it; `unmentioned`: its last mention left the document (MATH-57).
  saving('link-to-workspace', (pid, wid, ids, opts) => {
    const adding = (Array.isArray(ids) ? ids : [ids]).slice(0, 200).map((id) => str(id, 'library id', 64)), picked = !!(opts && opts.picked === true);
    return changeWorkspaceContext(pid, wid, (ctx, projectId, workspaceId) => projects.linkToWorkspace(ctx, projectId, workspaceId, adding, { picked }));
  }, { project: first });
  saving('unlink-from-workspace', (pid, wid, id, opts) => {
    const entry = str(id, 'library id', 64), unmentioned = !!(opts && opts.unmentioned === true);
    return changeWorkspaceContext(pid, wid, (ctx, projectId, workspaceId) => projects.unlinkFromWorkspace(ctx, projectId, workspaceId, entry, { unmentioned }));
  }, { project: first });
  // The project's own list (2026-10-11, the Library): add rows to it (and to the open workspace), remove them from it and
  // from every workspace, and which workspaces still mention one. At most projects.MAX_PROJECT_CHANGE ids a call; more is
  // refused, not cut short. Queued with the workspace changes, which they write too.
  const projectIds = (ids) => {
    if (!Array.isArray(ids)) throw new TypeError('ids must be a list');
    if (ids.length > projects.MAX_PROJECT_CHANGE) throw new RangeError(`At most ${projects.MAX_PROJECT_CHANGE} items can be added or removed at once; ${ids.length} were sent.`);
    return ids.map((id) => str(id, 'library id', 64));
  };
  saving('add-to-project', (pid, ids, opts) => {
    const projectId = str(pid, 'project id', 64), adding = projectIds(ids);
    const workspaceId = opts && opts.workspaceId != null ? str(opts.workspaceId, 'workspace id', 64) : null;
    return queued(async () => {
      const ctx = await store.context();
      const before = workspaceId ? new Set(projects.findWorkspace(ctx, projectId, workspaceId).workspace.context) : null;
      const out = await projects.addToProject(ctx, projectId, adding, { workspaceId });
      if (workspaceId) {
        const linked = await startLinked(ctx, before, projects.findWorkspace(ctx, projectId, workspaceId).workspace);
        if (linked.sandbox_error) return { ...out, sandbox_error: linked.sandbox_error };
      }
      return out;
    });
  }, { project: first });
  saving('remove-from-project', (pid, ids) => {
    const projectId = str(pid, 'project id', 64), going = projectIds(ids);
    return queued(async () => projects.removeFromProject(await store.context(), projectId, going));
  }, { project: first });
  handle('project-item-mentions', withCtx((ctx, pid, id) => projects.projectItemMentions(ctx, str(pid, 'project id', 64), str(id, 'library id', 64))));

  saving('create-note', withCtx((ctx, pid, input) => {
    const value = input && typeof input === 'object' ? input : {};
    return projects.createNote(ctx, str(pid, 'project id', 64), { name: optStr(value.name, 'name'), workspaceId: optStr(value.workspaceId, 'workspace id', 64) });
  }), { project: first, library: true });
  saving('save-image', withCtx((ctx, pid, input) => {
    const value = input && typeof input === 'object' ? input : {};
    return projects.saveImage(ctx, str(pid, 'project id', 64), { bytes: value.bytes, mime: str(value.mime, 'mime', 64), name: optStr(value.name, 'name') });
  }), { library: true });
  handle('read-image', withCtx((ctx, id) => projects.readImage(ctx, str(id, 'image id', 64))));
  saving('rename-note', withCtx((ctx, pid, id, name) => projects.renameNote(ctx, str(pid, 'project id', 64), str(id, 'note id', 64), str(name, 'name'))), { project: first, library: true });
  handle('read-doc', withCtx((ctx, pid, ref) => projects.readDoc(ctx, str(pid, 'project id', 64), docRef(ref))));
  handleFor('write-doc', async (win, pid, ref, text) => {
    const projectId = str(pid, 'project id', 64), at = docRef(ref), key = docKeyOf(at);
    return inTurn(projectId, key, async () => {
      const out = await projects.writeDoc(await store.context(), projectId, at, text);
      // A save that changes nothing is announced to no one; it answers with the revision the document is at.
      const revision = out.lastEdited ? revised(win, projectId, key, text) : revisions.get(`${projectId} ${key}`) || 0;
      return { ...out, revision };
    });
  });
  // The sidebar's Copy: the document with every @mentioned file placed where it is mentioned. The
  // clipboard is written here because the renderer is refused every permission, and its own
  // clipboard wants a user gesture that reading the files can outlive.
  handle('copy-doc', withCtx(async (ctx, pid, ref) => {
    const { text, chars, files, missing } = await expandDoc(ctx, str(pid, 'project id', 64), docRef(ref));
    writeClipboard(text);
    return { chars, files, missing };
  }));

  // @bart, @brainstorm and @discover: the answer comes back as draft lines for the document. A run that fails answers too, so
  // the question line never stays locked behind a pending line; only Stop returns nothing to place.
  // A question from a highlight's note (MATH-27) is kept in `paperAsks` while it runs: its mark, the window that asked and
  // what the agent is doing as of its last progress, so that window shows its box again after ⌘R (running-paper-asks).
  // Its answer is put on the mark here (library.addMarkAnswer), as the Stage would, since a reloaded window has no one
  // waiting for it; how it ended is told to every window (`paper-ask-done`): each Stage holding the pdf shows the
  // answer, and the window that asked drops its box or says "No answer" (second pass, 2026-10-06).
  const paperAsks = new Map(); // askId → { win, projectId, askId, markId, page, rowId, url, source?, question, progress }
  const paperDone = (payload) => {
    paperAsks.delete(payload.askId);
    if (windowHandler) announce('engelbart:paper-ask-done', payload); else if (notify) notify('engelbart:paper-ask-done', payload);
  };
  // What the window's box shows, kept as the window keeps it (Workspace.jsx onBartProgress): a new step starts over.
  const paperProgress = (askId, { log, ...progress }) => {
    const held = paperAsks.get(askId);
    if (!held) return;
    const next = { ...held.progress, ...progress };
    if (progress.step) { next.activity = ''; next.lines = []; }
    if (log && progress.activity) next.log = [...(held.progress.log || []), progress.activity].slice(-60);
    held.progress = next;
  };
  handleFor('ask-bart', async (win, pid, input) => {
    const ctx = await store.context();
    const value = input && typeof input === 'object' ? input : {};
    const askId = str(value.askId, 'ask id', 64);
    if (!/^[\w-]+$/.test(askId)) throw new TypeError('ask id is invalid');
    // Keeping the agent's row is bookkeeping: it never stands between a question and its answer.
    const track = (change) => { try { change(); navChanged(); return true; } catch { return false; } };
    let started = false, mark = null;
    try {
      // `turns`: the earlier turns of the exchange this question continues, read from the document. `choice`: Regenerate's selector.
      const turns = turnsInput(value.turns);
      const choice = value.choice && typeof value.choice === 'object' ? { model: str(value.choice.model, 'model', 24), effort: str(value.choice.effort, 'effort', 24) } : null;
      if (choice && !/^[a-z][a-z0-9]*$/.test(choice.model + choice.effort)) throw new TypeError('choice is invalid');
      // `agent`: which line asked, @bart, @brainstorm or @discover (2026-09-30): the same run with other instructions. An
      // `@orient` line (2026-10-04) is asked as @brainstorm since 2026-10-05 (src/renderer/model/doc.js agentOf). @create
      // (2026-10-13) makes files and keeps them in the library (bart/create.cjs).
      const agent = value.agent == null ? 'bart' : value.agent;
      if (!['bart', 'brainstorm', 'discover', 'create'].includes(agent)) throw new TypeError('agent must be bart, brainstorm, discover or create');
      const ref = docRef(value.ref);
      // A highlight's note asks @bart alone (MATH-27), with the passage it is on.
      if (ref.kind === 'mark' && agent !== 'bart') throw new TypeError('a highlight asks @bart');
      const projectId = str(pid, 'project id', 64);
      // `stage`: the pdf or web page in front in the Stage, which @bart alone is shown (MATH-27); the others' context stays as it was.
      const stage = agent === 'bart' ? stageInput(value.stage) : null;
      // `live`: a web page's tab in this window, asked for its selection and picture as they are now (MATH-54 build 3a).
      const live = stage && stage.kind === 'web' && stage.tab && stagePageFor ? stagePageFor(win, stage.tab) : null;
      // `overleaf`: this window's Overleaf tabs (MATH-65), the one in front read live and every project's copy refreshed.
      const overleaf = agent === 'bart' && overleafFor ? overleafFor(win, stage) : null;
      // `routed`: Bart, the router, handed this line over (2026-10-12, bart/route.cjs): its record's id, whether it read the
      // line as a request to build, and the agent the person picked instead of its pick.
      const routed = routedInput(value.routed);
      // `steer`: a reply sent under a running search (2026-10-16, bart/ask.cjs pausedFor): the search it goes on from, and what
      // was said; or `level`, its level picked while it ran (the line says which).
      const steer = agent === 'discover' && value.steer && typeof value.steer === 'object' ? { after: str(value.steer.after, 'search id', 64), words: str(value.steer.words || '', 'reply', 4000).trim(), level: value.steer.level === true } : null;
      if (steer && (!/^[\w-]+$/.test(steer.after) || !(steer.words || steer.level))) throw new TypeError('steer is invalid');
      const question = { askId, ref, workspaceId: str(value.workspaceId, 'workspace id', 64), text: str(value.text, 'question', 8000), turns, choice, agent, ...(steer ? { steer } : {}), ...(ref.kind === 'mark' ? { highlight: highlightInput(value.highlight) } : {}), ...(stage ? { stage } : {}), ...(live ? { live } : {}), ...(overleaf ? { overleaf } : {}), ...(routed ? { routed } : {}), place: placeOf(value.place, projectId, ref) };
      if (ref.kind === 'mark') {
        // a web page's mark has no page (MATH-54): its answer goes in the ink's "web" list
        mark = { markId: ref.id, page: ref.source === 'web' ? null : ref.page, rowId: ref.rowId || null, url: ref.rowId ? null : ref.url, ...(ref.source === 'web' ? { source: 'web' } : {}) };
        paperAsks.set(askId, { win, projectId, askId, ...mark, question: question.text.trim(), progress: {} });
      }
      // a box (MATH-70 build 2): the picture it has now is the one this answer is about, whatever it has by the time it lands
      let crop = null;
      if (mark && mark.source === 'web') {
        const held = await library.readWebMark(ctx, mark.rowId ? { rowId: mark.rowId } : { url: mark.url }, mark.markId).catch(() => null);
        crop = held && held.box && typeof held.crop === 'string' ? held.crop : null;
      }
      // The ask is an agent of its workspace: running now, waiting for you once its answer (or failure) has landed.
      started = track(() => projects.agentStarted(ctx, { id: askId, kind: agent, projectId: pid, workspaceId: question.workspaceId, doc: question.ref }));
      // Progress goes to the window that asked, which holds the pending line; the answer it places is saved (write-doc).
      const out = await bart.ask(ctx, projectId, question, { onProgress: (progress) => { paperProgress(askId, progress); answer(win, 'engelbart:bart-progress', { askId, ...progress }); } });
      if (started) track(() => projects.agentFinished(ctx, askId));
      if (!mark) return out;
      const entry = askEntry({ id: askId, question: question.text, lines: out.lines, meta: out.meta, at: new Date().toISOString(), crop });
      try { await library.addMarkAnswer(ctx, mark.rowId ? { rowId: mark.rowId } : { url: mark.url }, mark.page, mark.markId, entry); } catch { /* the Stage still has it to show and save */ }
      paperDone({ askId, ...mark, entry });
      return { ...out, entry };
    } catch (error) {
      const stopped = !!(error && error.kind === 'stopped');
      if (started) track(() => (stopped ? projects.agentStopped(ctx, askId) : projects.agentFinished(ctx, askId)));
      const out = stopped ? { stopped: true } : { failed: true, lines: failureLines(error && error.message) };
      if (mark) paperDone({ askId, ...mark, ...out });
      return out;
    }
  });
  // The questions from highlights a window asked in this project that are still running, each as its box shows it
  // ({ askId, markId, page, rowId, url, question, agent, …progress }): a window reloaded meanwhile shows them again.
  handleFor('running-paper-asks', (win, pid) => {
    const projectId = str(pid, 'project id', 64);
    return [...paperAsks.values()].filter((held) => held.projectId === projectId && (!win || held.win === win))
      .map(({ askId, markId, page, rowId, url, source, question, progress }) => ({ ...progress, askId, markId, page, rowId, url, ...(source ? { source } : {}), question, agent: 'bart' }));
  });
  // Bart, the router (2026-10-12, bart/route.cjs): which agent an `@bart` line is for. The editor sends the line, its
  // section, the threads above, whether a spec is above and, for a follow-up, the agent its thread is with (`current`); its own rule's pick (`rule`) is only logged. Nothing here is
  // refused for its length (2026-10-12: a thread asked with a long document under it made every later line fail to route):
  // a thread's question is cut to 400 characters, its agent to 20, the line to 8,000, the workspace's name to 400 and the
  // section to its last 200,000; the router reads less of each still (bart/route.cjs). A value of the wrong type is refused.
  handleFor('route-line', async (win, pid, input) => {
    const value = input && typeof input === 'object' ? input : {};
    const threads = (Array.isArray(value.threads) ? value.threads : []).slice(-5).map((thread) => ({
      agent: cutStr(thread && thread.agent, 'thread agent', 20) || 'chat', question: cutStr(thread && thread.question, 'thread question', 400) || '', up: Math.max(0, Math.min(1e6, Math.floor(Number(thread && thread.up) || 0))),
    }));
    const rule = value.rule && typeof value.rule === 'object' && ROUTE_PICKS.includes(value.rule.agent) ? { agent: value.rule.agent, rule: cutStr(value.rule.rule, 'rule', 40) || null } : null;
    const projectId = str(pid, 'project id', 64);
    const ref = refOrNull(value.ref);
    return bart.route({
      projectId, text: cutStr(str(value.text, 'line', Infinity), 'line', 8000), place: placeOf(value.place, projectId, ref), section: tailStr(value.section, 'section', 200000) || '',
      workspaceName: cutStr(value.workspaceName, 'workspace name', 400) || '', threads, specAbove: !!value.specAbove, specTitle: value.specAbove ? cutStr(value.specTitle, 'spec title', 400) || '' : '', rule,
      current: ['chat', 'brainstorm', 'discover'].includes(value.current) ? value.current : null,
      // MATH-165: Discover waiting on its question (and what it asked), and a line handed back, rerouted without the agents it may not go to.
      asking: !!value.asking, discoverAsked: value.asking ? cutStr(value.discoverAsked, 'discover asked', 2000) || null : null,
      exclude: (Array.isArray(value.exclude) ? value.exclude : []).filter((name) => ROUTE_PICKS.includes(name)),
      handedBack: value.handedBack && typeof value.handedBack === 'object' && ROUTE_PICKS.includes(value.handedBack.from) ? { from: value.handedBack.from, reason: cutStr(value.handedBack.reason, 'hand-back reason', 400) || '' } : null,
    });
  });
  // Where a routed line went when it was not an ask: `build:<id>`, on the router's record.
  handle('route-handed', (id, to) => { if (bart.routeHanded) bart.routeHanded(str(id, 'route id', 80), str(to, 'handed to', 80)); return true; });
  handle('stop-bart', (askId) => bart.stop(str(askId, 'ask id', 64)));
  // A file @create made (2026-10-14, bart/create.cjs): kept with the project until the person saves it. `created-file`
  // reads one for its row, its expanded view and the Stage's Save ({ name, rel, type, ext, path, size, saved, missing } and
  // its text or bytes); `created-save` puts it in the library (its source `create`, the Assets chip), linked to the
  // workspace, once: saved again, it answers the row it was saved as.
  const createdArgs = (pid, askId, rel) => {
    const id = str(askId, 'ask id', 64);
    if (!/^[\w-]+$/.test(id)) throw new TypeError('ask id is invalid');
    return [str(pid, 'project id', 64), id, str(rel, 'file', 1024)];
  };
  handle('created-file', withCtx((ctx, pid, askId, rel) => createdFiles.readCreated(ctx, ...createdArgs(pid, askId, rel), { snapshot: snapshotHtml })));
  saving('created-save', withCtx(async (ctx, pid, askId, rel, workspaceId) => {
    const [projectId, id, file] = createdArgs(pid, askId, rel);
    return createdFiles.saveCreated(ctx, projectId, workspaceId == null ? null : str(workspaceId, 'workspace id', 64), id, file, { inspectPdf });
  }), { project: first, library: true });
  // A new thread's title (2026-10-12, ./bart/name-chat.cjs): asked while its question runs, never in its way. `agent` says
  // which line asked, so the title comes from the provider the question runs on. The fallback (the opening message, at
  // most 60 characters) answers when no model can.
  handle('name-chat', async (input) => {
    const value = input && typeof input === 'object' ? input : {};
    const text = str(value.text, 'question', 8000);
    const agent = value.agent == null ? 'bart' : value.agent;
    if (!['bart', 'brainstorm', 'discover', 'create'].includes(agent)) throw new TypeError('agent must be bart, brainstorm, discover or create');
    const models = readModels('bart');
    const provider = providerOf(text, agent, models);
    if (nameChat) return nameChat({ text, provider });
    const step = namingStep(models, provider);
    return { title: fallbackTitle(text), provider: step.provider, model: step.model, modelName: step.name, effort: step.effort, ms: 0, named: false };
  });
  // What the @bart line's selector offers and what its flags are checked against: the models file,
  // cut down to the providers config.json lists. Names and keys only; the file's prose stays here.
  // A provider's `start` is where a question without flags starts: the last model and effort picked by hand (bart/choices.cjs).
  // `discover`: @discover's { quick, standard, deep } per provider, which its line's level chip lists (2026-10-03).
  handle('bart-models', () => {
    const { provider, providers, discover } = menuModels('bart'), levels = (discover && discover.providers) || {};
    return { provider, providers, discover: { providers: Object.fromEntries(Object.keys(providers).filter((key) => levels[key]).map((key) => [key, levels[key]])) } };
  });
  // The model and effort just picked in a Build panel ('build') or a post-it's Build ('quick'), kept as where the next one
  // starts. @bart's are kept by the question that uses them (bart/ask.cjs onPicked).
  handle('remember-model-choice', (place, choice) => {
    if (place !== 'build' && place !== 'quick') throw new TypeError('place must be build or quick');
    const value = choice && typeof choice === 'object' ? choice : {};
    return rememberModelChoice(place, { provider: str(value.provider, 'provider', 24), model: str(value.model, 'model', 24), effort: str(value.effort, 'effort', 24) });
  });
  // Settings › Intelligence (2026-10-06, MATH-53; bart/settings.cjs): the models file as it is, every provider, with the last
  // picks by hand and which CLIs can run; a save of the defaults it changes, which forgets the picks it overrules; and
  // "Use default", which forgets one. Every window reads its @bart line's models again after either (models-changed).
  if (modelSettings) {
    handle('settings-models', () => modelSettings.read());
    handle('save-settings-models', (patch) => { const out = modelSettings.save(patch); announce('engelbart:models-changed', {}); return out; });
    handle('clear-model-choice', (place) => { const out = modelSettings.forget(str(place, 'place', 24)); announce('engelbart:models-changed', {}); return out; });
  }
  // Copy all under an answer: a question and its answer, as they read in the document.
  handle('copy-text', (text) => { writeClipboard(str(text, 'text', 400000)); return true; });
  // The image of a pasted picture, copied as a picture (2026-10-12): the renderer sends its bytes, main writes the clipboard.
  handle('copy-image', async (bytes) => {
    const buf = Buffer.from(bytes instanceof ArrayBuffer || ArrayBuffer.isView(bytes) ? (ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new Uint8Array(bytes)) : []);
    if (!buf.length || buf.length > 40e6) throw new Error('image is empty or too large');
    return !!(await writeImage(buf));
  });

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
    handle('build-models', (place) => buildChoices(menuModels(place === 'quick' ? 'quick' : 'build')));
    handle('build-targets', withCtx((ctx, pid) => b().targets(ctx, pidOf(pid))));
    // The project's default repo (Make default in the picker): the code directory or a library row, never a path.
    handle('build-set-default', withCtx((ctx, pid, target) => b().setDefault(ctx, pidOf(pid), targetOf(target))));
    handle('build-preflight', withCtx((ctx, pid, target) => b().preflight(ctx, pidOf(pid), targetOf(target))));
    handle('build-init', withCtx((ctx, pid, target) => b().initRepository(ctx, pidOf(pid), targetOf(target))));
    handle('build-clone', withCtx((ctx, pid, target) => b().cloneRepository(ctx, pidOf(pid), targetOf(target))));
    saving('build-start', withCtx((ctx, pid, input) => {
      const value = input && typeof input === 'object' ? input : {};
      return b().start(ctx, pidOf(pid), {
        kind: value.kind === 'quick' ? 'quick' : 'build',
        workspaceId: optStr(value.workspaceId, 'workspace id', 64),
        postItId: optStr(value.postItId, 'post-it id', 64),
        text: optStr(value.text, 'text', 200000),
        fromLine: !!value.fromLine, // `@bart --build <request>` (Workspace.jsx askBart)
        withDocument: !!value.withDocument, // a task built from its own line (MATH-106): the workspace is given beside it
        routedFrom: optStr(value.routedFrom, 'route id', 80), // the router's record, when Bart handed the line to Build (bart/route.cjs)
        place: value.place && typeof value.place === 'object' ? placeOf(value.place, null, refOrNull(value.place.ref)) : null, // the line it came from (the Agent Viewer)
        provider: optStr(value.provider, 'provider', 24),
        model: optStr(value.model, 'model', 24),
        effort: optStr(value.effort, 'effort', 24),
        attach: (Array.isArray(value.attach) ? value.attach : []).slice(0, 50).map((id) => str(id, 'library id', 64)),
        target: targetOf(value.target),
      });
    }), { project: first }); // a post-it's task comes into a workspace as an archived version; what is attached is linked
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
    // What it opens (a Stage tab, a terminal session) opens in the window that asked (src/main/index.cjs, windows.asking()).
    handleFor('build-run-show', async (_win, pid, id, name) => b().showRunnable(await store.context(), pidOf(pid), buildId(id), str(name, 'runnable name', 64)));
    handle('build-run-stop', withCtx((ctx, pid, id) => b().stopRunning(ctx, pidOf(pid), buildId(id))));
    handle('build-run-stop-runnable', withCtx((ctx, pid, id, name) => b().stopRunnable(ctx, pidOf(pid), buildId(id), name === null ? null : str(name, 'runnable name', 64))));
    saving('build-promote', withCtx((ctx, pid, id, wid, choice) => {
      const value = choice && typeof choice === 'object' ? choice : null;
      const picked = value ? { provider: optStr(value.provider, 'provider', 24), model: optStr(value.model, 'model', 24), effort: optStr(value.effort, 'effort', 24) } : null;
      return b().promote(ctx, pidOf(pid), buildId(id), str(wid, 'workspace id', 64), picked);
    }), { project: first });
  }
  // Clear (B21): the document archived and started blank, keeping the lines of Builds still open; what it mentioned stays
  // on the sidebar. Restore (B22) brings an archived version back, the current one archived first.
  const keepOpenBuilds = (ctx, pid) => {
    const open = builds ? builds.openIds(ctx, pid) : new Set();
    return (line) => { const m = BUILD_LINE_RE.exec(line.trim()); return !!m && open.has(m[1]); };
  };
  // Both rewrite the workspace's document, in its turn with the document's saves: announced as a save is, and the window
  // that asked gets the revision with the text.
  const rewrite = (win, pid, wid, change) => {
    const projectId = str(pid, 'project id', 64), workspaceId = str(wid, 'workspace id', 64), key = `ws:${workspaceId}`;
    return inTurn(projectId, key, async () => {
      const ctx = await store.context();
      const before = await projects.readDoc(ctx, projectId, { kind: 'workspace', workspaceId });
      const out = await change(ctx, projectId, workspaceId);
      const revision = out.text !== before ? revised(win, projectId, key, out.text) : revisions.get(`${projectId} ${key}`) || 0;
      announce('engelbart:project-changed', { projectId }, { except: win }); // its archived versions and links
      return { ...out, revision };
    });
  };
  handleFor('clear-workspace', (win, pid, wid) => rewrite(win, pid, wid, (ctx, projectId, workspaceId) => archive.clearWorkspace(ctx, projectId, workspaceId, { keep: keepOpenBuilds(ctx, projectId) })));
  handleFor('restore-archive', (win, pid, wid, file) => rewrite(win, pid, wid, (ctx, projectId, workspaceId) => archive.restoreArchive(ctx, projectId, workspaceId, str(file, 'archive', 64), { keep: keepOpenBuilds(ctx, projectId) })));
  handle('read-archive', withCtx((ctx, pid, wid, file) => { const got = archive.readArchive(ctx, str(pid, 'project id', 64), str(wid, 'workspace id', 64), str(file, 'archive', 64)); return { path: got.path, text: got.text }; }));

  handle('resolve-page-file', withCtx((ctx, pid, input) => projects.resolvePageFile(ctx, str(pid, 'project id', 64), str(input, 'path', 4096))));
  handle('read-text-file', withCtx((ctx, pid, input) => projects.readProjectTextFile(ctx, str(pid, 'project id', 64), str(input, 'path', 4096))));
  // The Stage: what is at a path, and what drawing it needs (a pdf's bytes, a picture's, text, a page's address).
  handle('stage-file', withCtx((ctx, pid, input) => projects.readStageFile(ctx, str(pid, 'project id', 64), str(input, 'path', 4096))));
  handle('library', withCtx((ctx) => library.listLibrary(ctx)));
  // Both directions of "who holds what", derived from the workspaces on disk (no join table).
  handle('projects-for-library-item', withCtx((ctx, id) => library.projectsForLibraryItem(ctx, str(id, 'library id', 64))));
  handle('library-for-project', withCtx((ctx, pid) => library.libraryForProject(ctx, str(pid, 'project id', 64))));
  // What the project's pdfs, notes and workspaces say, for the search and the @ menu to match (MATH-29); asked when one opens.
  // What the other projects hold that a query names or says (MATH-148, store/elsewhere.cjs): only the matches.
  handle('search-elsewhere', withCtx((ctx, pid, query, limit) => elsewhere.searchElsewhere(ctx, str(pid, 'project id', 64), str(query, 'query', 400), Number.isInteger(limit) ? limit : 20)));
  handle('library-bodies', withCtx((ctx, pid) => (pid == null ? library.bodiesForLibrary(ctx) : library.bodiesForProject(ctx, str(pid, 'project id', 64)))));
  // Adding makes a new row or throws "Already in the library as …" (library.addItem). `options.name` names it (the Browser's Save card).
  // A GitHub repository's sandbox starts once the row is saved; a failure to start it leaves the row saved and says why.
  // A page row that may be a pdf (an arXiv paper, a .pdf address, any other page that might answer with one) is checked
  // now, in the background, rather than on the next launch: one that is becomes a saved pdf (store/web-pdfs.cjs).
  const added = async (ctx, row, value) => {
    if (row.type === 'pdf') pdfAdded(); // its text is read for search now (context/sweeper.cjs)
    if (store.recheck && pdfCandidate(row)) store.recheck(ctx);
    // Adding a local clone or a non-GitHub item does not start remote work.
    if (sandbox && Array.isArray(row.tags) && row.tags.includes('git') && /^(?:(?:https?:\/\/)?(?:www\.)?github\.com\/|git@github\.com:)/i.test(value.trim())) {
      try { await sandbox.start(ctx, row.id, { waitForClaude: true }); } catch (error) { return { ...row, sandbox_error: error.message }; }
    }
    return row;
  };
  saving('add-library-item', (input, options) => {
    const value = str(input, 'link or path', 4096);
    const name = optStr(options && typeof options === 'object' ? options.name : null, 'name', 200);
    return queued(async () => {
      const ctx = await store.context();
      return added(ctx, await library.addItem(ctx, value, { describe, identifyRepo, inspectPdf, name }), value);
    });
  }, { library: true });
  // Dragged onto the library or a workspace (MATH-19, 2026-10-05). `add-library-file`: bytes that came without a path (a
  // picture or a pdf from a browser), kept as a copy (library.addFileCopy; `url`, where it came from, when a browser said).
  // `add-library-url`: a link, read here: a picture or a pdf is kept as a copy, anything else is added as add-library-item
  // adds it (library.addFromUrl), a GitHub repository's sandbox starting with it.
  saving('add-library-file', withCtx(async (ctx, bytes, options) => {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('file bytes are missing');
    const value = options && typeof options === 'object' ? options : {};
    const row = await library.addFileCopy(ctx, { bytes, mime: str(value.mime, 'mime', 128), name: optStr(value.name, 'name', MAX_NAME), url: optStr(value.url, 'address', 8192) }, { inspectPdf });
    if (row.type === 'pdf') pdfAdded();
    return row;
  }), { library: true });
  saving('add-library-url', (input) => {
    const value = str(input, 'link', 8192);
    return queued(async () => {
      const ctx = await store.context();
      return added(ctx, await library.addFromUrl(ctx, value, { fetch: fetchUrl, describe, identifyRepo, inspectPdf }), value);
    });
  }, { library: true });
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
    // The Stage's ping while a preview is in front of a focused window: its sandbox sleeps 10 minutes after the last one.
    handle('sandbox-touch', withCtx((ctx, id) => {
      const libraryId = str(id, 'library id', 64);
      if (changingMode) return null;
      return sandbox.touch(ctx, libraryId).then(() => null);
    }));
    // A shell in a ready repository's sandbox, in the terminal pane of the window that asked: that run's, opened again
    // (and woken) if it is already open (sandbox/terminals.cjs). → the session's snapshot
    handleFor('sandbox-terminal', async (_win, id) => {
      if (changingMode) throw new Error('Wait for the data mode change to finish');
      return sandbox.terminal(await store.context(), str(id, 'library id', 64));
    });
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
    handle('sandbox-touch', () => null);
    for (const channel of ['sandbox-start', 'sandbox-stop', 'sandbox-terminal', 'sandbox-environment', 'sandbox-save-environment', 'sandbox-restart']) {
      handle(channel, () => { throw new Error('Sandboxes are turned off in this copy of Engelbart'); });
    }
  }
  // A pdf read from the web, saved as a copy with its address (library.addPdfCopy; the Stage's Save sends its bytes).
  saving('add-library-pdf', withCtx(async (ctx, input, bytes, options) => {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('pdf bytes are missing');
    const row = await library.addPdfCopy(ctx, str(input, 'address', 8192), bytes, { inspectPdf, name: optStr(options && typeof options === 'object' ? options.name : null, 'name', 200) });
    pdfAdded();
    return row;
  }), { library: true });
  // A page from the web, saved as a copy with its address (library.addPageCopy, MATH-17): what the calling window's Stage
  // tab `tabId` shows is written into the folder the library picks. The renderer names a tab, never a path.
  saving('add-library-page', async (win, tabId, input, options) => {
    if (!savePageFor) throw new Error('Pages cannot be saved here');
    const tab = str(tabId, 'tab id', 128);
    const address = str(input, 'address', 8192);
    const name = optStr(options && typeof options === 'object' ? options.name : null, 'name', 200);
    return library.addPageCopy(await store.context(), address, (dir) => savePageFor(win, tab, dir), { name });
  }, { library: true, window: true });
  handle('lookup-library-item', withCtx((ctx, input) => library.lookupItem(ctx, str(input, 'link or path', 4096))));
  // "Choose from disk…": the native picker, files and folders, several at once.
  handle('pick-library-paths', (kind) => pickPaths(kind === 'pdf' ? 'pdf' : 'any'));
  handle('preview-library-item', withCtx((ctx, id) => library.previewItem(ctx, str(id, 'library id', 64), { listRemoteFiles })));
  // The files inside a library folder (MATH-22): a level of it for the @ menu, a mentioned file found again (to open it),
  // and whether the mentioned files on screen are still there. Paths are relative to the folder and never leave it.
  handle('list-folder', withCtx((ctx, id, rel) => folderFiles.listFolder(ctx, str(id, 'library id', 64), rel == null ? '' : str(rel, 'path', 4096))));
  handle('folder-file', withCtx((ctx, id, rel) => folderFiles.folderFile(ctx, str(id, 'library id', 64), str(rel, 'path', 4096))));
  handle('folder-files', withCtx((ctx, list) => folderFiles.folderFiles(ctx, list)));
  saving('rename-library-item', withCtx(async (ctx, id, name) => {
    const row = await ctx.libraryDb.get(str(id, 'library id', 64));
    if (!row) throw new Error('Unknown library item');
    if (row.tags.includes('note') && row.project_id) {
      const note = await projects.renameNote(ctx, row.project_id, row.id, str(name, 'name'));
      return ctx.libraryDb.get(note.id);
    }
    return ctx.libraryDb.rename(row.id, str(name, 'name'));
  }), { project: (_args, out) => out && out.project_id, library: true });
  handle('read-library-file', withCtx((ctx, id) => library.readLibraryFile(ctx, str(id, 'library id', 64))));
  handle('read-annotations', withCtx((ctx, id) => library.readAnnotations(ctx, str(id, 'library id', 64))));
  handle('write-annotations', withCtx((ctx, id, value) => library.writeAnnotations(ctx, str(id, 'library id', 64), value)));
  // Ink on a pdf in the Browser pane, by its address (a link, or a file: address inside the home directory).
  handle('read-page-annotations', withCtx((ctx, input) => library.readPageAnnotations(ctx, str(input, 'address', 8192))));
  handle('write-page-annotations', withCtx((ctx, input, value) => library.writePageAnnotations(ctx, str(input, 'address', 8192), value)));

  // Git, Claude Code and Codex (src/main/tools/manager.cjs): the setup dialog's snapshot and its buttons. Installs,
  // updates and sign-ins answer at once and report through `engelbart:tools` as they go. Sign-out (Connections) answers
  // once the CLI has logged out and been checked again: { ok, error }.
  if (tools) {
    const toolName = (value) => { if (!TOOL_NAMES.includes(value)) throw new TypeError('Unknown tool'); return value; };
    const toolNames = (value) => (Array.isArray(value) ? value : [value]).slice(0, 3).map(toolName);
    handle('tools', () => tools.snapshot());
    handle('tools-check', () => tools.check());
    handle('tools-install', (names) => { void tools.install(toolNames(names)).catch(() => {}); return tools.snapshot(); });
    handle('tools-update', (name) => { void tools.update(toolName(name)).catch(() => {}); return tools.snapshot(); });
    handle('tools-sign-in', (name) => { void tools.signIn(toolName(name)).catch(() => {}); return tools.snapshot(); });
    // Connect (2026-10-14): installed, updated, checked and signed in, whichever it still needs, from one press.
    handle('tools-connect', (name) => { void tools.connect(toolName(name)).catch(() => {}); return tools.snapshot(); });
    handle('tools-cancel-sign-in', (name) => tools.cancelSignIn(toolName(name)));
    handle('tools-sign-out', (name) => tools.signOut(toolName(name)));
    handle('tools-skip', (names) => tools.skip(toolNames(names)));
    handle('tools-ask-again', (name) => tools.askAgain(toolName(name)));
    handle('tools-set-updates', (value) => tools.setUpdates(value === 'ask' ? 'ask' : 'auto'));
  }

  // New versions (src/main/updates.cjs): what a window's banner shows, and its two buttons. Changes arrive on
  // `engelbart:update` as whole snapshots. A checkout, or a build without a download folder, has none.
  handle('update-state', () => { const updates = getUpdates(); return updates ? updates.snapshot() : { enabled: false }; });
  handle('update-restart', () => { const updates = getUpdates(); return updates ? updates.restart() : false; });
  handle('update-later', () => { const updates = getUpdates(); return updates ? updates.later() : { enabled: false }; });

  handle('shell-history', () => readShellHistory({ homeDir: require('node:os').homedir() }));
  handle('open-external', (url) => openExternal(url));
  handle('reveal', async (target) => {
    const value = path.resolve(str(target, 'path', 4096));
    if (!value.startsWith(store.layout.root + path.sep) && value !== store.layout.root) throw new Error('Only paths inside ~/.engelbart can be revealed');
    return revealItem(value);
  });
}

module.exports = { createStore, registerEngelbartIpc, docRef, docKeyOf, highlightInput, stageInput, turnsInput };
