'use strict';
const { isGithubSignIn, endedGithubSession, GITHUB_SESSION_COOKIES } = require('../../shared/github.cjs');

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
//
// Pdfs (2026-09-22): a tab never shows Chromium's pdf viewer. A page that answers with a pdf is
// turned into a download, a download that is a pdf (by its type, its file name, or an address
// ending .pdf: a site serving one as octet-stream) is saved to a temporary file, and its bytes go
// to the renderer, which draws them with the Paper pane's viewer. A pdf on disk is read directly.
// The page under it stays where it was, so Back leaves the pdf.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

const PARTITION = 'persist:browser';
// A copy run from a checkout (`npm start`, `electron .`) keeps the Stage's cookies apart (2026-10-06). A package turns on
// Electron's EnableCookieEncryption fuse (electron-builder.config.cjs) and encrypts this store on write; a checkout runs
// the stock Electron, without the fuse, on the same userData folder, and cannot read what a package encrypted (Electron:
// "effectively corrupt"), while what it wrote would sit in the clear beside it. So each keeps its own: a developer signs
// in to the Stage once in each. Only the cookie store is split; settings, threads and the single-instance lock stay shared.
const DEV_PARTITION = 'persist:browser-dev';
/** The Stage's partition for this copy: `packaged` is app.isPackaged. */
const stagePartition = (packaged) => (packaged ? PARTITION : DEV_PARTITION);
const ERR_ABORTED = -3;
const SNAPSHOT_TIMEOUT_MS = 250;
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write']);
const WEB_PREFERENCES = Object.freeze({ partition: PARTITION, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true });
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const COOKIE_FLUSH_MS = 1000;
const ASKED_PERMISSIONS = { media: 'the camera or microphone', geolocation: 'your location', notifications: 'notifications', 'clipboard-read': 'the clipboard' };
// Never handed to another app: these either reach into this one or are not addresses at all.
const INTERNAL_SCHEMES = new Set(['http:', 'https:', 'file:', 'about:', 'blob:', 'data:', 'javascript:', 'chrome:', 'devtools:', 'view-source:', 'engelbart:']);
const MAX_PDF_BYTES = 200 * 1024 * 1024; // the library's limit
const PDF_TYPE = /^\s*application\/(?:x-)?pdf\b/i;
const FIND_MAX = 1000;
const SAVE_TIMEOUT_MS = 2 * 60 * 1000;

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

/** An address whose path ends in .pdf. */
function pdfAddress(value) {
  try { return /\.pdf$/i.test(new URL(String(value)).pathname); } catch { return false; }
}

function headerValue(headers, name) {
  for (const [key, value] of Object.entries(headers || {})) if (key.toLowerCase() === name) return [].concat(value).join(', ');
  return '';
}

/** A pdf response as a download, file name kept: that is how its bytes reach the viewer. Anything else: null. */
function pdfAsDownload(headers) {
  if (!PDF_TYPE.test(headerValue(headers, 'content-type'))) return null;
  const name = headerValue(headers, 'content-disposition').replace(/^\s*(?:inline|attachment)\b\s*;?\s*/i, '').trim(); // `filename="…"`, if any
  const out = {};
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() !== 'content-disposition') out[key] = value;
  out['Content-Disposition'] = [name ? `attachment; ${name}` : 'attachment'];
  return out;
}

/** What a pdf's tab is called: its file name without .pdf, else the last part of its address. */
function pdfName(fileName, url) {
  let name = String(fileName || '');
  if (!name) { try { name = decodeURIComponent(new URL(String(url)).pathname.split('/').filter(Boolean).pop() || ''); } catch { name = ''; } }
  return name.replace(/\.pdf$/i, '') || 'pdf';
}

function readPdf(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error('The pdf is not a file');
  if (stat.size > MAX_PDF_BYTES) throw new Error('The pdf is larger than 200 MB');
  const buffer = fs.readFileSync(file);
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
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

// The browsing session is the app's, one for every window (2026-10-03): its handlers are set once, by the first window's
// views, and each finds the window whose tab (or popup) the page is. A permission answered in one window is answered in
// all of them, for this run, as it is for the session.
const sessions = new WeakMap(); // browsing session -> { members: Set of a window's views, decided: Map }

function decide(shared, member, contents, permission, details) {
  if (ALLOWED_PERMISSIONS.has(permission)) return Promise.resolve(true);
  const what = ASKED_PERMISSIONS[permission];
  const origin = originOf((details && details.requestingUrl) || (contents && contents.getURL()));
  if (!what || !origin || !member) return Promise.resolve(false);
  const key = `${origin} ${permission}`; // -> the person's answer, for this run
  if (!shared.decided.has(key)) shared.decided.set(key, member.ask(`Allow ${origin} to use ${what}?`, '', 'Allow'));
  return shared.decided.get(key);
}

function joinSession(browsing, member, appName) {
  let shared = sessions.get(browsing);
  if (!shared) {
    shared = { members: new Set(), decided: new Map() };
    sessions.set(browsing, shared);
    const ownerOf = (contents) => { for (const each of shared.members) if (each.owns(contents)) return each; return null; };
    browsing.setUserAgent(cleanUserAgent(browsing.getUserAgent(), appName));
    browsing.setPermissionRequestHandler((contents, permission, callback, details) => {
      void decide(shared, ownerOf(contents) || [...shared.members].pop() || null, contents, permission, details).then(callback, () => callback(false));
    });
    // Sign-ins are cookies, and Chromium writes them lazily: a relaunch is a kill, not a quit.
    let timer = null;
    browsing.cookies.on('changed', () => {
      if (timer) return;
      timer = setTimeout(() => { timer = null; browsing.cookies.flushStore().catch(() => {}); }, COOKIE_FLUSH_MS);
      if (typeof timer.unref === 'function') timer.unref();
    });
    // A tab's page that is a pdf becomes a download, which receivePdf hands to the renderer's viewer.
    browsing.webRequest.onHeadersReceived({ urls: ['http://*/*', 'https://*/*'], types: ['mainFrame'] }, (details, callback) => {
      const owner = details.resourceType === 'mainFrame' && details.webContents ? ownerOf(details.webContents) : null;
      const headers = owner && owner.tabOf(details.webContents) ? pdfAsDownload(details.responseHeaders) : null;
      callback(headers ? { responseHeaders: headers } : {});
    });
    browsing.on('will-download', (_event, item, contents) => { const owner = ownerOf(contents); if (owner) owner.receivePdf(item, contents); });
  }
  shared.members.add(member);
  return shared;
}

function createBrowserViews({ electron, getWindow, send, appName, fileRoot, onLayerChange = () => {}, pdfDir = path.join(os.tmpdir(), 'engelbart-pdf'), partition = PARTITION }) {
  const { WebContentsView, session, Menu, clipboard, dialog, shell } = electron;
  const entries = new Map(); // tab id -> { view, error, requested, pending, seq, found }
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

  // This window's part in the shared session (joinSession): whose pages are whose, and where a question about one is asked.
  let shared = null;
  const member = {
    owns: (contents) => !!tabOf(contents) || [...popups].some((popup) => !popup.isDestroyed() && popup.webContents === contents),
    tabOf: (contents) => tabOf(contents),
    receivePdf: (item, contents) => receivePdf(item, contents),
    ask: (message, detail, yes) => ask(message, detail, yes),
  };
  function configureSession() {
    if (configured) return;
    configured = true;
    shared = joinSession(session.fromPartition(partition), member, appName);
  }

  /** GitHub's sign-in cookies in the Stage's session, gone (endedGithubSession): the next GitHub page is asked for signed out. */
  async function dropGithubSession() {
    configureSession();
    const cookies = session.fromPartition(partition).cookies;
    await Promise.all(GITHUB_SESSION_COOKIES.map((name) => cookies.remove('https://github.com', name).catch(() => {})));
  }

  function tabOf(contents) {
    for (const [id, entry] of entries) if (entry.view.webContents === contents) return id;
    return null;
  }

  /** A tab's download that is a pdf goes to a temporary file and then to the viewer. Any other download is Electron's to ask about. */
  function receivePdf(item, contents) {
    const id = tabOf(contents);
    const url = item.getURL();
    if (!id || !(PDF_TYPE.test(item.getMimeType()) || /\.pdf$/i.test(item.getFilename()) || pdfAddress(url))) return false;
    fs.mkdirSync(pdfDir, { recursive: true, mode: 0o700 });
    const file = path.join(pdfDir, `${nextId('pdf')}.pdf`);
    item.setSavePath(file);
    if (entries.has(id)) entries.get(id).download = url; // its page's cancelled load is this download, not a failure
    const shown = { id, url, name: pdfName(item.getFilename(), url), under: contents.getURL() || 'about:blank' };
    send('browser:pdf', { ...shown, loading: true });
    item.on('updated', () => { if (item.getReceivedBytes() > MAX_PDF_BYTES) item.cancel(); });
    item.once('done', (_event, state) => {
      let result;
      try {
        if (state !== 'completed') throw new Error(item.getReceivedBytes() > MAX_PDF_BYTES ? 'The pdf is larger than 200 MB' : 'The pdf did not download');
        result = { bytes: readPdf(file) };
      } catch (failure) {
        result = { error: failure.message };
      }
      fs.rm(file, { force: true }, () => {});
      if (entries.has(id)) send('browser:pdf', { ...shown, ...result });
    });
    return true;
  }

  /** A pdf on disk: read here, never loaded into the page. */
  function openPdfFile(id, url) {
    const entry = entries.get(id);
    const shown = { id, url: url.href, name: pdfName('', url.href), under: (entry && entry.view.webContents.getURL()) || 'about:blank' };
    let result;
    try { result = { bytes: readPdf(fileURLToPath(url)) }; } catch (failure) { result = { error: failure.code === 'ENOENT' ? 'Nothing is at that path' : failure.message }; }
    send('browser:pdf', { ...shown, ...result });
  }

  async function ask(message, detail, yes) {
    const win = getWindow();
    const options = { type: 'question', buttons: [yes, 'Don\u2019t Allow'], defaultId: 1, cancelId: 1, message, detail, noLink: true };
    const result = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    return result.response === 0;
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
      drawn: entry.drawn, // a page has arrived in this tab at least once (the Stage's "Waking…" waits for the first)
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
      if (isGithubSignIn(url)) { event.preventDefault(); void shell.openExternal(url).catch(() => {}); return; }
      if (allowed(url, contents)) {
        // a page on disk linking to a pdf on disk: the viewer reads it, as when it is typed
        if (!(isFileUrl(url) && pdfAddress(url) && tab && tabOf(contents) === tab)) return;
        event.preventDefault();
        openPdfFile(tab, new URL(url));
        return;
      }
      event.preventDefault();
      void handOver(url);
    };
    contents.on('will-navigate', guard);
    // A GitHub page sent to GitHub's /login by a redirect (2026-10-05): the Stage still holds a sign-in GitHub has ended,
    // and with it GitHub shows nothing, not even a public repository. The ended session is dropped and the page asked for
    // again, once, signed out; sent to /login again, it goes to the default browser as any sign-in does.
    let started = ''; // where the page's current navigation set out for
    let retried = '';
    contents.on('did-start-navigation', (details) => { if (details && details.isMainFrame && !details.isSameDocument) started = String(details.url || ''); });
    contents.on('did-navigate', () => { retried = ''; });
    contents.on('will-redirect', (event, url) => {
      const from = started;
      if (!event.isMainFrame || retried === from || !endedGithubSession(from, url)) { guard(event, url); return; }
      event.preventDefault();
      retried = from;
      const entry = tab ? entries.get(tab) : null;
      if (entry) entry.retrying = true; // the cancelled load is no failure: the page is asked for again
      void dropGithubSession().then(() => {
        if (contents.isDestroyed()) return;
        if (entry && entries.get(tab) === entry) load(entry, from);
        else contents.loadURL(from).catch(() => {});
      });
    });
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
      if (isGithubSignIn(url)) { void shell.openExternal(url).catch(() => {}); return { action: 'deny' }; }
      if (!allowed(url, contents)) return { action: 'deny' };
      if (disposition === 'new-window') {
        const parent = getWindow();
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            parent: parent && !parent.isDestroyed() ? parent : undefined,
            minWidth: 320, minHeight: 320, // the size is the page's to ask for (window.open features)
            autoHideMenuBar: true, backgroundColor: '#ffffff', fullscreenable: false,
            webPreferences: { ...WEB_PREFERENCES, partition },
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
    const view = new WebContentsView({ webContents: options.webContents, webPreferences: { ...WEB_PREFERENCES, partition } });
    const id = nextId('tab');
    attach(id, view, win);
    send('browser:open-tab', { id, url: view.webContents.getURL(), from });
    return view.webContents;
  }

  function create(id) {
    const win = getWindow();
    if (!win || win.isDestroyed()) throw new Error('No window for the browser');
    configureSession();
    return attach(id, new WebContentsView({ webPreferences: { ...WEB_PREFERENCES, partition } }), win);
  }

  function attach(id, view, win) {
    view.setBackgroundColor('#ffffff');
    view.setVisible(false);
    win.contentView.addChildView(view);
    onLayerChange();
    const entry = { view, error: null, requested: '', pending: '', seq: 0, found: '', drawn: false, download: '', retrying: false };
    entries.set(id, entry);

    const contents = view.webContents;
    protect(contents, id);
    contents.setWindowOpenHandler(windowOpenHandler(id, contents));
    contents.on('did-create-window', (popup) => watchPopup(popup, id));
    // window.close() from the page (the last step of many sign-ins) closes the tab.
    contents.on('destroyed', () => { if (entries.get(id) === entry) { detach(id); send('browser:closed', { id }); } });
    contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame) return;
      if (code === ERR_ABORTED) return; // a cancelled load: did-stop-loading judges it, below
      entry.error = { code, description: String(description || ''), url: String(url || entry.requested) };
      entry.pending = '';
      emit(id);
    });
    contents.on('did-navigate', () => { entry.error = null; entry.pending = ''; entry.found = ''; entry.drawn = true; emit(id); });
    contents.on('did-stop-loading', () => {
      // The tab's first load stopped with no page and nothing else on the way (2026-10-04): cancelled (a 204, a sandbox
      // waking), it would leave the tab blank for good, with Chromium saying nothing. A pdf turned into a download is the
      // viewer's; a load another took the place of is still loading; once a page is there, a cancel is no failure.
      if (entry.requested && !entry.drawn && !entry.error && !entry.download && !entry.retrying && !contents.isLoading()) {
        entry.error = { code: ERR_ABORTED, description: 'The page did not load', url: entry.requested };
      }
      entry.pending = ''; // a stopped load is headed nowhere
    });
    for (const name of ['did-navigate-in-page', 'did-start-loading', 'did-stop-loading', 'page-title-updated']) contents.on(name, () => emit(id));
    contents.on('context-menu', (_event, params) => contextMenu(contents, params, id));
    contents.on('found-in-page', (_event, result) => send('browser:found', { id, matches: result.matches, active: result.activeMatchOrdinal }));
    // ⌘T and ⌘W are the pane's, as in Chrome, where a page cannot take them. ⌘F is the Edit menu's
    // (shortcut below), which a page that has its own find (Google Docs) gets to first.
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.alt || !(process.platform === 'darwin' ? input.meta : input.control)) return;
      const key = String(input.key).toLowerCase();
      if (key === 'r') command(id, 'reload');
      else if (key === 'l') focusAddress();
      else if (key === '[') command(id, 'back');
      else if (key === ']') command(id, 'forward');
      else if (key === 'j') send('engelbart:next-workspace', {}); // the workspace's ⌘J, which a page in front would otherwise swallow
      else if (key === 't' && !input.shift) { focusApp(); send('browser:shortcut', { name: 'new-tab', tab: id }); }
      else if (key === 'w' && !input.shift) send('browser:shortcut', { name: 'close-tab', tab: id }); // ⇧⌘W is the window's
      else return;
      event.preventDefault();
    });
    return entry;
  }

  function focusApp() {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.focus();
  }

  /** Find in the page: a new query starts over, the same one steps. An empty one stops. */
  function find(id, text, options) {
    assertId(id);
    const entry = entries.get(id);
    if (!entry) return false;
    const contents = entry.view.webContents;
    if (typeof text !== 'string' || text.length > FIND_MAX) throw new TypeError('Find text must be a bounded string');
    if (!text) { contents.stopFindInPage('clearSelection'); entry.found = ''; return true; }
    const forward = !(options && options.backward);
    contents.findInPage(text, { forward, findNext: entry.found !== text, matchCase: false });
    entry.found = text;
    return true;
  }

  function stopFind(id) {
    assertId(id);
    const entry = entries.get(id);
    if (!entry) return false;
    entry.found = '';
    entry.view.webContents.stopFindInPage('keepSelection');
    return true;
  }

  /** The Edit menu's Find items: to the renderer, with the tab whose page has the keyboard (null: the app has it). */
  function shortcut(name) {
    let tab = null;
    for (const [id, entry] of entries) if (entry.view.getVisible() && entry.view.webContents.isFocused()) tab = id;
    if (tab && name === 'find') focusApp();
    send('browser:shortcut', { name, tab });
  }

  // A retry keeps the failure on screen until a page actually arrives (did-navigate clears it).
  function load(entry, href, keepError) {
    if (!keepError) entry.error = null;
    entry.download = '';
    entry.retrying = false;
    entry.requested = href;
    entry.pending = href;
    // A failed load is reported by did-fail-load; the promise says the same thing twice.
    entry.view.webContents.loadURL(href).catch(() => {});
  }

  function open(id, value) {
    assertId(id);
    const url = pageUrl(value);
    if (isGithubSignIn(url.href)) return shell.openExternal(url.href).then(() => true);
    if (url.protocol === 'file:' && pdfAddress(url.href)) openPdfFile(id, url);
    else load(entries.get(id) || create(id), url.href);
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
    onLayerChange();
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

  /**
   * The page a tab shows, written into `dir` as Chromium saves a complete page: index.html and its index_files folder
   * (the library's copy of a page, MATH-17). The page as it is now, signed in or not; a page still loading or that failed
   * to load is not saved. → { file, url, title }
   */
  async function savePage(id, dir) {
    assertId(id);
    const entry = entries.get(id);
    if (!entry) throw new Error('That tab is not open');
    const contents = entry.view.webContents;
    if (contents.isLoading()) throw new Error('The page is still loading');
    if (entry.error) throw new Error('The page did not load');
    const file = path.join(dir, 'index.html');
    let timer;
    try {
      await Promise.race([
        contents.savePage(file, 'HTMLComplete'),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The page took too long to save')), SAVE_TIMEOUT_MS); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    return { file, url: contents.getURL(), title: contents.getTitle() };
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
    const browsing = session.fromPartition(partition);
    if (configured || sessions.has(browsing)) await browsing.cookies.flushStore(); // whichever window's tabs set it up
  }

  /** The window closed: its pages are gone, and the shared session no longer asks it about any. */
  function dispose() {
    closeAll();
    if (shared) shared.members.delete(member);
  }

  return { open, show, hide, command, find, stopFind, shortcut, savePage, close, closeAll, answerLogin, flush, dispose, has: (id) => entries.has(id) };
}

// Each handler is registered once and acts on the views of the window that called (`viewsFor(event)`, 2026-10-03).
// `cookieImport` (MATH-18, 2026-10-06) is the one importer for the whole app — the Stage's session is shared across
// windows — so its three handlers are not per-window. They carry domains and counts only, never cookie values (CK-07,
// CK-13): import-domains gives a domain and a count, import gives { imported, skipped, sessionOnly, checks }.
function registerBrowserIpc({ ipcMain, trustedHandler, viewsFor = null, views = null, cookieImport = null }) {
  const lookup = viewsFor || (() => views);
  const handle = (channel, call) => ipcMain.handle(channel, (event, ...args) => trustedHandler((...rest) => {
    const mine = lookup(event);
    if (!mine) throw new Error('No window for the browser');
    return call(mine, ...rest);
  })(event, ...args));
  handle('browser:open', (mine, id, url) => mine.open(id, url));
  handle('browser:show', (mine, id, rect) => mine.show(id, rect));
  handle('browser:hide', (mine, options) => mine.hide(options));
  handle('browser:command', (mine, id, name) => mine.command(id, name));
  handle('browser:find', (mine, id, text, options) => mine.find(id, text, options));
  handle('browser:stop-find', (mine, id) => mine.stopFind(id));
  handle('browser:close', (mine, id) => mine.close(id));
  handle('browser:login-reply', (mine, requestId, credentials) => mine.answerLogin(requestId, credentials));
  handle('browser:close-all', (mine) => { mine.closeAll(); return true; });

  if (cookieImport) {
    const text = (value, what) => { if (typeof value !== 'string' || !value || value.length > 256) throw new TypeError(`${what} must be a short string`); return value; };
    ipcMain.handle('browser:import-sources', trustedHandler(() => cookieImport.sources()));
    ipcMain.handle('browser:import-domains', trustedHandler((browser, profile) => cookieImport.domains(text(browser, 'A browser'), text(profile, 'A profile'))));
    ipcMain.handle('browser:import', trustedHandler((request) => {
      if (!request || typeof request !== 'object') throw new TypeError('An import needs a browser, a profile and domains');
      const domains = Array.isArray(request.domains) ? request.domains.slice(0, 500).map((d) => text(d, 'A domain')) : [];
      return cookieImport.import({ browser: text(request.browser, 'A browser'), profile: text(request.profile, 'A profile'), domains });
    }));
  }
}

module.exports = { PARTITION, DEV_PARTITION, stagePartition, parseBrowserUrl, parseFileUrl, externalScheme, isLoopback, cleanUserAgent, boundsFrom, pdfAddress, pdfAsDownload, pdfName, createBrowserViews, registerBrowserIpc };
