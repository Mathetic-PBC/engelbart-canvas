'use strict';

// Connect your library: signing in to a web app in Engelbart's own browser (2026-10-11). When the person's browsers hold no
// sign-in to bring over (./web-signin.cjs) — signed out there, macOS refused the Keychain, or Safari only — the choose
// screen's "Sign in" opens the app's sign-in page in a small window over the app. Its session is the agents' browser's
// (BROWSER_PARTITION, the one webSignIn.signedIn reads), so a sign-in made here is the one the agents use. Modelled on
// ../github/window.cjs, but a sign-in hops across hosts (Google, Apple, Microsoft, the apps' own auth pages), so any https
// page may load; anything else is blocked, and a page that opens a window opens it here instead. No Keychain, no Chrome.
// Every 2 s the app's sign-in cookie is looked for, with no time limit; once it is there the window closes itself and
// open() resolves { status: 'signed-in' }. Closed by the person first: { status: 'closed' }. One window at a time: a
// second open() for an app sharing the sign-in (Google Drive and Gmail) focuses it and shares its answer.

const { appOf, SIGN_IN_COOKIES, signInGroup } = require('../../shared/connect-sources.cjs');
const { SIGN_IN_PAGES } = require('./web-signin.cjs');

const POLL_MS = 2000;

const httpsOnly = (url) => {
  try { return new URL(url).protocol === 'https:'; } catch { return false; }
};

/**
 * `getParent()` the window it opens over; `getSession()` the agents' browser session; `userAgent(ua)` the user agent sites
 * see (as connect/browser.cjs sets it); `signedIn(app)` whether that session holds the app's sign-in (webSignIn.signedIn).
 * → { open(app) → Promise<{ status: 'signed-in' | 'closed' }>, close(), isOpen() }
 */
function createSignInWindow({ BrowserWindow, getParent = () => null, getSession, userAgent = (ua) => ua, signedIn, headless = false, pollMs = POLL_MS, timers = { setInterval, clearInterval } }) {
  let current = null; // { group, app, win, promise, finish }

  function open(app) {
    const start = SIGN_IN_PAGES[app] || (appOf(app) && appOf(app).start);
    if (!start || !SIGN_IN_COOKIES[app]) return Promise.resolve({ status: 'closed' });
    const group = signInGroup(app);
    if (current && current.group === group && current.win && !current.win.isDestroyed()) {
      current.win.show();
      current.win.focus();
      return current.promise;
    }
    close();

    const parent = getParent();
    const win = new BrowserWindow({
      parent: parent && !parent.isDestroyed() ? parent : undefined,
      width: 460,
      height: 720,
      minWidth: 360,
      minHeight: 480,
      title: 'Sign in',
      backgroundColor: '#ffffff',
      show: !headless,
      autoHideMenuBar: true,
      webPreferences: { session: getSession(), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true },
    });
    const contents = win.webContents;
    try { contents.setUserAgent(userAgent(contents.getUserAgent())); } catch { /* keep Electron's */ }
    contents.setWindowOpenHandler(({ url }) => {
      if (httpsOnly(url)) void win.loadURL(url).catch(() => {});
      return { action: 'deny' };
    });
    const guard = (event, url) => { if (!httpsOnly(url)) event.preventDefault(); };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);

    let done = false;
    let looking = false;
    let timer = null;
    let finish;
    const entry = { group, app, win };
    entry.promise = new Promise((resolve) => {
      finish = (status) => {
        if (done) return;
        done = true;
        if (timer) timers.clearInterval(timer);
        if (current === entry) current = null;
        resolve({ status });
        if (status === 'signed-in' && !win.isDestroyed()) win.close();
      };
    });
    entry.finish = finish;
    current = entry;

    timer = timers.setInterval(async () => {
      if (done || looking) return;
      looking = true;
      try {
        if (await signedIn(app)) finish('signed-in');
      } catch { /* looked at again next time */ } finally { looking = false; }
    }, pollMs);
    win.on('closed', () => finish('closed'));
    void win.loadURL(start).catch(() => {});
    return entry.promise;
  }

  /** Closes the window, if one is open: its open() resolves 'closed'. */
  function close() {
    const entry = current;
    if (!entry) return;
    entry.finish('closed');
    if (entry.win && !entry.win.isDestroyed()) entry.win.close();
  }

  return { open, close, isOpen: () => !!current };
}

module.exports = { createSignInWindow, POLL_MS };
