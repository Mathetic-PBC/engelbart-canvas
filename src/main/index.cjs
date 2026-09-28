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
  powerMonitor,
  protocol,
  safeStorage,
  session: electronSession,
  shell: electronShell,
  WebContentsView,
} = require('electron');
const { SessionManager } = require('./terminal/session-manager.cjs');
const { environmentForSessions } = require('./shell-rc.cjs');
const { createSweeper } = require('./context/sweeper.cjs');
const { inspectPdf } = require('./context/pdf-kind.cjs');
const { createCliSummarizer, createFakeSummarizer } = require('./context/summarizer.cjs');
const { createBart, createFakeBart, createThreads } = require('./bart/ask.cjs');
const { loadModels, preferUsable } = require('./bart/models.cjs');
const { resolveShell } = require('./terminal/launch.cjs');
const home = require('./store/home.cjs');
const { createRunner } = require('./tools/run.cjs');
const { detectTools } = require('./tools/detect.cjs');
const { findBundledGit } = require('./tools/bundled-git.cjs');
const { createActions } = require('./tools/install.cjs');
const { createTools } = require('./tools/manager.cjs');
const { createFakeTools } = require('./tools/fake.cjs');
const { createSignInProcess } = require('./tools/sign-in.cjs');
const { SettingsStore } = require('./terminal/settings.cjs');
const { RendererLifecycle, shouldHideWindowOnClose } = require('./terminal/window-lifecycle.cjs');
const { assertTrustedRenderer, parseExternalUrl } = require('./ipc-validation.cjs');
const { createStore, registerEngelbartIpc } = require('./ipc.cjs');
const { PARTITION: BROWSER_PARTITION, createBrowserViews, registerBrowserIpc } = require('./browser/views.cjs');
const { createGithub } = require('./github/connection.cjs');
const { createBrowserAuth, CLIENT_ID: GITHUB_CLIENT_ID } = require('./github/browser-auth.cjs');
const { createRepoIdentifier, createRemoteFileLister } = require('./store/page-meta.cjs');
const { checkWebPdfs, readPdfResponse } = require('./store/web-pdfs.cjs');
const { createPostItViews } = require('./post-its/views.cjs');
const { createGit } = require('./build/git.cjs');
const { createBuilds } = require('./build/manager.cjs');
const { createRunner: createBuildRunner, createFakeRunner: createFakeBuildRunner } = require('./build/runner.cjs');
const { EDGES: WINDOW_EDGES, resizedBounds } = require('./window-edges.cjs');
const { hasTestMode } = require('./developer.cjs');
const { createUpdates } = require('./updates.cjs');

const DIST = path.join(__dirname, '../../dist');
const FIXTURES = path.join(__dirname, '../../fixtures');
const PRELOAD_FILE = path.join(__dirname, '../preload.cjs');
const APP_URL = 'engelbart://app/index.html';
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

let mainWindow = null;
let manager = null;
let rendererLifecycle = null;
let settings = null;
let store = null;
let sweeper = null;
let bart = null;
let builds = null;
let tools = null;
let browserViews = null;
let postItViews = null;
let updates = null;
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

function sendToRenderer(channel, payload) {
  return rendererLifecycle ? rendererLifecycle.send(mainWindow, channel, payload) : false;
}

// sendToRenderer waits for the terminal to attach (RendererLifecycle), which never happens on the create and
// all-projects screens; the setup dialog can open on any screen, so its events go to the window directly.
function sendToWindow(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return false;
  try { mainWindow.webContents.send(channel, payload); return true; } catch { return false; }
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
  return manager.close(id);
}

async function requestQuit() {
  if (quitPending || quitReady) return;
  quitPending = true;
  const runningCount = manager ? manager.list().filter((entry) => entry.status === 'running').length : 0;
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
    const dialogParent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    if (dialogParent && !dialogParent.isVisible()) {
      dialogParent.show();
      dialogParent.focus();
    }
    const result = dialogParent
      ? await dialog.showMessageBox(dialogParent, options)
      : await dialog.showMessageBox(options);
    if (result.response !== 0) {
      quitPending = false;
      return;
    }
  }
  try {
    if (sweeper) await sweeper.stop();
    if (bart) bart.stopAll();
    if (builds) await builds.stopAll(); // each running turn stops, saves a checkpoint and is marked interrupted
    if (browserViews) await browserViews.flush().catch(() => {});
    if (postItViews) await postItViews.activate(null);
    if (manager) await manager.shutdown();
    if (store) await store.close();
  } catch (error) {
    quitPending = false;
    dialog.showErrorBox('Unable to shut down cleanly', error.message);
    return;
  }
  quitReady = true;
  app.quit();
}

function registerTerminalIpc() {
  ipcMain.handle('terminal:bootstrap', trustedHandler(async () => {
    const sessions = rendererLifecycle.bootstrap(() => manager.list());
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
  ipcMain.handle('terminal:create', trustedHandler((request) => manager.create({
    provider: request && request.provider,
    cwd: request && request.cwd,
    cols: request && request.cols,
    rows: request && request.rows,
  })));
  ipcMain.handle('terminal:write', trustedHandler((id, data) => {
    manager.write(id, data);
    return true;
  }));
  ipcMain.handle('terminal:resize', trustedHandler((id, cols, rows) => {
    manager.resize(id, cols, rows);
    return true;
  }));
  ipcMain.handle('terminal:close', trustedHandler((id) => closeSession(id)));
  // The renderer's resize strips: a press names the edge, every move after it re-reads the cursor (2026-09-23).
  let edgeResize = null; // { edge, start: bounds, from: cursor point }
  ipcMain.on('window:edge-resize', (event, phase, edge) => {
    try {
      assertTrustedRenderer(event, APP_URL);
      if (!mainWindow || mainWindow.isFullScreen()) return;
      const cursor = require('electron').screen.getCursorScreenPoint();
      if (phase === 'start' && WINDOW_EDGES.has(edge)) edgeResize = { edge, start: mainWindow.getBounds(), from: cursor };
      else if (phase === 'move' && edgeResize) {
        const [width, height] = mainWindow.getMinimumSize();
        mainWindow.setBounds(resizedBounds(edgeResize.start, edgeResize.edge, cursor.x - edgeResize.from.x, cursor.y - edgeResize.from.y, { width, height }));
      } else if (phase === 'end') edgeResize = null;
    } catch {
      // A send-only gesture is deliberately ignored when malformed.
    }
  });
  ipcMain.on('terminal:acknowledge', (event, id, sequence) => {
    try {
      assertTrustedRenderer(event, APP_URL);
      manager.acknowledge(id, sequence);
    } catch {
      // A send-only acknowledgement is deliberately ignored when malformed.
    }
  });
  ipcMain.handle('terminal:pick-directory', trustedHandler(async (current) => {
    // Start in the home directory, never in Engelbart's own data folder (where the last terminal may have been).
    let defaultPath = app.getPath('home');
    if (typeof current === 'string' && current.length <= 4096) {
      try {
        if (fs.statSync(current).isDirectory()) defaultPath = current;
      } catch {
        // Fall back to the persisted valid directory.
      }
    }
    const result = await dialog.showOpenDialog(mainWindow, {
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

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        ...(updates && updates.enabled ? [updates.menuItem()] : []),
        { type: 'separator' },
        { label: 'Set Up Tools…', click: () => sendToWindow('engelbart:tools-open', {}) },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { label: `Quit ${app.name}`, accelerator: 'Cmd+Q', click: requestQuit },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Reveal Engelbart Folder', click: () => electronShell.showItemInFolder(store ? store.layout.root : app.getPath('home')) },
        ...(isMac ? [] : [{ label: 'Set Up Tools…', click: () => sendToWindow('engelbart:tools-open', {}) }]),
        { type: 'separator' },
        ...(isMac ? [{ role: 'close', label: 'Close Window', accelerator: 'Cmd+Shift+W' }] : [{ label: 'Quit', accelerator: 'Ctrl+Q', click: requestQuit }]),
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
            { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: () => { if (browserViews) browserViews.shortcut('find'); } },
            { label: 'Find Next', accelerator: 'CmdOrCtrl+G', click: () => { if (browserViews) browserViews.shortcut('find-next'); } },
            { label: 'Find Previous', accelerator: 'Shift+CmdOrCtrl+G', click: () => { if (browserViews) browserViews.shortcut('find-previous'); } },
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
        { role: 'togglefullscreen' },
      ],
    },
    ...(isMac ? [{ role: 'windowMenu' }] : []),
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  mainWindow = new BrowserWindow({
    show: process.env.ENGELBART_HEADLESS !== '1', // isolated automated checks; never take desktop focus
    width: 1440,
    height: 900,
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
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      void electronShell.openExternal(parseExternalUrl(url).href).catch(() => {});
    } catch {
      // Untrusted schemes remain closed.
    }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) event.preventDefault();
  });
  // The renderer's browser tabs live in its memory: when the page goes, their views go with it.
  mainWindow.webContents.on('did-start-loading', () => { rendererLifecycle.detach(); browserViews.closeAll(); void postItViews.activate(null).catch(console.error); });
  mainWindow.webContents.on('render-process-gone', () => { rendererLifecycle.detach(); void postItViews.activate(null).catch(console.error); });
  mainWindow.on('resize', () => postItViews.layout());
  // The header clears the traffic lights only while they are there (preload marks <html data-fullscreen>).
  const sendFullScreen = () => { if (mainWindow) mainWindow.webContents.send('window:fullscreen', mainWindow.isFullScreen()); };
  mainWindow.on('enter-full-screen', sendFullScreen);
  mainWindow.on('leave-full-screen', sendFullScreen);
  mainWindow.webContents.on('did-finish-load', sendFullScreen);
  mainWindow.on('blur', () => postItViews.cancelGesture());
  mainWindow.on('close', (event) => {
    if (shouldHideWindowOnClose(process.platform, quitReady)) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => {
    rendererLifecycle.detach();
    browserViews.closeAll();
    void postItViews.activate(null).catch(console.error);
    mainWindow = null;
  });
  mainWindow.loadURL(APP_URL);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', createWindow);
  app.on('before-quit', (event) => {
    if (quitReady) return;
    event.preventDefault();
    requestQuit();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') requestQuit();
  });
  app.on('activate', createWindow);
  app.whenReady().then(() => {
    registerProtocol();
    manager = new SessionManager({ environment: environmentForSessions(process.env, app.getPath('userData')), extraEnvironment: () => (tools ? tools.environment() : {}) });
    rendererLifecycle = new RendererLifecycle(manager);
    rendererLifecycle.detach();
    settings = new SettingsStore(app.getPath('userData'), app.getPath('home'));
    const homeDir = process.env.ENGELBART_HOME_DIR || app.getPath('home');
    // Pdfs saved as links before the Stage kept copies: every library that opens is checked, and what is left is
    // downloaded in the background with the Stage's cookies (a paper behind a sign-in comes too). ENGELBART_WEB_PDFS=off
    // disables it (scripted runs).
    let changedTimer = null;
    const libraryChanged = () => { clearTimeout(changedTimer); changedTimer = setTimeout(() => sendToWindow('engelbart:library-changed', {}), 400); };
    const fetchPdf = async (url) => readPdfResponse(await electronSession.fromPartition(BROWSER_PARTITION).fetch(url, { signal: AbortSignal.timeout(120000) }));
    const afterOpen = process.env.ENGELBART_WEB_PDFS === 'off' ? null
      : (ctx) => checkWebPdfs(ctx, { fetchPdf, inspectPdf, onChange: libraryChanged, log: (line) => console.warn(`[engelbart] ${line}`) });
    // Test mode only in a developer's copy: run from a checkout, or packaged by `npm run relaunch` (./developer.cjs).
    store = createStore({ homeDir, rootDir: process.env.ENGELBART_ROOT_DIR || null, fixturesDir: FIXTURES, inspectPdf, afterOpen, testMode: hasTestMode({ packaged: app.isPackaged, distDir: DIST, env: process.env }) });
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
      installAtLaunch: ['claude'],
      onChange: (snapshot) => sendToWindow('engelbart:tools', snapshot),
    });
    if (process.env.ENGELBART_TOOLS !== 'off') void tools.start().catch((error) => console.warn(`[engelbart] tool check: ${error.message}`));
    // Catalog summaries (src/main/context): swept once a minute while the app is open, at launch,
    // and when the computer wakes. ENGELBART_SUMMARIES=off disables it; the _FAKE / _QUIET_MS /
    // _INTERVAL_MS variables exist for scripted runs only.
    const millis = (name) => { const value = Number(process.env[name]); return Number.isFinite(value) && value > 0 ? value : undefined; };
    sweeper = createSweeper({
      getContext: () => store.context(),
      summarize: process.env.ENGELBART_SUMMARY_FAKE === '1'
        ? createFakeSummarizer()
        : createCliSummarizer({ readSettings: () => store.config().summarizer, runDirectory: path.join(app.getPath('userData'), 'context-runs'), codexHome: path.join(app.getPath('userData'), 'codex-home'), tools }),
      quietMs: millis('ENGELBART_SUMMARY_QUIET_MS'),
      intervalMs: millis('ENGELBART_SUMMARY_INTERVAL_MS'),
    });
    // @bart (src/main/bart): hidden Claude Code or Codex runs on the person's subscription, reading only. It starts on
    // the saved default provider, or on the other one while the saved one's CLI cannot run (preferUsable).
    // ENGELBART_BART_FAKE=1 answers without a model, for scripted runs only.
    const readModels = () => preferUsable(loadModels(store.layout.root, { only: store.config().providers }), tools.usableAgents());
    bart = process.env.ENGELBART_BART_FAKE === '1'
      ? createFakeBart({ readModels, threads: createThreads({ file: path.join(app.getPath('userData'), 'bart-threads.json') }) })
      : createBart({ readModels, runDirectory: path.join(app.getPath('userData'), 'bart-runs'), codexHome: path.join(app.getPath('userData'), 'codex-home-bart'), threads: createThreads({ file: path.join(app.getPath('userData'), 'bart-threads.json') }), tools });
    if (process.env.ENGELBART_SUMMARIES !== 'off') {
      sweeper.start();
      powerMonitor.on('resume', () => sweeper.sweepSoon());
    }
    // Build (src/main/build): a workspace handed to Claude Code or Codex in a git worktree of its own, writing only there.
    // Git is the one the tool check found; a scripted run with the check off (ENGELBART_TOOLS=off) uses PATH's.
    // ENGELBART_BUILD_FAKE=1 runs the fake agent (git and records stay real), for scripted runs only.
    const gitRecord = () => tools.snapshot().tools.git;
    const gitReady = () => process.env.ENGELBART_TOOLS === 'off' || (gitRecord().installed && gitRecord().status === 'ready');
    builds = createBuilds({
      git: createGit({ gitPath: () => { const record = gitRecord(); return record.status === 'ready' && record.path ? record.path : 'git'; } }),
      runner: process.env.ENGELBART_BUILD_FAKE === '1'
        ? createFakeBuildRunner({ delayMs: Number(process.env.ENGELBART_BUILD_FAKE_MS) || 900 }) // _MS: how long a fake turn takes
        : createBuildRunner({ runDirectory: path.join(app.getPath('userData'), 'build-runs'), codexHome: path.join(app.getPath('userData'), 'codex-home-build'), tools }),
      readModels,
      // A quick task's changes also reach the post-it it came from (post-its/views.cjs).
      notify: (channel, payload) => { sendToRenderer(channel, payload); if (channel === 'engelbart:build' && payload && payload.postItId && postItViews) postItViews.buildState(payload); },
      tools,
      gitReady,
    });
    // Records a closed app left working are interrupted (Resume goes on), before anything lists them.
    store.context().then((ctx) => builds.reconcile(ctx)).catch(() => {});
    manager.on('data', (payload) => sendToRenderer('terminal:data', payload));
    manager.on('exit', (payload) => sendToRenderer('terminal:exit', payload));
    registerTerminalIpc();
    postItViews = createPostItViews({
      electron: { WebContentsView, clipboard, shell: electronShell },
      getWindow: () => mainWindow,
      getContext: () => store.context(),
      send: sendToRenderer,
      buildFor: async (projectId, postItId) => {
        const list = builds.list(await store.context(), projectId).filter((task) => task.postItId === postItId);
        return list[list.length - 1] || null;
      },
    });
    postItViews.register({ ipcMain, trustedHandler });
    browserViews = createBrowserViews({
      electron: { WebContentsView, session: electronSession, Menu, clipboard, dialog, shell: electronShell },
      getWindow: () => mainWindow,
      send: sendToRenderer,
      appName: app.getName(),
      fileRoot: () => homeDir,
      onLayerChange: () => postItViews.raise(),
    });
    registerBrowserIpc({ ipcMain, trustedHandler, views: browserViews });
    // GitHub (src/main/github): default-browser sign-in with an automatic loopback return, and the token
    // that lets the library read private repositories. ENGELBART_GITHUB_* name a fake GitHub, for scripted runs only.
    const githubWeb = process.env.ENGELBART_GITHUB_WEB || null;
    const openGithubPage = (url) => electronShell.openExternal(parseExternalUrl(url).href);
    const githubBrowserAuth = createBrowserAuth({ ...(process.env.ENGELBART_GITHUB_BROKER ? { broker: process.env.ENGELBART_GITHUB_BROKER } : {}) });
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
      browserAuth: () => (process.env.ENGELBART_GITHUB_CLIENT_ID || (store.config().github || {}).clientId) === GITHUB_CLIENT_ID ? githubBrowserAuth : null,
      onConnected: () => { if (mainWindow && !mainWindow.isDestroyed()) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } },
      onChange: (status) => sendToWindow('engelbart:github', status),
      ...(githubWeb ? { web: githubWeb, api: process.env.ENGELBART_GITHUB_API || githubWeb } : {}),
    });
    registerEngelbartIpc({
      github,
      openGithubPage,
      identifyRepo: createRepoIdentifier({ auth: github.authHeaders }),
      listRemoteFiles: createRemoteFileLister({ auth: github.authHeaders }),
      ipcMain,
      trustedHandler,
      store,
      beforeContextChange: () => postItViews.activate(null),
      openExternal: async (value) => {
        await electronShell.openExternal(parseExternalUrl(value).href);
        return true;
      },
      revealItem: (target) => {
        electronShell.showItemInFolder(target);
        return true;
      },
      writeClipboard: (text) => clipboard.writeText(text),
      bart,
      builds,
      readModels,
      tools,
      notify: sendToRenderer,
      // "Choose from disk…" in the sidebar's + menu: files and folders together, several at once (macOS allows both in one panel).
      // Onboarding's Papers step asks for pdfs only (`kind` 'pdf').
      pickPaths: async (kind) => {
        if (process.env.ENGELBART_PICK_PATHS) return JSON.parse(process.env.ENGELBART_PICK_PATHS); // driver harness only (scripts/drive.mjs)
        const options = kind === 'pdf'
          ? { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Papers', extensions: ['pdf'] }] }
          : { properties: ['openFile', 'openDirectory', 'multiSelections'] };
        const result = mainWindow && !mainWindow.isDestroyed() ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
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
        const result = mainWindow && !mainWindow.isDestroyed()
          ? await dialog.showMessageBox(mainWindow, options)
          : await dialog.showMessageBox(options);
        return result.response === 0;
      },
    });
    // New versions (updates.cjs): only in a packaged app built with a download folder. ENGELBART_UPDATES=off stops it.
    updates = createUpdates({ app, dialog, getWindow: () => mainWindow, requestQuit, onChange: () => buildMenu() });
    updates.start();
    buildMenu();
    electronSession.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    createWindow();
  }).catch((error) => {
    dialog.showErrorBox('Engelbart failed to start', error.message);
    app.exit(1);
  });
}
