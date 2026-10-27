'use strict';

const path = require('node:path');
const fs = require('node:fs');
const {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  net,
  powerMonitor,
  protocol,
  safeStorage,
  session: electronSession,
  shell: electronShell,
  utilityProcess,
  WebContentsView,
} = require('electron');
const { createScanner, accessSpec } = require('./connect/offthread.cjs');
const { SessionManager } = require('./terminal/session-manager.cjs');
const { environmentForSessions } = require('./shell-rc.cjs');
const { createSweeper } = require('./context/sweeper.cjs');
const { inspectPdf, pdfTitle } = require('./context/pdf-kind.cjs');
const { createCliSummarizer, createFakeSummarizer } = require('./context/summarizer.cjs');
const { createBart, createFakeBart, createThreads, BRAINSTORM_IDLE_MS, DISCOVER_IDLE_MS } = require('./bart/ask.cjs');
const { createSnapshotter } = require('./bart/created-preview.cjs');
const { createNameChat, createFakeNameChat } = require('./bart/name-chat.cjs');
const { rememberChoice } = require('./bart/choices.cjs');
const { modelsInForce, createModelSettings } = require('./bart/settings.cjs');
const { personalCodexHome, listedIn, runningCodexVersion, newestCodex, codexMenu } = require('./tools/codex-models.cjs');
const { resolveShell } = require('./terminal/launch.cjs');
const { createStageBridges } = require('./terminal/stage-bridges.cjs');
const { stageToolFor } = require('./terminal/stage-tools.cjs');
const home = require('./store/home.cjs');
const library = require('./store/library.cjs');
const { createRunner } = require('./tools/run.cjs');
const { detectTools } = require('./tools/detect.cjs');
const { findBundledGit } = require('./tools/bundled-git.cjs');
const { createActions } = require('./tools/install.cjs');
const { createTools } = require('./tools/manager.cjs');
const { createFakeTools } = require('./tools/fake.cjs');
const { createSignInProcess, createSignOutProcess } = require('./tools/sign-in.cjs');
const { SettingsStore } = require('./terminal/settings.cjs');
const { shouldHideWindowOnClose } = require('./terminal/window-lifecycle.cjs');
const { assertTrustedRenderer, parseExternalUrl } = require('./ipc-validation.cjs');
const { createStore, registerEngelbartIpc } = require('./ipc.cjs');
const { stagePartition, createBrowserViews, registerBrowserIpc, cleanUserAgent } = require('./browser/views.cjs');
const { execFile } = require('node:child_process');
const { createCookieImport, keychainRunner, bundleOf } = require('./browser/import-cookies.cjs');
const { createInstalledApps } = require('./browser/installed-apps.cjs');
const { createGithub } = require('./github/connection.cjs');
const { macOrgs } = require('./github/orgs.cjs');
const { localRepos } = require('./connect/scan.cjs');
const folderAccess = require('./connect/folder-access.cjs');
const { createBrowserAuth, CLIENT_ID: GITHUB_CLIENT_ID } = require('./github/browser-auth.cjs');
const { createE2bKey } = require('./github/e2b-key.cjs');
const { createRepoAccess } = require('./github/repo-access.cjs');
const { createZotero } = require('./zotero/connection.cjs');
const { createBrowserAuth: createZoteroBrowserAuth } = require('./zotero/browser-auth.cjs');
const { createZoteroSync, scheduleSyncs: scheduleZoteroSyncs } = require('./zotero/sync.cjs');
const { mirrorDir: zoteroMirrorDir } = require('./zotero/mirror.cjs');
const { createOverleafCopies } = require('./overleaf/copy.cjs');
const { createOverleafStage } = require('./overleaf/stage.cjs');
const { createSandboxManager } = require('./sandbox/manager.cjs');
const { createSandboxPty } = require('./sandbox/pty.cjs');
const { createSandboxTerminals } = require('./sandbox/terminals.cjs');
const { prepareLocalClaude } = require('./sandbox/local-claude.cjs');
const { createRepoIdentifier, createRemoteFileLister, createDescriber } = require('./store/page-meta.cjs');
const { createConnect } = require('./connect/session.cjs');
const { createConnectAgents } = require('./connect/agents.cjs');
const { createFakeConnectAgents, createCliGatedAgents } = require('./connect/fake.cjs');
const { createAgentBrowser } = require('./connect/browser.cjs');
const { createConnectors } = require('./connect/connectors.cjs');
const { createOwnConnectors } = require('./connect/own-connectors.cjs');
const { createWebSignIn, SIGN_IN_COOKIES, profileOpenArgs } = require('./connect/web-signin.cjs');
const { createAppleNotes } = require('./connect/apple-notes.cjs');
const { createSignInWindow } = require('./connect/signin-window.cjs');
const { createSigninProfiles } = require('./connect/signin-profiles.cjs');
const { APPS: CONNECT_APPS } = require('../shared/connect-sources.cjs');
const { openToolBridge } = require('./sandbox/local-tools.cjs');
const { checkWebPdfs, readPdfResponse } = require('./store/web-pdfs.cjs');
const { createPostItViews, createPostItPeers, registerPostItIpc } = require('./post-its/views.cjs');
const { createGit } = require('./build/git.cjs');
const { createBuilds } = require('./build/manager.cjs');
const { createRunStep, createFakeRunAgent } = require('./build/run-step.cjs');
const { createProcesses: createRunProcesses } = require('./build/run-processes.cjs');
const { createRunner: createBuildRunner, createFakeRunner: createFakeBuildRunner } = require('./build/runner.cjs');
const { EDGES: WINDOW_EDGES, resizedBounds } = require('./window-edges.cjs');
const { windowOpenRoute } = require('./window-open.cjs');
const { hasTestMode } = require('./developer.cjs');
const { createRunLog } = require('./bart/runlog.cjs');
const { createAgentMapWindow } = require('./agent-map/window.cjs');
const { registerAgentMapIpc } = require('./agent-map/ipc.cjs');
const { agentDesign } = require('./agent-map/design.cjs');
const { createChatBenchmark, askChat } = require('./agent-map/benchmark.cjs');
const { createUpdates } = require('./updates.cjs');
const projects = require('./store/projects.cjs');
const { createWindows, placement } = require('./windows.cjs');
// Import your context (2026-10-13, the "Onboarding" workspace): its provider rule, browsers, discovery agents, whether the
// folders macOS guards may already be read, and the Agent trace.
const onboardingPrefs = require('./onboarding/prefs.cjs');
const { createProviders } = require('./onboarding/providers.cjs');
const { createBrowsers } = require('./onboarding/browsers.cjs');
const { createTrace } = require('./onboarding/trace.cjs');
const { createTraceWindow } = require('./onboarding/trace-window.cjs');
const { createDiscovery } = require('./onboarding/discover.cjs');
const { createDiskAccess } = require('./onboarding/disk-access.cjs');
const { createBrowserAgents } = require('./onboarding/browser-agents.cjs');
const { createAgentTerminal } = require('./terminal/agent-terminal.cjs');
const { browserById: importBrowserById } = require('../shared/import-flow.cjs');

const DIST = path.join(__dirname, '../../dist');
const FIXTURES = path.join(__dirname, '../../fixtures');
const PRELOAD_FILE = path.join(__dirname, '../preload.cjs');
const APP_URL = 'engelbart://app/index.html';
// The Stage's cookie store: a checkout keeps its own, apart from the package's encrypted one (browser/views.cjs).
const BROWSER_PARTITION = stagePartition(app.isPackaged);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
};

let windows = null; // every window's context (./windows.cjs): its Stage tabs, post-its, terminal attachment, place
let manager = null;
let stageBridges = null; // each Claude Code or Codex session's Stage tool (./terminal/stage-bridges.cjs, MATH-79)
let settings = null;
let scanner = null;
// A relaunch asked for while a quit was already under way (macOS's Quit & Reopen racing Engelbart's own): kept, not dropped.
let relaunchWanted = false;
let store = null;
let sweeper = null;
let zoteroLibrary = null; // the Zotero library's mirror (src/main/zotero/sync.cjs), made with the Zotero sign-in
let bart = null;
let nameChat = null;
let agentMap = null; // the Agent Viewer (./agent-map/window.cjs): developers only, one per app
let runLog = null; // what it shows (./bart/runlog.cjs): kept only in a copy with test mode
let builds = null;
let sandbox = null;
let tools = null;
let updates = null;
let traceWindow = null; // View ▸ Agent Trace (./onboarding/trace-window.cjs)
let connect = null; // Connect your library's sessions (./connect/session.cjs): stopped, their agents' windows closed, at quit
let quitPending = false;
let quitReady = false;

protocol.registerSchemesAsPrivileged([
  { scheme: 'engelbart', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false, stream: true } },
]);

function trustedHandler(handler) {
  return async (event, ...args) => {
    assertTrustedRenderer(event, APP_URL);
    return handler(...args);
  };
}

// The same check, then the context of the window that called: handler(ctx, ...args) (./windows.cjs).
function windowHandler(handler) {
  return windows.handler(handler);
}

// To every window, each once its terminal has attached (RendererLifecycle), as the one window's events always waited.
function sendToRenderer(channel, payload) {
  return windows ? windows.broadcast(channel, payload, { gated: true }) : false;
}

// sendToRenderer waits for the terminal to attach (RendererLifecycle), which never happens on the create and
// all-projects screens; the setup dialog can open on any screen, so its events go to the windows directly.
function sendToWindow(channel, payload) {
  return windows ? windows.broadcast(channel, payload) : false;
}

/** The focused window, else the one focused last: where a dialog, the menu's commands and the updater go. */
function focusedWindow() {
  return windows ? windows.focused() : null;
}

/** A dialog's window: the one whose request opened it, else the focused one. */
function dialogWindow() {
  const ctx = (windows && windows.asking()) || focusedWindow();
  return ctx && !ctx.win.isDestroyed() ? ctx.win : null;
}

function registerProtocol() {
  protocol.handle('engelbart', async (request) => {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    if (url.host !== 'app') return new Response('Not found', { status: 404 });
    let relative = decodeURIComponent(url.pathname);
    if (relative === '/' || relative === '') relative = '/index.html';
    const file = path.normalize(path.join(DIST, relative));
    if (!file.startsWith(DIST + path.sep)) return new Response('Forbidden', { status: 403 });
    try {
      const body = await fs.promises.readFile(file);
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      return new Response(body, { status: 200, headers: { 'content-type': type, 'cache-control': 'no-cache' } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

async function closeSession(id) {
  const current = manager.get(id);
  if (!current) return false;
  const closed = await manager.close(id);
  if (closed) windows.forget(id);
  if (closed && stageBridges) await stageBridges.close(id);
  return closed;
}

/** Terminal sessions still running: quitting ends them. */
function runningSessionCount() {
  return manager ? manager.list().filter((entry) => entry.status === 'running').length : 0;
}

// `update`: Restart to Update from the ready dialog (updates.cjs), which has said already that terminal sessions end; it
// quits without asking again (from the menu or a banner it asks, as any quit does). True once it goes on to quit; false
// when it does not: a quit already under way, Cancel, or a shutdown that failed.
// `relaunch`: Engelbart opens again once it has quit; only when the quit goes on.
async function requestQuit({ update = false, relaunch = false } = {}) {
  if (quitPending || quitReady) { if (relaunch) relaunchWanted = true; return false; }
  quitPending = true;
  const runningCount = update ? 0 : runningSessionCount();
  if (runningCount > 0) {
    const options = {
      type: 'warning',
      buttons: ['Quit and End Sessions', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Quit Engelbart?',
      message: `Quit and end ${runningCount} running terminal session${runningCount === 1 ? '' : 's'}?`,
      detail: 'Terminal sessions live in this app process and cannot be recovered after quitting. Documents are already saved.',
      noLink: true,
    };
    const dialogParent = dialogWindow();
    if (dialogParent && !dialogParent.isVisible()) {
      dialogParent.show();
      dialogParent.focus();
    }
    const result = dialogParent
      ? await dialog.showMessageBox(dialogParent, options)
      : await dialog.showMessageBox(options);
    if (result.response !== 0) {
      quitPending = false;
      return false;
    }
  }
  saveWindows(true); // every window, as it is now, before any closes
  try {
    if (sweeper) await sweeper.stop();
    if (bart) bart.stopAll();
    if (connect) connect.suspendAll(); // saved to go on at the next launch (resume); its agents and their hidden windows go
    if (builds) await builds.stopAll(); // each running turn stops, saves a checkpoint and is marked interrupted
    // No E2B preview is left running (and paid for) after quitting: a ready one goes to sleep, to wake when it is next
    // opened, and one still being set up stops. One that cannot be reached (offline, signed out) does not hold the quit:
    // a ready one sleeps 10 minutes after its last use, one being set up at its one-hour timeout.
    if (sandbox) await sandbox.dispose().catch((error) => console.warn(`[engelbart] sandbox shutdown: ${error.message}`));
    for (const ctx of windows ? windows.all() : []) {
      await ctx.browserViews.flush().catch(() => {});
      await ctx.postItViews.activate(null);
    }
    if (tools) await tools.stopSignIns(); // a Claude Code or Codex sign-in still in the browser (Connect): its own terminal
    if (manager) await manager.shutdown();
    if (stageBridges) await stageBridges.closeAll();
    if (store) await store.close();
  } catch (error) {
    quitPending = false;
    dialog.showErrorBox('Unable to shut down cleanly', error.message);
    return false;
  }
  quitReady = true;
  if (relaunch || relaunchWanted) app.relaunch();
  app.quit();
  return true;
}

// What a Build's run step opens (build/manager.cjs showRunnable, asked from a card in a window): a UI's Stage tab in that
// window; a terminal program's session there too, its output following it (a window that showed it before lets it go).
function routeRun(payload) {
  if (!payload || (payload.kind !== 'ui' && payload.kind !== 'terminal')) { sendToRenderer('engelbart:build-run', payload); return; }
  const target = windows.asking() || windows.showing(payload.projectId) || focusedWindow();
  if (!target) return;
  if (payload.kind === 'terminal' && payload.session) {
    const left = windows.own(payload.session.id, target);
    if (left) windows.deliver(left, 'engelbart:build-run', { kind: 'closed', sessionId: payload.session.id });
  }
  windows.deliver(target, 'engelbart:build-run', payload);
}

function registerTerminalIpc() {
  // A window's terminal pane attaches: every session is listed, and those no open window holds (their window closed)
  // come to this one (./windows.cjs). A session's output goes to the window that holds it alone.
  ipcMain.handle('terminal:bootstrap', windowHandler(async (ctx) => {
    const sessions = windows.bootstrap(ctx);
    return {
      home: app.getPath('home'),
      shell: resolveShell(process.env),
      platform: process.platform,
      version: app.getVersion(),
      settings: settings.get(),
      sessions,
    };
  }));
  ipcMain.handle('terminal:providers', trustedHandler(() => tools.providers(resolveShell(process.env))));
  // A session belongs to the window it was opened from. Claude Code, Codex and shell sessions (for the
  // claude or codex typed in them) get the Stage tool (open_on_stage, MATH-79): its bridge opens first and is bound to the session once it has started; one that does not open starts
  // the agent without it, and one whose session does not start is closed again.
  ipcMain.handle('terminal:create', windowHandler(async (ctx, request) => {
    const provider = request && request.provider;
    const stage = stageBridges ? await stageBridges.prepare(provider) : null;
    let session;
    try {
      session = manager.create({
        provider,
        cwd: request && request.cwd,
        cols: request && request.cols,
        rows: request && request.rows,
      }, { stage: stage ? stage.stage : null });
    } catch (error) {
      if (stage) await stage.discard();
      throw error;
    }
    if (stage) stage.bind(session);
    windows.own(session.id, ctx);
    return session;
  }));
  ipcMain.handle('terminal:write', trustedHandler((id, data) => {
    manager.write(id, data);
    return true;
  }));
  ipcMain.handle('terminal:resize', trustedHandler((id, cols, rows) => {
    manager.resize(id, cols, rows);
    return true;
  }));
  ipcMain.handle('terminal:close', trustedHandler((id) => closeSession(id)));
  // The renderer's resize strips: a press names the edge, every move after it re-reads the cursor (2026-09-23). Each
  // window moves itself.
  ipcMain.on('window:edge-resize', (event, phase, edge) => {
    try {
      assertTrustedRenderer(event, APP_URL);
      const ctx = windows.of(event.sender);
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!ctx || !win || win.isFullScreen()) return;
      const cursor = require('electron').screen.getCursorScreenPoint();
      if (phase === 'start' && WINDOW_EDGES.has(edge)) ctx.edgeResize = { edge, start: win.getBounds(), from: cursor };
      else if (phase === 'move' && ctx.edgeResize) {
        const [width, height] = win.getMinimumSize();
        win.setBounds(resizedBounds(ctx.edgeResize.start, ctx.edgeResize.edge, cursor.x - ctx.edgeResize.from.x, cursor.y - ctx.edgeResize.from.y, { width, height }));
      } else if (phase === 'end') ctx.edgeResize = null;
    } catch {
      // A send-only gesture is deliberately ignored when malformed.
    }
  });
  // A Stage starts (true) or stops (false) taking its window's new-window links; the window's open handler asks.
  ipcMain.on('stage:links', (event, on) => {
    try {
      assertTrustedRenderer(event, APP_URL);
      const ctx = windows.of(event.sender);
      if (ctx) ctx.stageListeners = Math.max(0, ctx.stageListeners + (on ? 1 : -1));
    } catch {
      // Only the app's own page says whether it has a Stage.
    }
  });
  // Only the window a session's output goes to acknowledges it (another may list the session, never receive it).
  ipcMain.on('terminal:acknowledge', (event, id, sequence) => {
    try {
      assertTrustedRenderer(event, APP_URL);
      const ctx = windows.of(event.sender);
      if (!ctx || windows.ownerOf(id) !== ctx) return;
      manager.acknowledge(id, sequence);
    } catch {
      // A send-only acknowledgement is deliberately ignored when malformed.
    }
  });
  ipcMain.handle('terminal:pick-directory', windowHandler(async (ctx, current) => {
    // Start in the home directory, never in Engelbart's own data folder (where the last terminal may have been).
    let defaultPath = app.getPath('home');
    if (typeof current === 'string' && current.length <= 4096) {
      try {
        if (fs.statSync(current).isDirectory()) defaultPath = current;
      } catch {
        // Fall back to the persisted valid directory.
      }
    }
    if (process.env.ENGELBART_PICK_DIRECTORY) return process.env.ENGELBART_PICK_DIRECTORY; // driver harness only (scripts/smoke-import-context.cjs)
    const result = await dialog.showOpenDialog(ctx.win, {
      title: 'Choose working directory',
      defaultPath,
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0] || null;
  }));
  ipcMain.handle('terminal:save-settings', trustedHandler((patch) => settings.save(patch)));
  ipcMain.handle('terminal:open-external', trustedHandler(async (value) => {
    const url = parseExternalUrl(value);
    await electronShell.openExternal(url.href);
    return true;
  }));
}

// What a window shows (2026-10-03): it says where it has gone (`window:navigated`, kept for the next launch), and asks
// where to open (`window:target`: its place, the projects screen, or null for the place the app was last in).
function registerWindowIpc() {
  ipcMain.on('window:navigated', (event, place) => {
    try {
      assertTrustedRenderer(event, APP_URL);
      const ctx = windows.of(event.sender);
      if (ctx) windows.navigated(ctx, place);
    } catch {
      // Only the app's own page says where it is.
    }
  });
  ipcMain.handle('window:target', windowHandler((ctx) => windows.target(ctx)));
}

// The menu's commands act on the focused window (focusedWindow).
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const setUpTools = () => { const ctx = focusedWindow(); if (ctx) windows.send(ctx, 'engelbart:tools-open', {}); };
  const find = (name) => () => { const ctx = focusedWindow(); if (ctx) ctx.browserViews.shortcut(name); };
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        ...(updates && updates.enabled ? [updates.menuItem()] : []),
        { type: 'separator' },
        { label: 'Set Up Tools…', click: setUpTools },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { label: `Quit ${app.name}`, accelerator: 'Cmd+Q', click: () => requestQuit() },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        // On the workspace the focused window shows, else on the projects screen.
        { label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N', click: () => newWindow(focusedWindow()) },
        { type: 'separator' },
        { label: 'Reveal Engelbart Folder', click: () => electronShell.showItemInFolder(store ? store.layout.root : app.getPath('home')) },
        ...(isMac ? [] : [{ label: 'Set Up Tools…', click: setUpTools }]),
        { type: 'separator' },
        ...(isMac ? [{ role: 'close', label: 'Close Window', accelerator: 'Cmd+Shift+W' }] : [{ label: 'Quit', accelerator: 'Ctrl+Q', click: () => requestQuit() }]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
        { type: 'separator' },
        // The Browser pane's find (src/main/browser/views.cjs). A menu item, not a key the pane
        // takes first, so a page with its own find (Google Docs) keeps it.
        {
          label: 'Find',
          submenu: [
            { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: find('find') },
            { label: 'Find Next', accelerator: 'CmdOrCtrl+G', click: find('find-next') },
            { label: 'Find Previous', accelerator: 'Shift+CmdOrCtrl+G', click: find('find-previous') },
          ],
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        // Every prompt, input, output and context of onboarding's agents, and the dispatching around them (2026-10-13).
        { label: 'Agent Trace', accelerator: 'CmdOrCtrl+Alt+T', click: () => { if (traceWindow) traceWindow.open(); } },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    ...(isMac ? [{ role: 'windowMenu' }] : []),
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  // The Dock icon's menu: a new window on the projects screen.
  if (isMac && app.dock) app.dock.setMenu(Menu.buildFromTemplate([{ label: 'New Window', click: () => newWindow(null) }]));
}

// The windows' places, sizes and positions go into state.json (store/projects.cjs writeWindows) a moment after any
// changes, and once more when quitting, before any window closes.
let windowsTimer = null;
function saveWindows(now = false) {
  clearTimeout(windowsTimer);
  windowsTimer = null;
  if (!now && (quitPending || quitReady)) return;
  if (!windows || !store || windows.count() === 0) return; // the last window closing (not on macOS) leaves them as they were
  if (now) writeWindows();
  else windowsTimer = setTimeout(writeWindows, 800);
}
function writeWindows() {
  windowsTimer = null;
  try {
    projects.writeWindows({ dataRoot: store.config().dataRoot }, windows.places());
  } catch (error) {
    console.warn(`[engelbart] windows not saved: ${error.message}`);
  }
}

/** A new window on the workspace `from` shows, else on the projects screen. */
function newWindow(from) {
  const place = from && from.place && from.place.projectId ? from.place : { projectId: null };
  return openWindow({ place, from });
}

/** The focused window, shown (the Dock icon, a second launch); a window when there is none. */
function showWindow() {
  if (!windows) return; // before the app is ready, its first windows are still to come
  const ctx = focusedWindow();
  if (!ctx || ctx.win.isDestroyed()) { openWindow(); return; }
  if (ctx.win.isMinimized()) ctx.win.restore();
  ctx.win.show();
  ctx.win.focus();
}

/**
 * A window (2026-10-03: there may be several). `place` is where it opens ({ projectId, workspaceId }, projectId null for
 * the projects screen; none: where the app was last); `bounds` a saved window's; `from` the window it is opened from.
 */
function openWindow({ place = null, bounds = null, from = null } = {}) {
  // The last window closed on macOS is only hidden, for the Dock icon to bring back; once another opens, it goes.
  for (const held of windows.all()) if (held.closedHidden && !held.win.isDestroyed()) held.win.destroy();
  const workAreas = require('electron').screen.getAllDisplays().map((display) => display.workArea);
  const fromBounds = from && !from.win.isDestroyed() ? from.win.getBounds() : null;
  const win = new BrowserWindow({
    show: process.env.ENGELBART_HEADLESS !== '1', // isolated automated checks; never take desktop focus
    ...placement({ bounds, from: fromBounds, workAreas, min: { width: 900, height: 560 }, size: { width: 1440, height: 900 } }),
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#ffffff',
    title: 'Engelbart',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // Centred on the 54px header; the header leaves them room until the window goes full screen (2026-09-23).
    trafficLightPosition: { x: 18, y: 20 },
    webPreferences: {
      preload: PRELOAD_FILE,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  const ctx = windows.add(win, place);
  // What the page would open in a new window or tab (a ⌘-click on a link): a new Stage tab while one of this window's
  // Stages listens, else the default browser; GitHub's sign-in pages always the default browser; untrusted schemes remain
  // closed (window-open.cjs).
  win.webContents.setWindowOpenHandler(({ url }) => {
    const route = windowOpenRoute(url, { stage: ctx.stageListeners > 0 });
    const sent = !!route && route.to === 'stage' && windows.send(ctx, 'stage:open-link', { url: route.url, newTab: true });
    if (route && !sent) void electronShell.openExternal(route.url).catch(() => {});
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault();
  });
  // The renderer's browser tabs live in its memory: when the page goes, their views go with it. Only this window's.
  win.webContents.on('did-start-loading', () => windows.reset(ctx));
  win.webContents.on('render-process-gone', () => windows.crashed(ctx));
  win.on('resize', () => { ctx.postItViews.layout(); saveWindows(); });
  win.on('move', () => saveWindows());
  // The header clears the traffic lights only while they are there (preload marks <html data-fullscreen>).
  const sendFullScreen = () => windows.send(ctx, 'window:fullscreen', win.isFullScreen());
  win.on('enter-full-screen', sendFullScreen);
  win.on('leave-full-screen', sendFullScreen);
  win.webContents.on('did-finish-load', sendFullScreen);
  win.on('blur', () => ctx.postItViews.cancelGesture());
  // Whether the window has the keyboard, for the Stage's preview ping (preload.cjs's windowFocused).
  const sendFocus = () => windows.send(ctx, 'window:focus', !win.isDestroyed() && win.isFocused());
  win.on('focus', () => { windows.touch(ctx); sendFocus(); });
  win.on('blur', sendFocus);
  win.webContents.on('did-finish-load', sendFocus);
  // On macOS the last window hides rather than closes (its terminal stays attached, its tabs stay open) until Quit; any
  // other window closes.
  win.on('close', (event) => {
    if (shouldHideWindowOnClose(process.platform, quitReady) && windows.count() === 1) {
      event.preventDefault();
      ctx.closedHidden = true;
      win.hide();
    }
  });
  win.on('show', () => { ctx.closedHidden = false; });
  win.on('closed', () => {
    windows.remove(ctx);
    // The Agent map is no workspace window: it goes with the last of them, so the app can quit (window-all-closed).
    if (!windows.count() && agentMap) agentMap.close();
  });
  win.loadURL(APP_URL);
  return ctx;
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('before-quit', (event) => {
    if (quitReady) return;
    event.preventDefault();
    requestQuit();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') requestQuit();
  });
  app.on('activate', showWindow);
  app.whenReady().then(() => {
    registerProtocol();
    // Flow control follows each session's window: on while that window's terminal is attached (./windows.cjs).
    // Its sandbox sessions are shells in repositories' E2B sandboxes (sandbox/pty.cjs, opened by sandbox/terminals.cjs).
    manager = new SessionManager({ environment: environmentForSessions(process.env, app.getPath('userData')), extraEnvironment: () => (tools ? tools.environment() : {}), attached: (id) => (windows ? windows.attached(id) : false), sandboxPty: createSandboxPty() });
    settings = new SettingsStore(app.getPath('userData'), app.getPath('home'));
    const homeDir = process.env.ENGELBART_HOME_DIR || app.getPath('home');
    // What is read from this Mac before anything is picked (the apps here, the repositories, onboarding's digest) runs in
    // a utility process: on this process it froze every window for seconds (./connect/scan-child.cjs).
    // ENGELBART_SCANNER=inline runs the scans here, as before (scripts/probe-onboarding-lag.cjs compares the two).
    scanner = createScanner({ fork: process.env.ENGELBART_SCANNER === 'inline' ? null : () => utilityProcess.fork(path.join(__dirname, 'connect', 'scan-child.cjs'), [], { serviceName: 'Engelbart Scanner', stdio: 'ignore' }) });
    app.on('will-quit', () => scanner.stop());
    // Pdfs saved as links before the Stage kept copies: every library that opens is checked, and what is left is
    // downloaded in the background with the Stage's cookies (a paper behind a sign-in comes too). A page row added while
    // the app is open is checked straight away (`again`: store.recheck). ENGELBART_WEB_PDFS=off disables it (scripted runs).
    let changedTimer = null;
    const libraryChanged = () => { clearTimeout(changedTimer); changedTimer = setTimeout(() => sendToWindow('engelbart:library-changed', {}), 400); };
    // A pdf just came into the library (added from disk, saved from the web, or a page row that became one): its text
    // is read for search within seconds (the sweeper's text pass), not at the next beat.
    const pdfAdded = () => { if (sweeper) sweeper.sweepSoon(); };
    const fetchPdf = async (url) => readPdfResponse(await electronSession.fromPartition(BROWSER_PARTITION).fetch(url, { signal: AbortSignal.timeout(120000) }));
    const afterOpen = process.env.ENGELBART_WEB_PDFS === 'off' ? null
      : (ctx, { again = false } = {}) => checkWebPdfs(ctx, { fetchPdf, inspectPdf, onChange: () => { libraryChanged(); pdfAdded(); }, log: (line) => console.warn(`[engelbart] ${line}`), again });
    // Test mode only in a developer's copy: run from a checkout, or packaged by `npm run relaunch` (./developer.cjs).
    const developer = hasTestMode({ packaged: app.isPackaged, distDir: DIST, env: process.env });
    store = createStore({ homeDir, rootDir: process.env.ENGELBART_ROOT_DIR || null, fixturesDir: FIXTURES, inspectPdf, pdfTitle, afterOpen, testMode: developer, zotero: () => zoteroLibrary });
    // Git, Claude Code and Codex (src/main/tools): checked at every launch in the background and recorded in
    // config.json → tools; installed, updated and signed in to from the setup dialog. The Git that comes with
    // Engelbart stands in when the Mac has none of its own (tools/bundled-git.cjs), and on a Mac with neither agent
    // Claude Code is installed at launch without asking. ENGELBART_TOOLS_FAKE (JSON) pretends a machine,
    // ENGELBART_TOOLS=off skips the launch check and ENGELBART_GIT=bundled uses Engelbart's Git even where there is
    // another, for scripted runs only.
    // A pretend machine keeps its records in memory: config.json keeps what the real machine has (and the choices made
    // on it), so `npm run relaunch -- --new-mac` never leaves a fake path or a "skip" behind.
    const toolsFake = process.env.ENGELBART_TOOLS_FAKE ? createFakeTools(process.env.ENGELBART_TOOLS_FAKE) : null;
    const toolRunner = createRunner({ environment: process.env });
    const bundledGit = findBundledGit({ appRoot: app.getAppPath() });
    let pretendTools = {};
    tools = createTools({
      readTools: () => (toolsFake ? pretendTools : home.readConfig(store.layout.root).tools),
      writeTools: (value) => { if (toolsFake) { pretendTools = value; return null; } return home.writeTools(store.layout.root, value); },
      detect: toolsFake ? toolsFake.detect : (only) => detectTools({ runner: toolRunner, only, bundledGit, preferBundledGit: process.env.ENGELBART_GIT === 'bundled' }),
      actions: toolsFake ? toolsFake.actions : createActions({ runner: toolRunner }),
      signInProcess: toolsFake ? toolsFake.signInProcess : createSignInProcess({ pty: require('node-pty'), shell: toolRunner.shellPath }),
      signOutProcess: toolsFake ? toolsFake.signOutProcess : createSignOutProcess({ runner: toolRunner }),
      installAtLaunch: ['claude'],
      onChange: (snapshot) => sendToWindow('engelbart:tools', snapshot),
    });
    if (process.env.ENGELBART_TOOLS !== 'off') void tools.start().catch((error) => console.warn(`[engelbart] tool check: ${error.message}`));
    // Catalog summaries (src/main/context): swept once a minute while the app is open, at launch,
    // and when the computer wakes. ENGELBART_SUMMARIES=off turns the summaries off; the sweep still runs its text pass
    // (every pdf's text kept for search, library_text). The _FAKE / _QUIET_MS / _INTERVAL_MS variables exist for
    // scripted runs only.
    const millis = (name) => { const value = Number(process.env[name]); return Number.isFinite(value) && value > 0 ? value : undefined; };
    sweeper = createSweeper({
      getContext: () => store.context(),
      summarize: process.env.ENGELBART_SUMMARY_FAKE === '1'
        ? createFakeSummarizer()
        : createCliSummarizer({ readSettings: () => store.config().summarizer, runDirectory: path.join(app.getPath('userData'), 'context-runs'), codexHome: path.join(app.getPath('userData'), 'codex-home'), tools }),
      summaries: process.env.ENGELBART_SUMMARIES !== 'off',
      quietMs: millis('ENGELBART_SUMMARY_QUIET_MS'),
      intervalMs: millis('ENGELBART_SUMMARY_INTERVAL_MS'),
    });
    // @bart (src/main/bart): hidden Claude Code or Codex runs on the person's subscription, reading only. It starts on
    // what was last picked by hand for that place (`place`: 'bart', 'build' or 'quick'; bart/choices.cjs), else on the
    // saved default provider, or on the other one while that one's CLI cannot run (preferUsable). Settings › Intelligence
    // (bart/settings.cjs) writes the defaults into the same file and forgets the picks it overrules.
    // ENGELBART_BART_FAKE=1 answers without a model, for scripted runs only.
    const readModels = (place = 'bart') => modelsInForce(store.layout.root, place, { only: store.config().providers, usable: tools.usableAgents() });
    // What the model menus show (MATH-159, tools/codex-models.cjs codexMenu): each Codex model as the member of its family
    // the account's Codex lists, by the cache of the home that place's runs use (@bart's own, else the person's; a Build's,
    // the person's), a family it lists none of hidden. As readModels with no cache, or one another Codex version wrote.
    // Runs read readModels unchanged, and say when they ran on another id. A model hidden this way is shown greyed with
    // why: the plan, or a Codex older than the newest on npm (newestCodex).
    const newestCodexVersion = newestCodex();
    newestCodexVersion.get(); // asked now, so the first menu opened already knows it
    const menuModels = (place = 'bart') => {
      const homes = place === 'bart' ? [path.join(app.getPath('userData'), 'codex-home-bart'), personalCodexHome()] : [personalCodexHome()];
      const version = runningCodexVersion(tools);
      return codexMenu(readModels(place), listedIn(homes, { version }), 'openai', { version, newest: newestCodexVersion.get() });
    };
    const rememberModelChoice = (place, choice) => rememberChoice(store.layout.root, place, choice);
    const modelSettings = createModelSettings({ homeRoot: () => store.layout.root, only: () => store.config().providers, tools });
    const bartModels = () => readModels('bart');
    const bartPicked = (choice) => rememberModelChoice('bart', choice);
    // @create (2026-10-13) too, keeping no sessions; what it makes goes in the library (bart/create.cjs), so the sidebar hears of it.
    // @brainstorm and @discover (2026-09-30) run through the same object, each with sessions of its own kept for two idle
    // hours and its own Codex home. @orient's (2026-10-04) are left in orient-threads.json, unread: it is @brainstorm now.
    const bartThreads = () => createThreads({ file: path.join(app.getPath('userData'), 'bart-threads.json') });
    const brainstormThreads = () => createThreads({ idleMs: BRAINSTORM_IDLE_MS, file: path.join(app.getPath('userData'), 'brainstorm-threads.json') });
    const discoverThreads = () => createThreads({ idleMs: DISCOVER_IDLE_MS, file: path.join(app.getPath('userData'), 'discover-threads.json') });
    // The Agent Viewer (2026-10-12; it was the Agent map): each ask's prompt, context, steps, tool calls and output, in a
    // developer's copy alone; a copy people download keeps none of it. Runs are recorded whether test mode is on or off,
    // and the window opens either way (it was only while test mode was on). Each change goes to the Viewer only.
    agentMap = createAgentMapWindow({ BrowserWindow, appUrl: APP_URL, preload: PRELOAD_FILE, available: () => developer, headless: process.env.ENGELBART_HEADLESS === '1' });
    runLog = developer ? createRunLog({ file: path.join(app.getPath('userData'), 'agent-runs.jsonl'), onChange: (record) => agentMap.send('engelbart:agent-run', record) }) : null;
    bart = process.env.ENGELBART_BART_FAKE === '1'
      ? createFakeBart({ readModels: bartModels, onPicked: bartPicked, threads: bartThreads(), brainstormThreads: brainstormThreads(), discoverThreads: discoverThreads(), runLog, inspectPdf, onAdded: libraryChanged })
      : createBart({ runLog, readModels: bartModels, onPicked: bartPicked, runDirectory: path.join(app.getPath('userData'), 'bart-runs'), codexHome: path.join(app.getPath('userData'), 'codex-home-bart'), brainstormCodexHome: path.join(app.getPath('userData'), 'codex-home-brainstorm'), discoverCodexHome: path.join(app.getPath('userData'), 'codex-home-discover'), createCodexHome: path.join(app.getPath('userData'), 'codex-home-create'), threads: bartThreads(), brainstormThreads: brainstormThreads(), discoverThreads: discoverThreads(), tools, inspectPdf, onAdded: libraryChanged });
    // A new thread's title (2026-10-12, bart/name-chat.cjs): the lowest model of the provider its question runs on, low effort.
    nameChat = process.env.ENGELBART_BART_FAKE === '1'
      ? createFakeNameChat({ readModels: bartModels })
      : createNameChat({ readModels: bartModels, runDirectory: path.join(app.getPath('userData'), 'name-runs'), codexHome: path.join(app.getPath('userData'), 'codex-home-name'), tools });
    sweeper.start();
    powerMonitor.on('resume', () => sweeper.sweepSoon());
    // Build (src/main/build): a workspace handed to Claude Code or Codex in a git worktree of its own, writing only there.
    // Git is the one the tool check found; a scripted run with the check off (ENGELBART_TOOLS=off) uses PATH's.
    // ENGELBART_BUILD_FAKE=1 runs the fake agent (git and records stay real), for scripted runs only.
    const gitRecord = () => tools.snapshot().tools.git;
    const gitReady = () => process.env.ENGELBART_TOOLS === 'off' || (gitRecord().installed && gitRecord().status === 'ready');
    builds = createBuilds({
      git: createGit({ gitPath: () => { const record = gitRecord(); return record.status === 'ready' && record.path ? record.path : 'git'; } }),
      runner: process.env.ENGELBART_BUILD_FAKE === '1'
        ? createFakeBuildRunner({ delayMs: Number(process.env.ENGELBART_BUILD_FAKE_MS) || 900 }) // _MS: how long a fake turn takes
        : createBuildRunner({ runDirectory: path.join(app.getPath('userData'), 'build-runs'), tools }), // Codex in the person's own CODEX_HOME (2026-10-07)
      readModels: () => readModels('build'),
      // Every window hears a Build's changes, and a quick task's reach the post-it it came from in every window showing
      // its project (post-its/views.cjs); what its run step opens goes to the window that asked (routeRun).
      notify: (channel, payload) => {
        if (channel === 'engelbart:build-run') { routeRun(payload); return; }
        sendToRenderer(channel, payload);
        if (channel === 'engelbart:build' && payload && payload.postItId) for (const ctx of windows.all()) ctx.postItViews.buildState(payload);
      },
      tools,
      gitReady,
      // Cloning a private library repository with the GitHub sign-in (github is made further down, long before a clone).
      githubToken: () => github.token(),
      libraryChanged, // the default repo's row made, a clone kept on its row, an agent's save_file: the sidebar reads the library again
      inspectPdf, // a pdf an agent moves into Engelbart is read for whether it is a paper
      keepDir: path.join(app.getPath('userData'), 'build-keep'), // a turn's library files kept aside (build/keep.cjs)
      runLog, // the Agent map's record of each turn (a developer copy's only; none: nothing kept)
      // The run step after a turn that ends in review (build/run-step.cjs): Claude Code on the person's subscription finds
      // what the repository runs; Engelbart starts, checks and shows it (a UI in the Stage, a terminal program in a
      // terminal of its own, an app in its window). ENGELBART_RUN_STEP=off leaves it out; a scripted run
      // (ENGELBART_BUILD_FAKE=1 or ENGELBART_RUN_FAKE=1) uses the fake agent, which needs no model.
      runStep: process.env.ENGELBART_RUN_STEP === 'off' ? null : createRunStep({
        processes: createRunProcesses({ environment: process.env, extraEnvironment: () => tools.environment() }),
        tools,
        runLog, // the Agent map's record of each run step
        ...(process.env.ENGELBART_BUILD_FAKE === '1' || process.env.ENGELBART_RUN_FAKE === '1' ? { runAgent: createFakeRunAgent(), prepareClaude: async () => ({ file: 'fake', env: {} }) } : {}),
        // The command is typed once the shell has drawn its prompt (quiet for a moment, at most 3s): typed sooner, the
        // terminal echoes it and then the shell's line editor draws it again.
        openTerminal: ({ cwd, command }) => {
          const session = manager.create({ provider: 'shell', cwd, cols: 100, rows: 30 });
          windows.own(session.id, windows.asking() || focusedWindow()); // the window whose card opened it (routeRun)
          let quiet = null;
          const type = () => { clearTimeout(quiet); clearTimeout(cap); manager.off('data', drawn); try { manager.write(session.id, `${command}\r`); } catch { /* closed already */ } };
          const drawn = (payload) => { if (payload.id !== session.id) return; clearTimeout(quiet); quiet = setTimeout(type, 150); };
          const cap = setTimeout(type, 3000);
          manager.on('data', drawn);
          return session;
        },
        closeTerminal: async (id) => { await manager.close(id); windows.forget(id); sendToRenderer('engelbart:build-run', { kind: 'closed', sessionId: id }); },
        terminalSnapshot: (id) => manager.get(id),
      }),
    });
    // Records a closed app left working are interrupted (Resume goes on), before anything lists them.
    store.context().then((ctx) => builds.reconcile(ctx)).catch(() => {});
    // A terminal's output goes to the window that holds its session; that it ended, to every window.
    manager.on('data', (payload) => windows.terminalData(payload));
    manager.on('exit', (payload) => {
      sendToRenderer('terminal:exit', payload);
      if (stageBridges && payload) void stageBridges.close(payload.id);
    });
    // open_on_stage (MATH-79): the window that holds the session shows it on its Stage; resolved here (./terminal/stage-tools.cjs).
    stageBridges = createStageBridges({
      directory: path.join(app.getPath('userData'), 'terminal-stage'),
      codexHome: () => process.env.CODEX_HOME || path.join(app.getPath('home'), '.codex'),
      toolFor: (session) => stageToolFor({
        session,
        owner: (id) => (windows ? windows.ownerOf(id) : null),
        context: () => store.context(),
        projectItems: (ctx, projectId) => library.libraryForProject(ctx, projectId),
        projectName: (ctx, projectId) => { try { return projects.findProject(ctx, projectId).name; } catch { return null; } },
        deliver: (ctx, payload) => windows.deliver(ctx, 'engelbart:stage-open', payload),
      }),
    });
    // Each window's own Stage tabs and post-its (./windows.cjs), sending to that window alone. The post-its of windows on
    // the same project hear each other's saves (createPostItPeers).
    const postItPeers = createPostItPeers();
    windows = createWindows({
      appUrl: APP_URL,
      manager,
      onChange: () => saveWindows(),
      makeViews: (ctx) => {
        const send = (channel, payload) => windows.deliver(ctx, channel, payload);
        const postItViews = createPostItViews({
          electron: { WebContentsView, clipboard, shell: electronShell },
          getWindow: () => ctx.win,
          getContext: () => store.context(),
          send,
          buildFor: async (projectId, postItId) => {
            const list = builds.list(await store.context(), projectId).filter((task) => task.postItId === postItId);
            return list[list.length - 1] || null;
          },
          peers: postItPeers,
        });
        const browserViews = createBrowserViews({
          electron: { WebContentsView, session: electronSession, Menu, clipboard, dialog, shell: electronShell, screen: require('electron').screen },
          getWindow: () => ctx.win,
          send,
          appName: app.getName(),
          fileRoot: () => homeDir,
          onLayerChange: () => postItViews.raise(),
          partition: BROWSER_PARTITION,
          // A page's web highlights (MATH-54 build 2) and boxes (MATH-70): its ink as the library keeps it, the "web" list
          // in it; a box's pictures go and come back with it.
          pageMarks: {
            list: async (url) => { const ink = await library.readPageAnnotations(await store.context(), url); return ink && Array.isArray(ink.web) ? ink.web : []; },
            add: async (url, mark, extra) => library.addWebMark(await store.context(), url, mark, extra),
            remove: async (url, markId) => library.removeWebMark(await store.context(), url, markId),
            restore: async (url, removed) => library.restoreWebMark(await store.context(), url, removed),
            // a box resized, or a note written on its card (MATH-70 build 2): → the mark as written, or null
            update: async (url, markId, patch, extra) => library.updateWebMark(await store.context(), url, markId, patch, extra),
          },
        });
        return { browserViews, postItViews };
      },
    });
    registerTerminalIpc();
    registerWindowIpc();
    // Registered once each; every call acts on the calling window's views (a card's, on the window whose card it is).
    registerPostItIpc({
      ipcMain,
      trustedHandler,
      viewsFor: (event) => {
        const ctx = windows.of(event.sender);
        return ctx ? ctx.postItViews : windows.cardsHolding(event.sender);
      },
    });
    // Importing sign-ins from the person's browsers into the Stage (MATH-18): macOS only, and into the one shared
    // Stage session every window's tabs read. Cookie values stay here — the handlers return domains and counts. The sign-in
    // checks go through net.request, which (unlike net.fetch) says where a redirect was going (import-cookies.cjs).
    // A browser counts only while its app is installed (2026-10-12: one dragged to the Trash leaves its profiles behind):
    // looked for in /Applications first, else Spotlight asked in the background and its answer kept, never synchronously
    // (./browser/installed-apps.cjs). ENGELBART_INSTALLED_BROWSERS (bundle ids, comma-separated) stands in for it in
    // scripted runs, so they never depend on this Mac's apps.
    const installedApps = createInstalledApps({
      override: process.env.ENGELBART_INSTALLED_BROWSERS != null ? process.env.ENGELBART_INSTALLED_BROWSERS.split(',').map((id) => id.trim()).filter(Boolean) : null,
    });
    const browserInstalled = (bundle) => installedApps.has(bundle);
    const browserSettled = (bundle) => installedApps.settled(bundle);
    const cookieImport = process.platform === 'darwin' ? createCookieImport({
      supportDir: path.join(app.getPath('home'), 'Library', 'Application Support'),
      userDataDir: app.getPath('userData'),
      getSession: () => electronSession.fromPartition(BROWSER_PARTITION),
      request: (options) => net.request(options),
      keychain: keychainRunner,
      installed: browserInstalled,
      settled: browserSettled,
    }) : null;
    registerBrowserIpc({ ipcMain, trustedHandler, viewsFor: (event) => { const ctx = windows.of(event.sender); return ctx ? ctx.browserViews : null; }, cookieImport });
    // GitHub (src/main/github): default-browser sign-in with an automatic loopback return, and the token
    // that lets the library read private repositories. ENGELBART_GITHUB_* name a fake GitHub, for scripted runs only.
    const githubWeb = process.env.ENGELBART_GITHUB_WEB || null;
    const openGithubPage = (url) => electronShell.openExternal(parseExternalUrl(url).href);
    const githubBrowserAuth = createBrowserAuth({ ...(process.env.ENGELBART_GITHUB_BROKER ? { broker: process.env.ENGELBART_GITHUB_BROKER } : {}) });
    // An unpackaged copy may run sandboxes on the developer's own E2B_API_KEY (the process environment only, never a
    // file); a release never does.
    const devE2bKey = app.isPackaged ? null : process.env.E2B_API_KEY || null;
    // MATH-111: the repositories on this Mac whose GitHub remotes name the organizations the person works in, as Connect
    // finds them before anything is picked (connect/scan.cjs localRepos), read again at most every five minutes. One under
    // ~/Desktop, ~/Documents or ~/Downloads is left out unless macOS already let Engelbart read that folder (MATH-110,
    // asked on Connect's choose screen): signing in never makes macOS ask for those folders (Connect's scan adds the ones
    // the person picked).
    // Read in the scanner process (./connect/scan-child.cjs): 4 s of session files froze the window here. The last answer
    // is used while a new one is read.
    let macRepos = { at: 0, dirs: [], reading: false };
    const macRepoDirs = () => {
      if (Date.now() - macRepos.at > 5 * 60_000 && !macRepos.reading) {
        macRepos.reading = true;
        const dataRoot = store.config().dataRoot;
        scanner.run('localRepos', { homeDir, access: accessSpec(folderAccess.guard({ homeDir, dataRoot }), dataRoot) })
          .then((repos) => { macRepos = { at: Date.now(), dirs: (Array.isArray(repos) ? repos : []).filter((repo) => repo.checked).map((repo) => repo.path), reading: false }; })
          .catch(() => { macRepos = { ...macRepos, at: Date.now(), reading: false }; });
      }
      return macRepos.dirs;
    };
    const github = createGithub({
      settings: () => {
        const chosen = store.config().github || {};
        return { clientId: process.env.ENGELBART_GITHUB_CLIENT_ID || chosen.clientId, appSlug: process.env.ENGELBART_GITHUB_APP_SLUG || chosen.appSlug };
      },
      // Each data root keeps its own sign-in (2026-09-28): test mode starts signed out after "Start as a new user"; the real
      // root's file is where it always was.
      file: () => path.join(store.config().dataRoot, 'github.json'),
      crypt: {
        available: () => safeStorage.isEncryptionAvailable(),
        encrypt: (text) => safeStorage.encryptString(text).toString('base64'),
        decrypt: (text) => safeStorage.decryptString(Buffer.from(text, 'base64')),
      },
      openVerification: openGithubPage,
      // Right after a fresh sign-in, the App's install page, for the organizations it cannot see yet.
      openInstall: openGithubPage,
      localOrgs: ({ login, dirs = [] }) => macOrgs([...macRepoDirs(), ...dirs], { login }),
      browserAuth: () => (process.env.ENGELBART_GITHUB_CLIENT_ID || (store.config().github || {}).clientId) === GITHUB_CLIENT_ID ? githubBrowserAuth : null,
      onConnected: () => {
        void e2bKey.get().catch(() => {}); // early, so the first sandbox need not wait; it asks again if this failed
        const ctx = focusedWindow();
        if (ctx && !ctx.win.isDestroyed()) { if (ctx.win.isMinimized()) ctx.win.restore(); ctx.win.show(); ctx.win.focus(); }
      },
      // Signing out (or a sign-in that expired) drops the E2B key, and stops the sandboxes started with it. Signed out
      // there are none, so a repeat is a no-op; a developer's own key (devE2bKey) is not tied to the sign-in at all.
      onChange: (status) => {
        if (!status.connected) { e2bKey.forget(); if (!devE2bKey) sandbox?.signedOut().catch(() => {}); }
        sendToWindow('engelbart:github', status);
      },
      ...(githubWeb ? { web: githubWeb, api: process.env.ENGELBART_GITHUB_API || githubWeb } : {}),
    });
    // Zotero (src/main/zotero, MATH-65): default-browser sign-in through the broker on engelbart.mathetic.com, the API key
    // kept encrypted in <dataRoot>/zotero.json beside github.json. ENGELBART_ZOTERO_BROKER and ENGELBART_ZOTERO_API name a
    // fake broker and a fake api.zotero.org, for scripted runs only.
    const zoteroBrowserAuth = createZoteroBrowserAuth({ ...(process.env.ENGELBART_ZOTERO_BROKER ? { broker: process.env.ENGELBART_ZOTERO_BROKER } : {}) });
    const zotero = createZotero({
      file: () => path.join(store.config().dataRoot, 'zotero.json'),
      crypt: {
        available: () => safeStorage.isEncryptionAvailable(),
        encrypt: (text) => safeStorage.encryptString(text).toString('base64'),
        decrypt: (text) => safeStorage.decryptString(Buffer.from(text, 'base64')),
      },
      browserAuth: () => zoteroBrowserAuth,
      openAuthorize: (url) => electronShell.openExternal(parseExternalUrl(url).href),
      onConnected: () => {
        const ctx = focusedWindow();
        if (ctx && !ctx.win.isDestroyed()) { if (ctx.win.isMinimized()) ctx.win.restore(); ctx.win.show(); ctx.win.focus(); }
        void zoteroLibrary.sync().catch(() => {}); // the library, mirrored as soon as it is connected
      },
      onChange: () => sendToWindow('engelbart:zotero', zoteroStatus()),
      ...(process.env.ENGELBART_ZOTERO_API ? { api: process.env.ENGELBART_ZOTERO_API } : {}),
    });
    // The connected library, mirrored in <dataRoot>/.zotero/ (src/main/zotero/sync.cjs, MATH-65 build 2) for Bart and the
    // @ menu: synced after connecting, a little after launch when connected, and from the Zotero row's "Sync now". The key
    // goes to api.zotero.org only. ENGELBART_ZOTERO_STORAGE names Zotero's storage folder when not ~/Zotero/storage.
    // Build 3: synced every 10 minutes while the app is open, and when a window comes to the front if the last sync was
    // over 2 minutes ago (one at a time; an unchanged library is one 304). A free copy of an item with no pdf is looked
    // for through OpenAlex (zotero/oa.cjs) when it is mentioned or its chip clicked; the chip is told while it runs.
    // ENGELBART_OPENALEX_API names a fake OpenAlex, for scripted runs only.
    // Build 4: Semantic Scholar and arXiv after OpenAlex (ENGELBART_SEMANTIC_SCHOLAR_API, ENGELBART_ARXIV_API and
    // ENGELBART_ARXIV name fakes, for scripted runs only). A paper whose chip opened its page in the browser has its pdf
    // waited for in the Downloads folder for 10 minutes (zotero/downloads.cjs); one that is the paper is copied in, opened
    // in the Stage of the window focused last, and the app comes to the front. The waits end when the app quits.
    // Build 5: the groups the person is in are mirrored too, each in .zotero/groups/<groupID>/, on the same clock; the
    // channels below carry an item's ref (`g<groupID>:<key>` for a group's item, its key for My Library's).
    zoteroLibrary = createZoteroSync({
      root: () => zoteroMirrorDir(store.config().dataRoot),
      account: () => { const key = zotero.key(); return key ? { userID: zotero.status().userID, key } : null; },
      onChange: () => sendToWindow('engelbart:zotero', zoteroStatus()),
      onFinding: (key, finding) => sendToWindow('engelbart:zotero-finding', { key, finding }),
      ...(process.env.ENGELBART_ZOTERO_API ? { api: process.env.ENGELBART_ZOTERO_API } : {}),
      ...(process.env.ENGELBART_ZOTERO_STORAGE ? { storageDir: process.env.ENGELBART_ZOTERO_STORAGE } : {}),
      ...(process.env.ENGELBART_OPENALEX_API ? { openAlex: process.env.ENGELBART_OPENALEX_API } : {}),
      ...(process.env.ENGELBART_SEMANTIC_SCHOLAR_API ? { semanticScholar: process.env.ENGELBART_SEMANTIC_SCHOLAR_API } : {}),
      ...(process.env.ENGELBART_ARXIV_API ? { arxivApi: process.env.ENGELBART_ARXIV_API } : {}),
      ...(process.env.ENGELBART_ARXIV ? { arxiv: process.env.ENGELBART_ARXIV } : {}),
      downloadsDir: () => app.getPath('downloads'),
      onWaiting: (key, waiting) => sendToWindow('engelbart:zotero-waiting', { key, waiting }),
      onDownloaded: (key, copy) => {
        const ctx = focusedWindow();
        if (ctx && !ctx.win.isDestroyed()) windows.send(ctx, 'engelbart:zotero-downloaded', { key, path: copy.path });
        showWindow();
        if (process.platform === 'darwin') app.focus({ steal: true });
      },
    });
    app.on('will-quit', () => zoteroLibrary.stopWatching());
    const zoteroStatus = () => { const status = zotero.status(); return { ...status, sync: status.connected ? zoteroLibrary.status() : null }; };
    const zoteroConnected = () => { try { return !!zotero.key(); } catch { return false; } };
    setTimeout(() => { if (zoteroConnected()) void zoteroLibrary.autoSync().catch(() => {}); }, 4000);
    const zoteroSchedule = scheduleZoteroSyncs(zoteroLibrary, { connected: zoteroConnected });
    app.on('browser-window-focus', () => zoteroSchedule.focus());
    // The E2B API key for whoever is signed in (src/main/github/e2b-key.cjs), in memory only, and the only key the sandbox
    // worker gets (sandbox/manager.cjs). ENGELBART_E2B_KEY_HOST is for scripted runs only.
    const e2bKey = createE2bKey({
      github,
      version: app.getVersion(),
      override: devE2bKey,
      ...(process.env.ENGELBART_E2B_KEY_HOST ? { host: process.env.ENGELBART_E2B_KEY_HOST } : {}),
    });
    // E2B previews (src/main/sandbox; docs/sandbox-runs.md): a saved GitHub repository cloned, set up and served in an E2B
    // sandbox. Progress goes to the window on every screen, not only once a terminal is attached. ENGELBART_SANDBOXES=off
    // turns them off, for scripted runs only.
    sandbox = process.env.ENGELBART_SANDBOXES === 'off' ? null : createSandboxManager({
      secure: safeStorage,
      notify: (event) => sendToWindow('engelbart:sandbox-progress', event),
      e2bKey: () => e2bKey.get(),
      githubLogin: () => github.status().login,
      // A new run waits until Claude Code is signed in to a subscription, which does its setup (sandbox/manager.cjs).
      claudeReady: () => prepareLocalClaude(),
      // A repository used from a terminal: its shell, in the terminal pane of the window that opened it. Main ending one
      // (Stop, Retry, release) takes its tab away, as a Build's run step does with its terminal programs.
      terminals: createSandboxTerminals({
        sessions: () => manager,
        own: (id) => {
          const target = windows.asking() || focusedWindow();
          if (!target) return;
          const left = windows.own(id, target);
          if (left) windows.deliver(left, 'engelbart:build-run', { kind: 'closed', sessionId: id });
        },
        closed: (id) => { windows.forget(id); sendToRenderer('engelbart:build-run', { kind: 'closed', sessionId: id }); },
      }),
      // A private repository reaches its sandbox as a one-archive download link, never as the sign-in (github/repo-access.cjs).
      repoAccess: createRepoAccess({
        token: () => github.token(),
        installUrl: () => github.status().installUrl,
        ...(githubWeb ? { api: process.env.ENGELBART_GITHUB_API || githubWeb } : {}),
      }),
    });
    // The Overleaf projects open in the Stage (MATH-65): each one's copy is downloaded with the Stage's own session, the
    // sign-in the person made there, so no cookie leaves it.
    const overleafStage = createOverleafStage({ copies: createOverleafCopies({ fetch: (url, init) => electronSession.fromPartition(BROWSER_PARTITION).fetch(url, init) }) });
    // Connect your library (src/main/connect, 2026-10-07): the chat of onboarding and of a one-time popup, in every library
    // since 2026-10-08. A librarian agent asks what should come in; survey, recall and import agents do the work in the background
    // on the person's subscription, pinned to Sonnet high or Sol high. They read this Mac, use Engelbart's own hidden
    // browser on the Stage's sign-ins (./connect/browser.cjs: never the screen), the connectors Engelbart signs in to
    // (Granola, Notion) and macOS Automation (Apple Notes), and write only through Engelbart's import tools; then MEMORY.md.
    // Its events go to the windows directly: the onboarding screen never attaches a terminal. ENGELBART_CONNECT_FAKE=1 (or
    // ENGELBART_BART_FAKE=1) runs it with no model.
    const connectFake = process.env.ENGELBART_CONNECT_FAKE === '1' || process.env.ENGELBART_BART_FAKE === '1';
    // Scripted runs of onboarding's connect edge cases (2026-10-14): the fake agents run only while the pretend machine's
    // Claude Code or Codex could (ENGELBART_TOOLS_FAKE), and which can is the tool check's answer, not "both".
    const cliFake = connectFake && !!toolsFake && process.env.ENGELBART_CONNECT_FAKE_CLI === '1';
    const crypt = {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (text) => safeStorage.encryptString(text).toString('base64'),
      decrypt: (text) => safeStorage.decryptString(Buffer.from(text, 'base64')),
    };
    // A page Engelbart opens for the person to act on (a connector's consent, round 3): in the browser they chose for their
    // sign-ins, not macOS's default (which need not be it). Set once that choice is known (onboardingBrowsers, below).
    let openChosen = (url) => electronShell.openExternal(parseExternalUrl(url).href);
    const connectors = createConnectors({
      file: () => path.join(store.config().dataRoot, 'connectors.json'),
      crypt,
      openExternal: (url) => openChosen(url),
      onChange: (status) => sendToWindow('engelbart:connectors', status),
      // The connectors the person signed in to in their own Claude Code or Codex (round 3: Granola "headlessly").
      own: createOwnConnectors({
        homeDir,
        codexList: () => new Promise((resolve, reject) => {
          execFile('codex', ['mcp', 'list', '--json'], { env: { ...process.env, ...(tools ? tools.environment() : {}) }, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
        }),
      }),
    });
    const agentBrowser = createAgentBrowser({
      BrowserWindow,
      getSession: () => electronSession.fromPartition(BROWSER_PARTITION),
      userAgent: (ua) => cleanUserAgent(ua),
      log: (jobId, text) => { if (connect) connect.logJob(jobId, text); },
      onClosed: (jobId) => { if (connect) connect.windowClosed(jobId); },
      headless: process.env.ENGELBART_HEADLESS === '1',
    });
    const appleNotes = createAppleNotes();
    // A web app's sign-in in the person's default browser, brought over into the Stage's session the agents use
    // (./connect/web-signin.cjs). Its own importer remembers a browser's Keychain key while Engelbart runs, so macOS asks once
    // however often it looks again. The person was told macOS would ask (the choose screen's panel, 2026-10-10), so its
    // prompt waits ten minutes for them rather than one.
    const keychainKeys = new Map();
    // Import your context's remembered answers (./onboarding/prefs.cjs), in the data root open now.
    const prefs = {
      get: () => { try { return onboardingPrefs.get(store.config().dataRoot); } catch { return {}; } },
      set: (patch) => onboardingPrefs.set(store.config().dataRoot, patch),
    };
    // The browser whose sign-ins Engelbart uses (2026-10-13): the person's pick, else macOS's default; only installed
    // ones are offered. ENGELBART_ONBOARDING_BROWSERS (ids, the default first) stands in for this Mac in scripted runs.
    const macDefaultBrowser = () => { try { return app.getApplicationNameForProtocol('https://'); } catch { return ''; } };
    const onboardingBrowsers = createBrowsers({
      installedApps,
      defaultName: macDefaultBrowser,
      prefs,
      override: process.env.ENGELBART_ONBOARDING_BROWSERS != null ? process.env.ENGELBART_ONBOARDING_BROWSERS.split(',').map((id) => id.trim()).filter(Boolean) : null,
      // Each browser's profiles, Allow's one macOS prompt, and Safari's Full Disk Access (2026-10-16, C4/C5): webSignIn and
      // diskAccess are made below, and only asked once the window calls.
      profilesOf: (id) => webSignIn.profilesOf(id),
      unlock: (id) => webSignIn.unlockBrowser(id),
      diskAccess: () => diskAccess.status(),
    });
    openChosen = (url) => new Promise((resolve, reject) => {
      const remembered = (prefs.get() || {}).browser || null;
      const bundle = remembered ? bundleOf(remembered) : null;
      if (!bundle || process.platform !== 'darwin') { electronShell.openExternal(parseExternalUrl(url).href).then(resolve, reject); return; }
      execFile('open', ['-b', bundle, parseExternalUrl(url).href], (error) => (error ? reject(error) : resolve()));
    });
    const webSignIn = createWebSignIn({
      cookieImport: process.platform === 'darwin' ? createCookieImport({
        // The home Engelbart was given (ENGELBART_HOME_DIR in scripted runs, so they never read this Mac's browsers).
        supportDir: path.join(homeDir, 'Library', 'Application Support'),
        userDataDir: app.getPath('userData'),
        getSession: () => electronSession.fromPartition(BROWSER_PARTITION),
        // A copy is checked before it counts (2026-10-12): Google's check page over the Stage's session.
        request: (options) => net.request(options),
        installed: browserInstalled,
        settled: browserSettled,
        keychain: (name) => {
          if (!keychainKeys.has(name)) keychainKeys.set(name, keychainRunner(name, undefined, { timeoutMs: 10 * 60_000 }).catch((error) => { keychainKeys.delete(name); throw error; }));
          return keychainKeys.get(name);
        },
      }) : null,
      // The browser the person picked for their sign-ins (Import your context), else macOS's default (2026-10-13: "Claude
      // sign-in opened in Chrome, but his keychain credentials were in Arc"): read first, and where sign-in pages open.
      defaultBrowser: () => onboardingBrowsers.preferredName() || macDefaultBrowser(),
      // The "default" above is the browser the person chose: its pages open there, not in macOS's default (round 3).
      openExternal: (url) => openChosen(url),
      // A browser other than the default (Safari's cookies can't be read): `open -b <bundle id> <url>`.
      openIn: (browserId, url) => new Promise((resolve, reject) => {
        const bundle = bundleOf(browserId);
        if (!bundle) { reject(new Error(`No way to open ${browserId}`)); return; }
        execFile('open', ['-b', bundle, parseExternalUrl(url).href], (error) => (error ? reject(error) : resolve()));
      }),
      // A page in one profile of a Chromium browser (C8): `open -n -b <bundle> --args --profile-directory=<id> <url>`.
      openInProfile: (browserId, profileId, url) => new Promise((resolve, reject) => {
        const bundle = bundleOf(browserId);
        if (!bundle) { reject(new Error(`No way to open ${browserId}`)); return; }
        execFile('open', profileOpenArgs(bundle, profileId, parseExternalUrl(url).href), (error) => (error ? reject(error) : resolve()));
      }),
      getSession: () => electronSession.fromPartition(BROWSER_PARTITION),
      // The profile picked when several hold a sign-in, in <dataRoot>/.connect/signin-profiles.json (ids only).
      picks: createSigninProfiles({ dataRoot: () => store.config().dataRoot }),
      // The browser, profile and Keychain answer onboarding remembered (2026-10-16, C4-C6): the only ones a copy uses.
      chosen: () => { const kept = prefs.get() || {}; return { browser: kept.browser || null, profile: kept.profile || null, keychain: kept.keychain || null }; },
      // Every sign-in check's answer in the Agent trace too (C2: its status and where a redirect went).
      log: (text, detail) => {
        console.warn(`[connect] ${text}`);
        if (detail && detail.kind === 'signin-check') { try { trace.event({ kind: 'signin-check', text, detail }); } catch { /* the trace is made below */ } }
      },
    });
    // A sign-in made in Engelbart's own browser (the choose screen's "Sign in", ./connect/signin-window.cjs): on the Mac when
    // no browser of the person's holds one to bring over or they turned its sign-ins down, and every sign-in elsewhere.
    const signInWindow = createSignInWindow({
      BrowserWindow,
      getParent: dialogWindow,
      getSession: () => electronSession.fromPartition(BROWSER_PARTITION),
      userAgent: (ua) => cleanUserAgent(ua),
      signedIn: (name) => webSignIn.signedIn(name),
      headless: process.env.ENGELBART_HEADLESS === '1',
    });
    // The providers whose CLI can run now (the tool check), as Connect names them; before the first check, both.
    const connectReady = () => {
      if (connectFake && !cliFake) return ['anthropic', 'openai'];
      const usable = tools && typeof tools.usableAgents === 'function' ? tools.usableAgents() : null;
      if (usable === null) return ['anthropic', 'openai'];
      // One updating itself in the background (or about to) can run Connect's agents too (2026-10-13: the update never
      // holds onboarding).
      const snap = tools.snapshot();
      const updating = ['claude', 'codex'].filter((name) => { const tool = snap.tools[name]; return tool && tool.installed && (tool.status === 'updating' || (tool.status === 'outdated' && tool.autoUpdate)); });
      return [...new Set([...usable, ...updating])].map((name) => (name === 'claude' ? 'anthropic' : 'openai'));
    };
    // The Agent trace (./onboarding/trace.cjs): every turn of Connect's and Import your context's agents, and the
    // dispatching around them, in <dataRoot>/.connect/trace; View ▸ Agent Trace shows it.
    const trace = createTrace({ dataRoot: () => store.config().dataRoot, notify: (entry) => { if (traceWindow) traceWindow.send(entry); } });
    traceWindow = createTraceWindow({ BrowserWindow, dialog, trace, traceDir: () => path.join(store.config().dataRoot, '.connect', 'trace'), reveal: (dir) => { fs.mkdirSync(dir, { recursive: true }); electronShell.openPath(dir); } });
    // Browser agents (./onboarding/browser-agents.cjs, 2026-10-13): the web apps' imports in the person's own browser, run in
    // the Engelbart terminal (./terminal/agent-terminal.cjs) as a terminal pane's session is. ENGELBART_BROWSER_AGENTS
    // ('allowed' | 'ask' | 'none') stands in for this Mac in scripted runs.
    const browserAgents = createBrowserAgents({ homeDir, prefs, fake: process.env.ENGELBART_BROWSER_AGENTS || (connectFake ? 'none' : '') });
    const agentTerminal = createAgentTerminal({ environment: environmentForSessions(process.env, app.getPath('userData')), extraEnvironment: () => tools.environment() });
    // The person's browser brought forward when they press Open on a browser agent's sign-in card: the agent's tab is there.
    const openBrowserApp = (id) => new Promise((resolve, reject) => {
      const known = importBrowserById(id);
      const args = known ? ['-b', known.bundle] : id === 'vivaldi' ? ['-a', 'Vivaldi'] : null;
      if (!args || process.platform !== 'darwin') { reject(new Error('Unknown browser')); return; }
      execFile('/usr/bin/open', args, { timeout: 10_000 }, (error) => (error ? reject(error) : resolve(true)));
    });
    const connectAgents = trace.wrap(connectFake
      ? (cliFake ? createCliGatedAgents(createFakeConnectAgents({ delayMs: Number(process.env.ENGELBART_CONNECT_FAKE_MS) || 700 }), toolsFake.state, { refuse: String(process.env.ENGELBART_CONNECT_FAKE_REFUSE || '').split(',').filter(Boolean) }) : createFakeConnectAgents({ delayMs: Number(process.env.ENGELBART_CONNECT_FAKE_MS) || 700 }))
      : createConnectAgents({ runDirectory: path.join(app.getPath('userData'), 'connect-runs'), interviewHome: path.join(app.getPath('userData'), 'codex-home-connect'), importHome: path.join(app.getPath('userData'), 'codex-home-connect-import'), tools, terminal: agentTerminal }));
    connect = createConnect({
      agents: connectAgents,
      trace,
      models: () => readModels('build'),
      ready: connectReady,
      // a run waiting for its provider (session.cjs holdForProvider): that CLI is checked again, so its rows say why
      providerCheck: (provider) => tools.check([provider === 'openai' ? 'codex' : 'claude']),
      context: () => store.context(),
      homeDir,
      // connect(): an import step's Sign in starts Engelbart's own sign-in here in main (2026-10-14); ready(): the
      // library's sync, which the Zotero tools wait for before a first read
      zotero: {
        status: () => zotero.status(),
        root: () => (zotero.status().connected ? zoteroLibrary.root() : null),
        download: (key, filename) => zoteroLibrary.download(key, filename),
        connect: () => zotero.connect(),
        ready: () => zoteroLibrary.autoSync(),
      },
      github: { status: () => github.status(), repos: (options) => github.repos(options), connect: () => github.connect() },
      deps: { describe: createDescriber(), identifyRepo: createRepoIdentifier({ auth: github.authHeaders }), inspectPdf, onAdded: libraryChanged, onPdf: pdfAdded },
      notify: (snapshot) => sendToWindow('engelbart:connect', snapshot),
      // What came in joined the Welcome workspace (connect/session.cjs placeRows): its sidebar reads it again.
      placed: (projectId) => sendToWindow('engelbart:project-changed', { projectId }),
      openBridge: openToolBridge,
      browser: agentBrowser,
      connectors,
      appleNotes,
      webSignIn,
      signInWindow,
      browserAgents,
      openBrowserApp,
    });
    // The apps Engelbart's browser holds a sign-in for (their sign-in cookie in the Stage's session): ticked on the choose
    // screen, as an app found on this Mac is.
    const connectSignedIn = async () => {
      const cookies = electronSession.fromPartition(BROWSER_PARTITION).cookies;
      const out = [];
      for (const [name, [domain, pattern]] of Object.entries(SIGN_IN_COOKIES)) {
        if (!CONNECT_APPS[name]) continue;
        const held = await cookies.get({ domain }).catch(() => []);
        if (held.some((cookie) => pattern.test(cookie.name))) out.push(name);
      }
      return out;
    };
    // Import your context (2026-10-13): which provider runs its agents (both subscribed: asked once), the project and
    // tool discovery agents (started the moment Import context is pressed). ENGELBART_PROVIDERS_FAKE and
    // ENGELBART_DISK_ACCESS stand in for this Mac in scripted runs.
    const onboardingProviders = createProviders({ tools, prefs, homeDir, fake: process.env.ENGELBART_PROVIDERS_FAKE || (connectFake && !cliFake ? 'both' : ''), ...(toolsFake ? { run: toolsFake.execFile } : {}) });
    // Already allowed to read every folder macOS guards (the person granted it on their own; nothing asks for it, 2026-10-15):
    // the folders count as allowed for Connect's guard, and the import's folder popup is not needed.
    let diskGranted = false;
    const diskAccess = createDiskAccess({ homeDir });
    // Granted (this process can read what it guards): the four folders count as allowed for Connect's guard too (MATH-110),
    // so no agent is kept out of them and no folder prompt comes up.
    void diskAccess.status().then((status) => {
      diskGranted = !!(status && status.granted);
      if (diskGranted) { try { folderAccess.writeAnswers(store.config().dataRoot, Object.fromEntries(folderAccess.protectedFolders({ homeDir }).map((folder) => [folder.id, 'allowed']))); } catch { /* the guard asks as before */ } }
    }).catch(() => {});
    const discovery = createDiscovery({
      agents: connectAgents,
      models: () => readModels('build'),
      context: () => store.context(),
      homeDir,
      providers: onboardingProviders,
      webSignIn,
      cookieImport: process.platform === 'darwin' ? createCookieImport({ supportDir: path.join(homeDir, 'Library', 'Application Support'), userDataDir: app.getPath('userData'), getSession: () => electronSession.fromPartition(BROWSER_PARTITION), request: (options) => net.request(options), installed: browserInstalled, settled: browserSettled, keychain: (name) => { if (!keychainKeys.has(name)) keychainKeys.set(name, keychainRunner(name, undefined, { timeoutMs: 10 * 60_000 }).catch((error) => { keychainKeys.delete(name); throw error; })); return keychainKeys.get(name); } }) : null,
      agentBrowser,
      openBridge: openToolBridge,
      zotero: { status: () => zotero.status() },
      zoteroRoot: () => (zotero.status().connected ? zoteroLibrary.root() : null),
      github: { status: () => github.status(), repos: (options) => github.repos(options) },
      connectors,
      deps: { describe: createDescriber(), identifyRepo: createRepoIdentifier({ auth: github.authHeaders }), inspectPdf, onAdded: libraryChanged, onPdf: pdfAdded },
      notify: (state) => sendToWindow('engelbart:discovery', state),
      trace,
      access: (ctx) => folderAccess.guard({ homeDir, dataRoot: ctx.dataRoot, ...(diskGranted ? { answers: Object.fromEntries(folderAccess.protectedFolders({ homeDir }).map((folder) => [folder.id, 'allowed'])) } : {}) }),
      existingProjects: async (ctx) => (await projects.listProjects(ctx)).map((project) => project.name),
      scanner,
    });
    // The trace window's own calls: from that window only.
    const fromTrace = (handler) => async (event, ...args) => {
      if (!traceWindow || !traceWindow.isOpen() || BrowserWindow.fromWebContents(event.sender) == null || !event.sender.getURL().startsWith('file:') || !event.sender.getURL().endsWith('/trace.html')) throw new Error('Not the trace window');
      return handler(...args);
    };
    ipcMain.handle('trace:list', fromTrace(() => traceWindow.list()));
    ipcMain.handle('trace:save', fromTrace((html) => traceWindow.save(html)));
    ipcMain.handle('trace:reveal', fromTrace(() => traceWindow.revealFolder()));
    app.on('will-quit', () => connect.suspendAll());
    registerEngelbartIpc({
      // Test mode's reset (2026-10-15): what the app keeps outside the data root forgotten too, so onboarding's popups and
      // sign-ins come back: the sign-in answers in memory, a pretend machine's installs, and (a copy run from a checkout,
      // whose browser is its own) the sign-ins copied into Engelbart's browser. A packaged copy's browser is left alone: it
      // may be the one the person works in.
      afterTestReset: async () => {
        try { if (webSignIn && webSignIn.forget) webSignIn.forget(); } catch { /* nothing kept */ }
        if (toolsFake && toolsFake.reset) { toolsFake.reset(); try { await tools.check(); } catch { /* checked again later */ } }
        if (!app.isPackaged) await electronSession.fromPartition(BROWSER_PARTITION).clearStorageData().catch(() => {});
      },
      agentMap,
      // A page @create made, as a picture for its row (2026-10-14, bart/created-preview.cjs).
      snapshotHtml: createSnapshotter({ BrowserWindow }),
      scanner,
      onboarding: { prefs, providers: onboardingProviders, browsers: onboardingBrowsers, browserAgents, discovery, diskAccess, openTrace: () => traceWindow.open() },
      connect,
      connectors,
      appleNotes,
      connectSignedIn,
      warmBrowsers: () => (process.platform === 'darwin' ? installedApps.ask() : undefined),
      // Made below, after this: the window's update banner asks for it when it is used.
      getUpdates: () => updates,
      github,
      openGithubPage,
      zotero,
      zoteroLibrary,
      identifyRepo: createRepoIdentifier({ auth: github.authHeaders }),
      listRemoteFiles: createRemoteFileLister({ auth: github.authHeaders }),
      ipcMain,
      trustedHandler,
      // Several windows: which one called, an answer to it alone, and what it saved told to every other.
      windowHandler,
      reply: (ctx, channel, payload) => windows.deliver(ctx, channel, payload),
      announce: (channel, payload, options) => windows.broadcast(channel, payload, options),
      store,
      beforeContextChange: () => Promise.all(windows.all().map((ctx) => ctx.postItViews.activate(null))),
      openExternal: async (value) => {
        await electronShell.openExternal(parseExternalUrl(value).href);
        return true;
      },
      revealItem: (target) => {
        electronShell.showItemInFolder(target);
        return true;
      },
      writeClipboard: (text) => clipboard.writeText(text),
      // Electron 44's clipboard is the W3C one (write([ClipboardItem]), async): writeImage is gone, so the picture goes as a PNG.
      writeImage: async (buf) => { const img = require('electron').nativeImage.createFromBuffer(buf); if (img.isEmpty()) return false; await clipboard.write([new (require('electron').ClipboardItem)({ 'image/png': new Blob([img.toPNG()], { type: 'image/png' }) })]); return true; },
      bart,
      builds,
      sandbox,
      readModels,
      menuModels,
      nameChat,
      rememberModelChoice,
      modelSettings,
      tools,
      pdfAdded,
      // A link dropped onto the library or a workspace is read with the Stage's cookies, as a saved-as-link pdf is (fetchPdf).
      fetchUrl: (url, init) => electronSession.fromPartition(BROWSER_PARTITION).fetch(url, init),
      // The Stage's Save of a web page (add-library-page): the calling window's tab, as it shows now, into the library's folder.
      savePageFor: (ctx, tabId, dir) => {
        if (!ctx || !ctx.browserViews) throw new Error('No window for the browser');
        return ctx.browserViews.savePage(tabId, dir);
      },
      // An @bart turn with a web page in front (MATH-54 build 3a): the calling window's tab, for its selection and picture.
      stagePageFor: (ctx, tabId) => (ctx && ctx.browserViews && ctx.browserViews.has(tabId)
        ? { selection: () => ctx.browserViews.pageSelection(tabId), screenshot: () => ctx.browserViews.screenshot(tabId) }
        : null),
      // An @bart turn (MATH-65): the calling window's Overleaf tabs, the one in front read live, every project's copy refreshed.
      overleafFor: (ctx, stage) => (ctx && ctx.browserViews
        ? overleafStage.forTurn({ tabs: ctx.browserViews.overleafTabs(), read: (id) => ctx.browserViews.readOverleaf(id) }, stage)
        : null),
      notify: sendToRenderer,
      // "Choose from disk…" in the sidebar's + menu: files and folders together, several at once (macOS allows both in one panel).
      // Onboarding's Papers step asks for pdfs only (`kind` 'pdf').
      pickPaths: async (kind) => {
        if (process.env.ENGELBART_PICK_PATHS) return JSON.parse(process.env.ENGELBART_PICK_PATHS); // driver harness only (scripts/drive.mjs)
        const options = kind === 'pdf'
          ? { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Papers', extensions: ['pdf'] }] }
          : { properties: ['openFile', 'openDirectory', 'multiSelections'] };
        const parent = dialogWindow();
        const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
        return result.canceled ? [] : result.filePaths;
      },
      confirmReset: async ({ fresh = false } = {}) => {
        if (process.env.ENGELBART_CONFIRM_ALL === '1') return true; // driver harness only (scripts/drive.mjs)
        const options = {
          type: 'warning',
          buttons: [fresh ? 'Start as a new user' : 'Reset test data', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          title: fresh ? 'Start as a new user?' : 'Reset test data?',
          message: 'Delete everything under ~/.engelbart/test?',
          detail: fresh
            ? 'Projects, notes, the test library, custom instructions and test mode\'s GitHub sign-in are removed, and onboarding starts. Your real ~/.engelbart is not touched.'
            : 'Projects, notes, the test library and paper annotations are removed. The library is seeded again on the next start.',
          noLink: true,
        };
        const parent = dialogWindow();
        const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
        return result.response === 0;
      },
    });
    // The reveal a window was told of, taken once by the Workspace of its project (agentMap:reveal above).
    ipcMain.handle('engelbart:agentMap:take-reveal', windowHandler((ctx, projectId) => {
      const held = ctx.agentReveal;
      if (!held || held.place.projectId !== projectId) return null;
      ctx.agentReveal = null;
      return held;
    }));
    registerAgentMapIpc({
      ipcMain,
      trustedHandler,
      mapWindow: agentMap,
      runLog,
      context: () => store.context(),
      design: () => agentDesign({ dataRoot: store.config().dataRoot, models: readModels('bart'), buildModels: readModels('build') }),
      // The Benchmark tab (2026-10-13): Chat's questions in the notes asked again under its prompt now, read-only tools.
      benchmark: developer ? createChatBenchmark({
        file: path.join(app.getPath('userData'), 'chat-benchmark.json'),
        context: () => store.context(),
        runLog,
        chat: askChat({ readModels: () => readModels('bart'), runDirectory: path.join(app.getPath('userData'), 'benchmark-runs'), codexHome: path.join(app.getPath('userData'), 'codex-home-benchmark'), tools, ...(process.env.ENGELBART_BART_FAKE === '1' ? { makeBart: createFakeBart } : {}) }),
      }) : null,
      // A row clicked (2026-10-12): the window on the ask's project comes to the front, else the focused one (which opens
      // the project; App.jsx), and is told where. It is also kept on the window, for a Workspace that mounts after the
      // event went by (agentMap:take-reveal).
      reveal: (target) => {
        const ctx = windows.showing(target.place.projectId) || focusedWindow() || openWindow();
        if (!ctx || ctx.win.isDestroyed()) return false;
        ctx.agentReveal = target;
        if (ctx.win.isMinimized()) ctx.win.restore();
        ctx.win.show();
        ctx.win.focus();
        windows.send(ctx, 'engelbart:agent-reveal', target);
        return true;
      },
      // The map's export: a page of its own, saved where the person picks.
      saveFile: async (text, name) => {
        const parent = agentMap.window();
        const options = { defaultPath: path.join(app.getPath('downloads'), name), filters: [{ name: 'Web page', extensions: ['html'] }] };
        const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
        if (result.canceled || !result.filePath) return null;
        await fs.promises.writeFile(result.filePath, text);
        return result.filePath;
      },
    });
    // New versions (updates.cjs): only in a packaged app built with a download folder. ENGELBART_UPDATES=off stops it.
    // The menu's item and every window's banner (ui/UpdateBanner.jsx, on every screen) follow its state.
    updates = createUpdates({
      app,
      dialog,
      getWindow: () => { const ctx = focusedWindow(); return ctx ? ctx.win : null; },
      requestQuit,
      runningSessions: runningSessionCount,
      onChange: (snapshot) => { buildMenu(); sendToWindow('engelbart:update', snapshot); },
    });
    updates.start();
    buildMenu();
    electronSession.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    // Every window open when the app last quit comes back, where it was; without that list (state.json from before),
    // one window where the app was last.
    let saved = [];
    try { saved = projects.readWindows({ dataRoot: store.config().dataRoot }); } catch { saved = []; }
    if (saved.length) for (const entry of saved) openWindow({ place: entry, bounds: entry.bounds });
    else openWindow();
  }).catch((error) => {
    dialog.showErrorBox('Engelbart failed to start', error.message);
    app.exit(1);
  });
}
