'use strict';
const path = require('node:path');
const { readPage } = require('./page-reader.cjs');
const failure = (message, code) => Object.assign(new Error(message), { code });
const LOGIN = 'Sign in to Zotero in Stage, then reconnect to load your papers.';
const TIMEOUT = 'Zotero took too long to load. Open Zotero in Stage, then retry.';
function zoteroUrl(value, origin) { try { return new URL(value).origin === origin; } catch { return false; } }
const pause = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(failure('Cancelled', 'cancelled')); return; }
  const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, ms);
  const cancel = () => { clearTimeout(timer); reject(failure('Cancelled', 'cancelled')); };
  signal?.addEventListener('abort', cancel, { once: true });
});
function createZoteroReader({ BrowserWindow, getSession, getPages = () => [], origin = 'https://www.zotero.org', timeoutMs = 120000, pollMs = 350 } = {}) {
  const parsed = new URL(origin);
  if (parsed.origin !== 'https://www.zotero.org' && !(parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1')) throw new Error('Invalid Zotero origin');
  origin = parsed.origin;
  let retryAt = 0;
  const libraryUrl = () => `${origin}/mylibrary`;
  async function stageAccount() {
    const pages = getPages().filter(p => !p.isDestroyed() && zoteroUrl(p.getURL(), origin));
    pages.sort((a, b) => Number(a.isFocused()) - Number(b.isFocused()));
    for (const page of pages.reverse()) {
      const value = await readPage(page, null, origin);
      if (!page.isDestroyed() && zoteroUrl(page.getURL(), origin) && value?.kind === 'account') return value;
    }
    return null;
  }
  async function read({ signal } = {}) {
    if (Date.now() < retryAt) throw failure(`Zotero asked to wait. Retry in ${Math.ceil((retryAt - Date.now()) / 1000)} seconds.`, 'rate-limit');
    const window = new BrowserWindow({ show: false, width: 1100, height: 850, skipTaskbar: true,
      webPreferences: { session: getSession(), preload: path.join(__dirname, '../../../dist/zotero-preload.cjs'),
        nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    const page = window.webContents, deadline = AbortSignal.timeout(timeoutMs);
    const stoppedSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const destroy = () => { if (!window.isDestroyed()) window.destroy(); };
    stoppedSignal.addEventListener('abort', destroy, { once: true });
    const stopped = () => {
      if (signal?.aborted) throw failure('Cancelled', 'cancelled');
      if (deadline.aborted || window.isDestroyed()) throw failure(TIMEOUT, 'timeout');
    };
    page.setWindowOpenHandler(() => ({ action: 'deny' }));
    page.on('will-navigate', (event, url) => { if (!zoteroUrl(url, origin)) event.preventDefault(); });
    try {
      stopped();
      let domReady = false, loadError = null;
      page.on('dom-ready', () => { domReady = true; });
      void page.loadURL(libraryUrl()).catch(error => { loadError = error; });
      const papers = new Map();
      let account = null, start = 0, version = '';
      for (;;) {
        stopped();
        if (!domReady) { if (loadError) throw loadError; await pause(pollMs, stoppedSignal); continue; }
        if (!zoteroUrl(page.getURL(), origin)) throw failure(LOGIN, 'login');
        const value = await readPage(page, start, origin, { signal: stoppedSignal });
        stopped();
        if (!zoteroUrl(page.getURL(), origin) || value?.kind === 'login') throw failure(LOGIN, 'login');
        if (value?.backoff > 0) retryAt = Date.now() + Math.min(value.backoff, 86400) * 1000;
        if (value?.kind === 'rate-limit') throw failure('Zotero is busy. Wait a little before refreshing your papers.', 'rate-limit');
        if (value?.kind === 'error') throw failure('Could not read your Zotero library. Open Zotero in Stage, then retry.', 'read');
        if (value?.kind !== 'ready') { await pause(pollMs, stoppedSignal); continue; }
        if (!/^\d{1,20}$/.test(value.account?.id || '') || typeof value.account?.name !== 'string') throw failure('Zotero account could not be read.', 'layout');
        if (account && account.id !== value.account.id) throw failure('Zotero account changed while loading. Refresh your papers.', 'login');
        if (version && value.version && version !== value.version) throw failure('Your Zotero library changed while loading. Refresh to get the complete list.', 'changed');
        account = { id: value.account.id, name: value.account.name.slice(0, 200) }; version = value.version || version;
        for (const paper of value.papers || []) {
          if (!/^[A-Z0-9]{8}$/.test(paper.id || '') || typeof paper.name !== 'string') continue;
          papers.set(paper.id, { id: paper.id, name: paper.name.slice(0, 1000), authors: String(paper.authors || '').slice(0, 1000),
            date: String(paper.date || '').slice(0, 100), dateAdded: String(paper.dateAdded || '').slice(0, 40), itemType: String(paper.itemType || '').slice(0, 50),
            url: `https://www.zotero.org/${encodeURIComponent(account.name)}/items/${paper.id}/library` });
        }
        if (value.next === null || value.next >= 10000) return { account, papers: [...papers.values()], incomplete: value.next !== null };
        if (!Number.isSafeInteger(value.next) || value.next <= start || value.next > start + 100) throw failure('Zotero pagination could not be read. Please refresh.', 'layout');
        start = value.next;
        await pause(Math.max(100, retryAt - Date.now()), stoppedSignal);
      }
    } catch (error) {
      if (signal?.aborted) throw failure('Cancelled', 'cancelled');
      if (deadline.aborted) throw failure(TIMEOUT, 'timeout');
      if (error.code) throw error;
      throw failure('Could not load Zotero. Open Zotero in Stage, then retry.', 'read');
    } finally { stoppedSignal.removeEventListener('abort', destroy); destroy(); }
  }
  return { read, stageAccount, libraryUrl };
}
module.exports = { createZoteroReader, zoteroUrl };
