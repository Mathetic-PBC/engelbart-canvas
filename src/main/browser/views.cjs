'use strict';

// The Browser pane's pages (decision 48). Each browser tab is a WebContentsView: a native view
// with its own top-level webContents, laid over a placeholder the renderer measures. A page is
// therefore never framed, so X-Frame-Options and CSP frame-ancestors do not apply to it, and
// web security stays on. Pages get no preload and live in their own persistent session, apart
// from the app's. Electron is passed in so the rules below can be tested without it.
//
// Signing in (decision 49): a page that opens a window keeps its opener, because OAuth and 2FA
// flows finish by talking back to it (postMessage, then window.close()). A popup (window.open
// with features) is a real child window, as in Chrome; any other new window is a tab whose view
// is built around the webContents Chromium already made. HTTP authentication asks the person.
// So do camera, microphone, location, notifications and reading the clipboard (once per site per
// run), and a link into another app (slack://, vscode://): sign-ins to desktop apps end on one.
//
// Pages on disk (decision 51): a file: address opens when the file is inside the home directory,
// the same line the text viewer draws. The person can type one and a page on disk can link to
// another; a page from the web can do neither.

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

const PARTITION = 'persist:browser';
const ERR_ABORTED = -3;
const SNAPSHOT_TIMEOUT_MS = 250;
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write']);
const WEB_PREFERENCES = Object.freeze({ partition: PARTITION, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true });
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const COOKIE_FLUSH_MS = 1000;
const ASKED_PERMISSIONS = { media: 'the camera or microphone', geolocation: 'your location', notifications: 'notifications', 'clipboard-read': 'the clipboard' };
// Never handed to another app: these either reach into this one or are not addresses at all.
const INTERNAL_SCHEMES = new Set(['http:', 'https:', 'file:', 'about:', 'blob:', 'data:', 'javascript:', 'chrome:', 'devtools:', 'view-source:', 'engelbart:']);

/** http(s) only. 0.0.0.0 is what dev servers print, not an address to visit. */
function parseBrowserUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8192) throw new TypeError('URL must be a bounded string');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('URL is invalid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TypeError('URL protocol must be http or https');
  if (url.hostname === '0.0.0.0') url.hostname = 'localhost';
  return url;
}

/** A file: address inside `root`, links followed. A file that is not there yet is judged by where it would be. */
function parseFileUrl(value, root) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8192) throw new TypeError('URL must be a bounded string');
  let url;
  let target;
  try {
    url = new URL(value);
    if (url.protocol !== 'file:' || url.hostname) throw new TypeError('not a local file');
    target = fileURLToPath(url);
  } catch {
    throw new TypeError('URL is invalid');
  }
  if (typeof root !== 'string' || !root) throw new TypeError('Files cannot be opened here');
  const real = (file) => { try { return fs.realpathSync(file); } catch { return path.resolve(file); } };
  const home = real(root);
  const resolved = real(target);
  if (resolved !== home && !resolved.startsWith(home + path.sep)) throw new TypeError('Only files inside your home directory can be opened');
  return url;
}

const isFileUrl = (value) => /^file:/i.test(String(value || ''));

/** `slack://…`, `mailto:…`: an address some other app owns. */
function externalScheme(value) {
  try {
    const url = new URL(String(value));
    return INTERNAL_SCHEMES.has(url.protocol) ? '' : url.protocol;
  } catch {
    return '';
  }
}

function originOf(value) {
  try { return new URL(String(value)).origin; } catch { return ''; }
}

/** This machine only: the one place a self-signed certificate is accepted. */
function isLoopback(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
}

/** Sites sniff "Electron/x" and the app's own token and serve a refusal; a page here is Chromium. */
function cleanUserAgent(userAgent, appName) {
  const names = ['Electron', appName].filter(Boolean).map((name) => String(name).replace(/[^\w.-]/g, ''));
  return String(userAgent || '').replace(new RegExp(` (?:${names.join('|')})/\\S+`, 'gi'), '');
}

function boundsFrom(rect, zoom) {
  if (!rect || typeof rect !== 'object') throw new TypeError('Bounds are required');
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const out = {};
  for (const key of ['x', 'y', 'width', 'height']) {
    const value = Number(rect[key]);
    if (!Number.isFinite(value) || Math.abs(value) > 100000) throw new TypeError('Bounds must be finite numbers');
    out[key] = Math.round(value * scale);
  }
  out.width = Math.max(1, out.width);
  out.height = Math.max(1, out.height);
  return out;
}

function createBrowserViews({ electron, getWindow, send, appName, fileRoot }) {
  const { WebContentsView, session, Menu, clipboard, dialog, shell } = electron;
  const decided = new Map(); // `${origin} ${permission}` -> the person's answer, for this run
  const entries = new Map(); // tab id -> { view, error, requested, pending, seq }
  const popups = new Set(); // child windows opened by pages
  const logins = new Map(); // request id -> answer(credentials | null)
  let counter = 0;
  const nextId = (prefix) => `${prefix}-${Date.now().toString(36)}-${(counter += 1)}`;
  let configured = false;

  const pageUrl = (value) => (isFileUrl(value) ? parseFileUrl(value, fileRoot ? fileRoot() : '') : parseBrowserUrl(value));

  /** Where `contents` may go: http(s) from anywhere; the disk only from a page already on it. */
  function allowed(value, contents) {
    if (value === 'about:blank') return true;
    try {
      if (isFileUrl(value) && !(contents && isFileUrl(contents.getURL()))) return false;
      pageUrl(value);
      return true;
    } catch {
      return false;
    }
  }

  function configureSession() {
    if (configured) return;
    configured = true;
    const browsing = session.fromPartition(PARTITION);
    browsing.setUserAgent(cleanUserAgent(browsing.getUserAgent(), appName));
    browsing.setPermissionRequestHandler((contents, permission, callback, details) => { void decide(contents, permission, details).then(callback, () => callback(false)); });
    // Sign-ins are cookies, and Chromium writes them lazily: a relaunch is a kill, not a quit.
    let timer = null;
    browsing.cookies.on('changed', () => {
      if (timer) return;
      timer = setTimeout(() => { timer = null; browsing.cookies.flushStore().catch(() => {}); }, COOKIE_FLUSH_MS);
      if (typeof timer.unref === 'function') timer.unref();
    });
  }

  async function ask(message, detail, yes) {
    const win = getWindow();
    const options = { type: 'question', buttons: [yes, 'Don\u2019t Allow'], defaultId: 1, cancelId: 1, message, detail, noLink: true };
    const result = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    return result.response === 0;
  }

  async function decide(contents, permission, details) {
    if (ALLOWED_PERMISSIONS.has(permission)) return true;
    const what = ASKED_PERMISSIONS[permission];
    const origin = originOf((details && details.requestingUrl) || (contents && contents.getURL()));
    if (!what || !origin) return false;
    const key = `${origin} ${permission}`;
    if (!decided.has(key)) decided.set(key, ask(`Allow ${origin} to use ${what}?`, '', 'Allow'));
    return decided.get(key);
  }

  let handing = false; // one question at a time, however often a page tries
  async function handOver(url) {
    const scheme = externalScheme(url);
    if (!scheme || handing || String(url).length > 8192) return;
    handing = true;
    try {
      if (await ask(`Open this ${scheme}// link in its app?`, String(url).slice(0, 300), 'Open')) await shell.openExternal(String(url)).catch(() => {});
    } finally {
      handing = false;
    }
  }

  function assertId(id) {
    if (typeof id !== 'string' || id.length === 0 || id.length > 128) throw new TypeError('Tab id must be a bounded string');
  }

  function emit(id) {
    const entry = entries.get(id);
    if (!entry) return;
    const contents = entry.view.webContents;
    send('browser:state', {
      id,
      // Until a page commits, getURL() is still the page before it: report where the tab is headed.
      url: entry.error ? entry.error.url : entry.pending || contents.getURL(),
      title: contents.getTitle(),
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      error: entry.error,
    });
  }

  function focusAddress() {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.focus();
    send('browser:focus-address', {});
  }

  function contextMenu(contents, params, tab) {
    const template = [];
    if (tab && params.linkURL && allowed(params.linkURL, contents)) {
      template.push({ label: 'Open Link in New Tab', click: () => send('browser:open-tab', { url: params.linkURL, from: tab }) });
    }
    if (params.linkURL) template.push({ label: 'Copy Link', click: () => clipboard.writeText(params.linkURL) }, { type: 'separator' });
    if (params.isEditable) template.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' });
    else if (params.selectionText) template.push({ role: 'copy' }, { type: 'separator' });
    template.push({ label: 'Back', enabled: contents.navigationHistory.canGoBack(), click: () => contents.navigationHistory.goBack() });
    template.push({ label: 'Forward', enabled: contents.navigationHistory.canGoForward(), click: () => contents.navigationHistory.goForward() });
    template.push({ label: 'Reload', click: () => { if (tab) command(tab, 'reload'); else contents.reload(); } });
    template.push({ type: 'separator' });
    template.push({ label: 'Inspect Element', click: () => { contents.inspectElement(params.x, params.y); } });
    Menu.buildFromTemplate(template).popup({ window: getWindow() || undefined });
  }

  /** What every page gets, in a tab or in a popup: http(s) or the disk, loopback certificates, a sign-in prompt. */
  function protect(contents, tab) {
    const guard = (event, url) => {
      if (allowed(url, contents)) return;
      event.preventDefault();
      void handOver(url);
    };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
    contents.on('certificate-error', (event, url, _error, _certificate, callback) => {
      let trusted = false;
      try { trusted = isLoopback(new URL(url).hostname); } catch { trusted = false; }
      if (!trusted) return; // Chromium's own refusal stands
      event.preventDefault();
      callback(true);
    });
    contents.on('login', (event, _details, authInfo, callback) => {
      event.preventDefault();
      const requestId = nextId('login');
      const timer = setTimeout(() => answerLogin(requestId, null), LOGIN_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      logins.set(requestId, (credentials) => { clearTimeout(timer); if (credentials) callback(credentials.username, credentials.password); else callback(); });
      const delivered = send('browser:login', { requestId, tab: tab || null, host: String(authInfo.host || ''), realm: String(authInfo.realm || ''), proxy: !!authInfo.isProxy });
      if (delivered === false) answerLogin(requestId, null);
    });
  }

  function answerLogin(requestId, credentials) {
    const answer = logins.get(requestId);
    if (!answer) return false;
    logins.delete(requestId);
    const ok = credentials && typeof credentials.username === 'string' && typeof credentials.password === 'string'
      && credentials.username.length <= 1024 && credentials.password.length <= 1024;
    answer(ok ? { username: credentials.username, password: credentials.password } : null);
    return true;
  }

  /** New windows keep their opener. With features it is a popup; otherwise a tab around the contents Chromium made. */
  function windowOpenHandler(from, contents) {
    return ({ url, disposition }) => {
      if (!allowed(url, contents)) return { action: 'deny' };
      if (disposition === 'new-window') {
        const parent = getWindow();
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            parent: parent && !parent.isDestroyed() ? parent : undefined,
            minWidth: 320, minHeight: 320, // the size is the page's to ask for (window.open features)
            autoHideMenuBar: true, backgroundColor: '#ffffff', fullscreenable: false,
            webPreferences: { ...WEB_PREFERENCES },
          },
        };
      }
      return { action: 'allow', createWindow: (options) => adopt(options, from) };
    };
  }

  // A popup has no address bar, so its title carries the host: the person can see who is asking.
  function watchPopup(popup, from) {
    popups.add(popup);
    const contents = popup.webContents;
    protect(contents, from);
    contents.setWindowOpenHandler(windowOpenHandler(from, contents));
    const title = () => {
      if (popup.isDestroyed()) return;
      let host = '';
      try { host = new URL(contents.getURL()).host; } catch { host = ''; }
      popup.setTitle([host, contents.getTitle()].filter(Boolean).join(' — '));
    };
    contents.on('page-title-updated', (event) => { event.preventDefault(); title(); });
    contents.on('did-navigate', title);
    contents.on('context-menu', (_event, params) => contextMenu(contents, params, null));
    popup.on('closed', () => popups.delete(popup));
  }

  function adopt(options, from) {
    const win = getWindow();
    const view = new WebContentsView({ webContents: options.webContents, webPreferences: { ...WEB_PREFERENCES } });
    const id = nextId('tab');
    attach(id, view, win);
    send('browser:open-tab', { id, url: view.webContents.getURL(), from });
    return view.webContents;
  }

  function create(id) {
    const win = getWindow();
    if (!win || win.isDestroyed()) throw new Error('No window for the browser');
    configureSession();
    return attach(id, new WebContentsView({ webPreferences: { ...WEB_PREFERENCES } }), win);
  }

  function attach(id, view, win) {
    view.setBackgroundColor('#ffffff');
    view.setVisible(false);
    win.contentView.addChildView(view);
    const entry = { view, error: null, requested: '', pending: '', seq: 0 };
    entries.set(id, entry);

    const contents = view.webContents;
    protect(contents, id);
    contents.setWindowOpenHandler(windowOpenHandler(id, contents));
    contents.on('did-create-window', (popup) => watchPopup(popup, id));
    // window.close() from the page (the last step of many sign-ins) closes the tab.
    contents.on('destroyed', () => { if (entries.get(id) === entry) { detach(id); send('browser:closed', { id }); } });
    contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === ERR_ABORTED) return;
      entry.error = { code, description: String(description || ''), url: String(url || entry.requested) };
      entry.pending = '';
      emit(id);
    });
    contents.on('did-navigate', () => { entry.error = null; entry.pending = ''; emit(id); });
    contents.on('did-stop-loading', () => { entry.pending = ''; }); // a stopped load is headed nowhere
    for (const name of ['did-navigate-in-page', 'did-start-loading', 'did-stop-loading', 'page-title-updated']) contents.on(name, () => emit(id));
    contents.on('context-menu', (_event, params) => contextMenu(contents, params, id));
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.alt || !(process.platform === 'darwin' ? input.meta : input.control)) return;
      const key = String(input.key).toLowerCase();
      if (key === 'r') command(id, 'reload');
      else if (key === 'l') focusAddress();
      else if (key === '[') command(id, 'back');
      else if (key === ']') command(id, 'forward');
      else return;
      event.preventDefault();
    });
    return entry;
  }

  // A retry keeps the failure on screen until a page actually arrives (did-navigate clears it).
  function load(entry, href, keepError) {
    if (!keepError) entry.error = null;
    entry.requested = href;
    entry.pending = href;
    // A failed load is reported by did-fail-load; the promise says the same thing twice.
    entry.view.webContents.loadURL(href).catch(() => {});
  }

  function open(id, value) {
    assertId(id);
    const url = pageUrl(value);
    load(entries.get(id) || create(id), url.href);
    return true;
  }

  /** One page shows at a time: placing a tab's view hides every other. */
  function show(id, rect) {
    assertId(id);
    const entry = entries.get(id);
    if (!entry) return false;
    const win = getWindow();
    const bounds = boundsFrom(rect, win && !win.isDestroyed() ? win.webContents.getZoomFactor() : 1);
    for (const [other, item] of entries) {
      if (other !== id) { item.seq += 1; item.view.setVisible(false); }
    }
    entry.seq += 1;
    entry.view.setBounds(bounds);
    entry.view.setVisible(true);
    return true;
  }

  async function capture(entry) {
    let timer;
    try {
      const image = await Promise.race([
        entry.view.webContents.capturePage(),
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), SNAPSHOT_TIMEOUT_MS); }),
      ]);
      if (!image || image.isEmpty()) return null;
      return `data:image/jpeg;base64,${image.toJPEG(82).toString('base64')}`;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Hides whatever shows. With `snapshot`, the page's picture comes back first, so the renderer
   *  can keep it on screen under a menu or a modal that the native view would have covered. */
  async function hide(options) {
    let picture = null;
    for (const entry of entries.values()) {
      if (!entry.view.getVisible()) continue;
      const seq = entry.seq;
      if (options && options.snapshot) picture = await capture(entry);
      if (entry.seq === seq) entry.view.setVisible(false);
    }
    return picture;
  }

  function command(id, name) {
    assertId(id);
    const entry = entries.get(id);
    if (!entry) return false;
    const contents = entry.view.webContents;
    if (name === 'back') { if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack(); }
    else if (name === 'forward') { if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward(); }
    else if (name === 'reload') { if (entry.error) load(entry, entry.error.url || entry.requested, true); else contents.reload(); }
    else if (name === 'stop') contents.stop();
    else if (name === 'devtools') contents.openDevTools({ mode: 'detach' });
    else throw new TypeError('Unknown browser command');
    return true;
  }

  function detach(id) {
    const entry = entries.get(id);
    if (!entry) return null;
    entries.delete(id);
    const win = getWindow();
    try {
      if (win && !win.isDestroyed()) win.contentView.removeChildView(entry.view);
    } catch {
      // The window went first.
    }
    return entry;
  }

  function close(id) {
    assertId(id);
    const entry = detach(id);
    if (!entry) return false;
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
    return true;
  }

  function closeAll() {
    for (const id of [...entries.keys()]) close(id);
    for (const popup of [...popups]) { if (!popup.isDestroyed()) popup.destroy(); }
    popups.clear();
    for (const requestId of [...logins.keys()]) answerLogin(requestId, null);
  }

  /** Sign-ins are cookies; Chromium writes them lazily, so quitting asks for them now. */
  async function flush() {
    if (configured) await session.fromPartition(PARTITION).cookies.flushStore();
  }

  return { open, show, hide, command, close, closeAll, answerLogin, flush, has: (id) => entries.has(id) };
}

function registerBrowserIpc({ ipcMain, trustedHandler, views }) {
  ipcMain.handle('browser:open', trustedHandler((id, url) => views.open(id, url)));
  ipcMain.handle('browser:show', trustedHandler((id, rect) => views.show(id, rect)));
  ipcMain.handle('browser:hide', trustedHandler((options) => views.hide(options)));
  ipcMain.handle('browser:command', trustedHandler((id, name) => views.command(id, name)));
  ipcMain.handle('browser:close', trustedHandler((id) => views.close(id)));
  ipcMain.handle('browser:login-reply', trustedHandler((requestId, credentials) => views.answerLogin(requestId, credentials)));
  ipcMain.handle('browser:close-all', trustedHandler(() => { views.closeAll(); return true; }));
}

module.exports = { PARTITION, parseBrowserUrl, parseFileUrl, externalScheme, isLoopback, cleanUserAgent, boundsFrom, createBrowserViews, registerBrowserIpc };
