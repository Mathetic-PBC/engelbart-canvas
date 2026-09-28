'use strict';
const path = require('node:path');
const { readPage } = require('../browser/page-reader.cjs');
const failure = (message, code) => Object.assign(new Error(message), { code });
const TIMEOUT = 'Overleaf took too long to load. Open Overleaf in Stage, then choose Retry.';
const LOGIN = 'Sign in to Overleaf in Stage to load your projects.';
const CATALOG = 'Overleaf’s complete project list could not be read. Open Overleaf in Stage, then choose Retry.';

function projectPage(value, origin) {
  try { const url = new URL(value); return url.origin === origin && /^\/project(?:\/[a-f0-9]{24})?\/?$/i.test(url.pathname); } catch { return false; }
}
function createOverleafReader({ BrowserWindow, getSession, getPages = () => [], origin = 'https://www.overleaf.com', timeoutMs = 45000, pollMs = 400 } = {}) {
  const parsed = new URL(origin);
  if (parsed.origin !== 'https://www.overleaf.com' && !(parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1')) throw new Error('Invalid Overleaf origin');
  origin = parsed.origin;
  const readSnapshot = (page, query, signal) => readPage(page, query, false, origin, { provider: 'overleaf', signal });
  async function stageAccount() {
    const pages = getPages().filter(p => !p.isDestroyed() && projectPage(p.getURL(), origin));
    pages.sort((a, b) => Number(a.isFocused()) - Number(b.isFocused()));
    for (const page of pages.reverse()) {
      const value = await readSnapshot(page, null);
      if (!page.isDestroyed() && projectPage(page.getURL(), origin) && value?.kind === 'account') return value;
    }
    return null;
  }
  const projectsUrl = () => `${origin}/project`;
  async function read({ signal } = {}) {
    const window = new BrowserWindow({ show: false, width: 1100, height: 850, skipTaskbar: true,
      webPreferences: { session: getSession(), preload: path.join(__dirname, '../../../dist/overleaf-preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    const page = window.webContents;
    const destroy = () => { if (!window.isDestroyed()) window.destroy(); };
    const deadline = AbortSignal.timeout(timeoutMs);
    signal?.addEventListener('abort', destroy, { once: true }); deadline.addEventListener('abort', destroy, { once: true });
    const stopped = () => {
      if (signal?.aborted) throw failure('Cancelled', 'cancelled');
      if (deadline.aborted || window.isDestroyed()) throw failure(TIMEOUT, 'timeout');
    };
    page.setWindowOpenHandler(() => ({ action: 'deny' }));
    page.on('will-navigate', (event, url) => { try { if (new URL(url).origin !== origin) event.preventDefault(); } catch { event.preventDefault(); } });
    try {
      stopped();
      let domReady = false, loadError = null;
      page.on('dom-ready', () => { domReady = true; });
      void page.loadURL(projectsUrl()).catch(error => { loadError = error; });
      while (true) {
        stopped();
        if (loadError && !domReady) throw loadError;
        if (domReady) {
          if (!projectPage(page.getURL(), origin)) throw failure(LOGIN, 'login');
          const value = await readSnapshot(page, 'all', signal);
          stopped();
          if (!projectPage(page.getURL(), origin)) throw failure(LOGIN, 'login');
          if (['layout', 'incomplete'].includes(value?.kind)) throw failure(CATALOG, 'layout');
          if (value?.kind === 'ready') return { account: value.account, projects: value.projects.map(project => ({ ...project, url: `https://www.overleaf.com/project/${project.id}` })) };
        }
        await new Promise(resolve => setTimeout(resolve, pollMs));
      }
    } catch (error) {
      if (signal?.aborted) throw failure('Cancelled', 'cancelled');
      if (deadline.aborted) throw failure(TIMEOUT, 'timeout');
      if (['login', 'layout', 'timeout'].includes(error.code)) throw error;
      throw failure('Could not read Overleaf. Open it in Stage, then choose Retry.', 'read');
    } finally { signal?.removeEventListener('abort', destroy); deadline.removeEventListener('abort', destroy); destroy(); }
  }
  return { stageAccount, read, projectsUrl };
}
module.exports = { createOverleafReader, projectPage };
