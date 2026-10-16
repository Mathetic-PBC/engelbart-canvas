'use strict';

// Connect your library: signing in to a web app in Engelbart's own browser (2026-10-11). When the person's browsers hold no
// sign-in to bring over (./web-signin.cjs) — signed out there, macOS refused the Keychain, or Safari only — the choose
// screen's "Sign in" opens the app's sign-in page in a small window over the app. Its session is the agents' browser's
// (BROWSER_PARTITION, the one webSignIn.signedIn reads), so a sign-in made here is the one the agents use. Modelled on
// ../github/window.cjs, but a sign-in hops across hosts (Google, Apple, Microsoft, the apps' own auth pages), so any https
// page may load; anything else is blocked. No Keychain, no Chrome.
// Pop-ups (2026-10-12): claude.ai's "Continue with Google" opens Google in a pop-up and expects the answer back through
// window.opener; loading the pop-up's page in the main window instead lost that answer, so no sign-in cookie landed. An
// https pop-up now opens as a child of the sign-in window: the same session and user agent, sandboxed, guarded the same
// way, closed with its parent. Any other pop-up is refused.
// Every 2 s the app's sign-in cookie is looked for, with no time limit; once it is there the window closes itself and
// open() resolves { status: 'signed-in' }. Closed by the person first: { status: 'closed' }. One window at a time: a
// second open() for an app sharing the sign-in (Google Drive and Gmail) focuses it and shares its answer.
// Google's refusal (2026-10-12): Google may still turn the sign-in away ("Couldn't sign you in … this browser or app may
// not be secure", accounts.google.com/…/signin/rejected). It then leaves cookies that turn every later try away too, so
// the window clears Google's __Host-*, __Secure-*, OTZ and NID cookies (on google.com, accounts.google.com and
// mail.google.com), closes, and open() resolves { status: 'rejected' }: the row offers Try again.
// Any site (2026-10-16, C9: "I suppose we can ask them to sign in using Engelbart's chromium … and then have agents run
// there"): `openSite({ name, url, domains })` does the same for a tool with no registered app, in the same session. With no
// sign-in cookie to look for, it is signed in when the window closes with its sites' cookies changed.

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
 * → { open(app) → Promise<{ status: 'signed-in' | 'closed' | 'rejected' }>, openSite({ name, url, domains }) → the same,
 *     close(), isOpen() }
 */
function createSignInWindow({ BrowserWindow, getParent = () => null, getSession, userAgent = (ua) => ua, signedIn, headless = false, pollMs = POLL_MS, timers = { setInterval, clearInterval } }) {
  let current = null; // { group, app, win, promise, finish }

  /**
   * A registered app's sign-in page. One with no known sign-in cookie (Evernote, OneNote…) opens as any site does
   * (openSite, C9): its own sites, signed in when their cookies changed while the window was open.
   */
  function open(app) {
    const start = SIGN_IN_PAGES[app] || (appOf(app) && appOf(app).start);
    if (!start) return Promise.resolve({ status: 'closed' });
    if (!SIGN_IN_COOKIES[app]) return openSite({ name: app, url: start, domains: siteDomains(app, start) });
    return present({ group: signInGroup(app), app, start, signedInNow: () => signedIn(app) });
  }

  /**
   * Sign in to any https site inside Engelbart (C9, 2026-10-16: an "Other" tool, one the agents found or the person added),
   * in the agents' session. A site has no sign-in cookie Engelbart knows, so the window stays until the person closes it;
   * then 'signed-in' when the cookies of `domains` (registrable, the url's own by default) appeared or changed while it was
   * open, else 'closed'. Not https: 'closed' at once.
   */
  function openSite({ name = '', url = '', domains = [] } = {}) {
    if (!httpsOnly(url)) return Promise.resolve({ status: 'closed' });
    const sites = registrableOf(domains.length ? domains : [new URL(url).hostname]);
    if (!sites.length) return Promise.resolve({ status: 'closed' });
    const before = printOf(getSession(), sites);
    return present({
      group: `site ${sites.join(' ')}`,
      app: name,
      start: url,
      title: name ? `Sign in to ${name}` : 'Sign in',
      closed: async () => ((await printOf(getSession(), sites)) !== (await before) ? 'signed-in' : 'closed'),
    });
  }

  /**
   * The window itself: `start` loaded on the agents' session; every `pollMs`, `signedInNow()` (when given) says whether it
   * is signed in, which closes it ('signed-in'); closed by the person, `closed()` says how it ended ('closed' when not given).
   */
  function present({ group, app = '', start, title = 'Sign in', signedInNow = null, closed = null }) {
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
      title,
      backgroundColor: '#ffffff',
      show: !headless,
      autoHideMenuBar: true,
      webPreferences: { session: getSession(), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true },
    });
    const contents = win.webContents;
    // Every pop-up opened from the window (and from its pop-ups): closed with it.
    const children = new Set();
    let refused = false;
    let finish;
    const landed = (event, url) => {
      if (done || refused || !rejectedByGoogle(url) || !finish) return;
      refused = true;
      void clearGoogleRefusal(getSession()).then(() => finish('rejected'), () => finish('rejected'));
    };
    const guardContents = (target, owner) => {
      try { target.setUserAgent(userAgent(target.getUserAgent())); } catch { /* keep Electron's */ }
      target.setWindowOpenHandler(({ url }) => {
        if (!httpsOnly(url) || owner.isDestroyed()) return { action: 'deny' };
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            parent: owner,
            title: 'Sign in',
            backgroundColor: '#ffffff',
            show: !headless,
            autoHideMenuBar: true,
            webPreferences: { session: getSession(), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true },
          },
        };
      });
      target.on('did-create-window', (child) => {
        children.add(child);
        child.on('closed', () => children.delete(child));
        guardContents(child.webContents, child);
      });
      const guard = (event, url) => { if (!httpsOnly(url)) event.preventDefault(); };
      target.on('will-navigate', guard);
      target.on('will-redirect', guard);
      target.on('did-navigate', landed);
      target.on('did-redirect-navigation', landed);
      target.on('will-redirect', landed);
    };
    guardContents(contents, win);
    const closeChildren = () => { for (const child of [...children]) { children.delete(child); if (!child.isDestroyed()) child.close(); } };

    let done = false;
    let looking = false;
    let timer = null;
    const entry = { group, app, win, children };
    entry.promise = new Promise((resolve) => {
      finish = (status) => {
        if (done) return;
        done = true;
        if (timer) timers.clearInterval(timer);
        if (current === entry) current = null;
        resolve({ status });
        closeChildren();
        if (status !== 'closed' && !win.isDestroyed()) win.close();
      };
    });
    entry.finish = finish;
    current = entry;

    if (signedInNow) {
      timer = timers.setInterval(async () => {
        if (done || looking) return;
        looking = true;
        try {
          if (await signedInNow()) finish('signed-in');
        } catch { /* looked at again next time */ } finally { looking = false; }
      }, pollMs);
    }
    win.on('closed', () => {
      closeChildren();
      if (refused || done) return;
      if (!closed) { finish('closed'); return; }
      void Promise.resolve().then(closed).then((status) => finish(status === 'signed-in' ? 'signed-in' : 'closed'), () => finish('closed'));
    });
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

  return { open, openSite, close, isOpen: () => !!current };
}

/** Sites as registrable domains ('www.linear.app' → 'linear.app'), each once. */
const registrableOf = (domains) => [...new Set((domains || []).map((domain) => String(domain).toLowerCase().replace(/^https?:\/\//, '').split('/')[0].split('.').filter(Boolean).slice(-2).join('.')).filter((domain) => domain.includes('.')))];

/** A registered app's sites (its start page's own, then its listed sites). */
const siteDomains = (app, start) => registrableOf([(() => { try { return new URL(start).hostname; } catch { return ''; } })(), ...((appOf(app) && appOf(app).sites) || [])]);

/**
 * Every cookie `session` holds for `sites` as one string (name, domain, path and value; kept in main, compared only), so
 * a sign-in made in the window shows as a change. '' when it can't be read.
 */
async function printOf(session, sites) {
  const cookies = session && session.cookies;
  if (!cookies || typeof cookies.get !== 'function') return '';
  const lines = [];
  for (const domain of sites) {
    for (const cookie of await cookies.get({ domain }).catch(() => [])) lines.push(`${cookie.domain}|${cookie.path || '/'}|${cookie.name}|${cookie.value}`);
  }
  return lines.sort().join('\n');
}

module.exports = { createSignInWindow, clearGoogleRefusal, rejectedByGoogle, POLL_MS };
