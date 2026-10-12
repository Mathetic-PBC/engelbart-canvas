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
// Google's refusal (2026-10-12): Google may still turn the sign-in away ("Couldn't sign you in … this browser or app may
// not be secure", accounts.google.com/…/signin/rejected). It then leaves cookies that turn every later try away too, so
// the window clears Google's __Host-*, __Secure-*, OTZ and NID cookies (on google.com, accounts.google.com and
// mail.google.com), closes, and open() resolves { status: 'rejected' }: the row offers Try again.

const { appOf, SIGN_IN_COOKIES, signInGroup } = require('../../shared/connect-sources.cjs');
const { SIGN_IN_PAGES } = require('./web-signin.cjs');

const POLL_MS = 2000;

const httpsOnly = (url) => {
  try { return new URL(url).protocol === 'https:'; } catch { return false; }
};

/** Google's "Couldn't sign you in" page: accounts.google.com/signin/rejected, /v3/signin/rejected and the like. */
const rejectedByGoogle = (url) => {
  try { const at = new URL(url); return at.hostname === 'accounts.google.com' && /\/signin\/rejected(?:\/|$)/.test(at.pathname); } catch { return false; }
};

const GOOGLE_HOSTS = ['google.com', 'accounts.google.com', 'mail.google.com'];
const GOOGLE_STALE = /^(?:__Host-|__Secure-|OTZ$|NID$)/;

/** Removes the cookies a refused Google sign-in leaves behind, from `session`; any it cannot read or remove stay. */
async function clearGoogleRefusal(session) {
  const cookies = session && session.cookies;
  if (!cookies || typeof cookies.get !== 'function') return;
  const all = await cookies.get({ domain: 'google.com' }).catch(() => []);
  await Promise.all(all
    .filter((cookie) => GOOGLE_HOSTS.includes(String(cookie.domain || '').replace(/^\./, '')) && GOOGLE_STALE.test(String(cookie.name || '')))
    .map((cookie) => cookies.remove(`https://${String(cookie.domain).replace(/^\./, '')}${cookie.path || '/'}`, cookie.name).catch(() => {})));
}

/**
 * `getParent()` the window it opens over; `getSession()` the agents' browser session; `userAgent(ua)` the user agent sites
 * see (as connect/browser.cjs sets it); `signedIn(app)` whether that session holds the app's sign-in (webSignIn.signedIn).
 * → { open(app) → Promise<{ status: 'signed-in' | 'closed' | 'rejected' }>, close(), isOpen() }
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
        if (status !== 'closed' && !win.isDestroyed()) win.close();
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
    let refused = false;
    const landed = (event, url) => {
      if (done || refused || !rejectedByGoogle(url)) return;
      refused = true;
      void clearGoogleRefusal(getSession()).then(() => finish('rejected'), () => finish('rejected'));
    };
    contents.on('did-navigate', landed);
    contents.on('did-redirect-navigation', landed);
    contents.on('will-redirect', landed);
    win.on('closed', () => { if (!refused) finish('closed'); });
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

module.exports = { createSignInWindow, clearGoogleRefusal, rejectedByGoogle, POLL_MS };
