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
const { loadModels } = require('./bart/models.cjs');
const { resolveShell } = require('./terminal/launch.cjs');
const { createProviderStatus } = require('./terminal/provider-discovery.cjs');
const { SettingsStore } = require('./terminal/settings.cjs');
const { RendererLifecycle, shouldHideWindowOnClose } = require('./terminal/window-lifecycle.cjs');
const { assertTrustedRenderer, parseExternalUrl } = require('./ipc-validation.cjs');
const { createStore, registerEngelbartIpc } = require('./ipc.cjs');
const { createBrowserViews, registerBrowserIpc } = require('./browser/views.cjs');

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
let providerStatus = null;
let browserViews = null;
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
    if (browserViews) await browserViews.flush().catch(() => {});
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
  ipcMain.handle('terminal:providers', trustedHandler(() => providerStatus.get()));
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
        { type: 'separator' },
        ...(isMac ? [{ role: 'close', label: 'Close Window', accelerator: 'Cmd+Shift+W' }] : [{ label: 'Quit', accelerator: 'Ctrl+Q', click: requestQuit }]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
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
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#ffffff',
    title: 'Engelbart',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
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
  mainWindow.webContents.on('did-start-loading', () => { rendererLifecycle.detach(); browserViews.closeAll(); });
  mainWindow.webContents.on('render-process-gone', () => rendererLifecycle.detach());
  mainWindow.on('close', (event) => {
    if (shouldHideWindowOnClose(process.platform, quitReady)) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => {
    rendererLifecycle.detach();
    browserViews.closeAll();
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
    manager = new SessionManager({ environment: environmentForSessions(process.env, app.getPath('userData')) });
    rendererLifecycle = new RendererLifecycle(manager);
    rendererLifecycle.detach();
    settings = new SettingsStore(app.getPath('userData'), app.getPath('home'));
    // Which CLIs are installed and signed in: checked at every launch, in the background.
    providerStatus = createProviderStatus(process.env);
    void providerStatus.refresh().catch(() => {});
    const homeDir = process.env.ENGELBART_HOME_DIR || app.getPath('home');
    store = createStore({ homeDir, fixturesDir: FIXTURES, inspectPdf });
    // Catalog summaries (src/main/context): swept once a minute while the app is open, at launch,
    // and when the computer wakes. ENGELBART_SUMMARIES=off disables it; the _FAKE / _QUIET_MS /
    // _INTERVAL_MS variables exist for scripted runs only.
    const millis = (name) => { const value = Number(process.env[name]); return Number.isFinite(value) && value > 0 ? value : undefined; };
    sweeper = createSweeper({
      getContext: () => store.context(),
      summarize: process.env.ENGELBART_SUMMARY_FAKE === '1'
        ? createFakeSummarizer()
        : createCliSummarizer({ readSettings: () => store.config().summarizer, runDirectory: path.join(app.getPath('userData'), 'context-runs'), codexHome: path.join(app.getPath('userData'), 'codex-home') }),
      quietMs: millis('ENGELBART_SUMMARY_QUIET_MS'),
      intervalMs: millis('ENGELBART_SUMMARY_INTERVAL_MS'),
    });
    // @bart (src/main/bart): hidden Claude Code or Codex runs on the person's subscription, reading only.
    // ENGELBART_BART_FAKE=1 answers without a model, for scripted runs only.
    const readModels = () => loadModels(store.layout.root, { only: store.config().providers });
    bart = process.env.ENGELBART_BART_FAKE === '1'
      ? createFakeBart({ readModels, threads: createThreads({ file: path.join(app.getPath('userData'), 'bart-threads.json') }) })
      : createBart({ readModels, runDirectory: path.join(app.getPath('userData'), 'bart-runs'), codexHome: path.join(app.getPath('userData'), 'codex-home-bart'), threads: createThreads({ file: path.join(app.getPath('userData'), 'bart-threads.json') }) });
    if (process.env.ENGELBART_SUMMARIES !== 'off') {
      sweeper.start();
      powerMonitor.on('resume', () => sweeper.sweepSoon());
    }
    manager.on('data', (payload) => sendToRenderer('terminal:data', payload));
    manager.on('exit', (payload) => sendToRenderer('terminal:exit', payload));
    registerTerminalIpc();
    browserViews = createBrowserViews({
      electron: { WebContentsView, session: electronSession, Menu, clipboard, dialog, shell: electronShell },
      getWindow: () => mainWindow,
      send: sendToRenderer,
      appName: app.getName(),
      fileRoot: () => homeDir,
    });
    registerBrowserIpc({ ipcMain, trustedHandler, views: browserViews });
    registerEngelbartIpc({
      ipcMain,
      trustedHandler,
      store,
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
      readModels,
      notify: sendToRenderer,
      confirmReset: async () => {
        if (process.env.ENGELBART_CONFIRM_ALL === '1') return true; // driver harness only (scripts/drive.mjs)
        const options = {
          type: 'warning',
          buttons: ['Reset test data', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          title: 'Reset test data?',
          message: 'Delete everything under ~/.engelbart/test?',
          detail: 'Projects, notes, the test library and paper annotations are removed. The library is seeded again on the next start.',
          noLink: true,
        };
        const result = mainWindow && !mainWindow.isDestroyed()
          ? await dialog.showMessageBox(mainWindow, options)
          : await dialog.showMessageBox(options);
        return result.response === 0;
      },
    });
    buildMenu();
    electronSession.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    createWindow();
  }).catch((error) => {
    dialog.showErrorBox('Engelbart failed to start', error.message);
    app.exit(1);
  });
}
