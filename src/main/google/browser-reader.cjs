'use strict';
const path = require('node:path');
const { readPage } = require('./page-reader.cjs');
const failure = (message, code) => Object.assign(new Error(message), { code });
const LOGIN = 'Sign in to Google Drive in Stage to load your documents.';
const TIMEOUT = 'Google Drive took too long to load. Open Google Drive in Stage, then choose Retry.';
const WEEK = 7 * 86400000;

function dateWindow(now = Date.now()) {
  const date = new Date(now - WEEK);
  // Drive's website search is day-based, in the local calendar, not an API's
  // exact 168-hour timestamp. Match the seven-day date filter users see there.
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
const queryFor = since => `type:document after:${since}`;
function searchUrl(user = '0', since = dateWindow(), origin = 'https://drive.google.com') {
  const url = new URL(`/drive/u/${/^\d{1,3}$/.test(user) ? user : '0'}/search`, origin);
  url.search = new URLSearchParams({ q: queryFor(since), hl: 'en' });
  return url.href;
}
function driveUrl(value, origin) {
  try { const url = new URL(value); return url.origin === origin && /^\/drive(?:\/u\/\d+)?\//.test(url.pathname); } catch { return false; }
}
const pause = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(failure('Cancelled', 'cancelled')); return; }
  const done = () => { signal?.removeEventListener('abort', cancel); resolve(); };
  const timer = setTimeout(done, ms);
  const cancel = () => { clearTimeout(timer); reject(failure('Cancelled', 'cancelled')); };
  signal?.addEventListener('abort', cancel, { once: true });
});

function createDriveReader({ BrowserWindow, getSession, getPages = () => [], origin = 'https://drive.google.com', timeoutMs = 45000, pollMs = 400 } = {}) {
  const parsed = new URL(origin);
  if (parsed.origin !== 'https://drive.google.com' && !(parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1')) throw new Error('Invalid Google Drive origin');
  origin = parsed.origin;
  async function stageAccount() {
    // Prefer a focused Drive tab, otherwise the last one opened. Inspect only
    // the account button, not the file listing, until Connect was requested.
    const pages = getPages().filter(p => !p.isDestroyed() && driveUrl(p.getURL(), origin));
    pages.sort((a, b) => Number(a.isFocused()) - Number(b.isFocused()));
    for (const page of pages.reverse()) {
      try {
        const value = await readPage(page, null, false, origin);
        if (!page.isDestroyed() && driveUrl(page.getURL(), origin) && value?.kind === 'account') return value;
      } catch { /* navigation may replace the page while inspecting */ }
    }
    return null;
  }
  async function read({ user = '0', since = dateWindow(), signal } = {}) {
    const window = new BrowserWindow({ show: false, width: 1100, height: 850, skipTaskbar: true,
      webPreferences: { session: getSession(), preload: path.join(__dirname, '../../../dist/google-preload.cjs'),
        nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    const page = window.webContents;
    const destroy = () => { if (!window.isDestroyed()) window.destroy(); };
    signal?.addEventListener('abort', destroy, { once: true });
    const deadline = AbortSignal.timeout(timeoutMs);
    deadline.addEventListener('abort', destroy, { once: true });
    const stopped = () => {
      if (signal?.aborted) throw failure('Cancelled', 'cancelled');
      if (deadline.aborted || window.isDestroyed()) throw failure(TIMEOUT, 'timeout');
    };
    page.setWindowOpenHandler(() => ({ action: 'deny' }));
    page.on('will-navigate', (event, url) => {
      if (!driveUrl(url, origin) && !url.startsWith('https://accounts.google.com/')) event.preventDefault();
    });
    try {
      stopped();
      // Drive can keep preload frames/assets loading after its listing is ready.
      // Wait for the main DOM, not the load event of every child frame.
      let domReady = false, loadError = null;
      page.on('dom-ready', () => { domReady = true; });
      void page.loadURL(searchUrl(user, since, origin)).catch(error => { loadError = error; });
      const docs = new Map();
      let account = null, previous = '', stable = 0, unknown = 0;
      for (let step = 0; step < 120; step++) {
        stopped();
        if (!domReady) {
          if (loadError) throw loadError;
          await pause(pollMs, signal); continue;
        }
        if (!driveUrl(page.getURL(), origin)) throw failure(LOGIN, 'login');
        const value = await readPage(page, queryFor(since), false, origin, { signal });
        stopped();
        if (!driveUrl(page.getURL(), origin)) throw failure(LOGIN, 'login');
        if (value?.kind !== 'ready') { await pause(pollMs, signal); continue; }
        if (account && value.account.id !== account.id) throw failure('Google account changed while loading. Refresh the list.', 'account-changed');
        account = value.account; user = value.user; unknown = Math.max(unknown, value.unrecognized || 0);
        for (const doc of value.documents || []) {
          if (!/^[\w-]{10,200}$/.test(doc.id || '') || typeof doc.name !== 'string') continue;
          const url = new URL(`https://docs.google.com/document/d/${doc.id}/edit`);
          url.searchParams.set('authuser', account.email);
          docs.set(doc.id, { id: doc.id, name: doc.name.slice(0, 512), modifiedTime: doc.modifiedTime || null, url: url.href });
        }
        const marker = `${docs.size}:${value.position}`;
        stable = marker === previous && value.atEnd ? stable + 1 : 0; previous = marker;
        if (stable >= 3 || docs.size >= 1000) {
          if (!docs.size && unknown) throw failure('Google Drive’s document rows could not be recognized. Open Drive in Stage and try Refresh.', 'layout');
          return { account, user, since, documents: [...docs.values()], incomplete: !!unknown || docs.size >= 1000 };
        }
        await readPage(page, queryFor(since), true, origin, { signal });
        await pause(pollMs, signal);
      }
      throw failure('Google Drive’s file listing could not be read completely. Open Drive in Stage and try Refresh.', 'layout');
    } catch (error) {
      if (signal?.aborted) throw failure('Cancelled', 'cancelled');
      if (deadline.aborted) throw failure(TIMEOUT, 'timeout');
      if (error.code) throw error;
      throw failure('Could not read Google Drive. Open it in Stage, then try Refresh.', 'read');
    } finally {
      signal?.removeEventListener('abort', destroy); deadline.removeEventListener('abort', destroy); destroy();
    }
  }
  return { read, stageAccount, searchUrl: (user, since) => searchUrl(user, since, origin) };
}

module.exports = { createDriveReader, dateWindow, queryFor, searchUrl, driveUrl };
