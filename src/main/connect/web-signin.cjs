'use strict';

// Connect your library: signing in to a web app (ChatGPT, Claude, Google…) in the person's own default browser, not in
// Engelbart's (2026-10-08, "Agent onboarding": "when it asks me to login to chatgpt or claude it opens a window … it should
// be using my default browser, not engelbart's browser since i'm likely not signed in there"). The agents still read the app
// in Engelbart's hidden browser (./browser.cjs), so the sign-in the person's browser holds is brought over: its cookies for
// the app's sites, through the Stage's sign-in import (../browser/import-cookies.cjs). Log in:
//   1. the default browser is signed in already: its sign-in comes over, and nothing opens;
//   2. it is not: the app's sign-in page opens in the default browser, and every few seconds that browser's cookies are
//      looked at again (names only, no Keychain) until the app's sign-in cookie is there; then it comes over. A browser
//      writes its cookies to disk within about half a minute of a sign-in;
//   3. done only once Engelbart's browser holds the sign-in (2026-10-08: "even when i signed into chatgpt in the engelbart
//      window it made me do it again"), never because a window was closed.
// A default browser whose cookies Engelbart cannot read (Safari) is passed over (2026-10-09): another installed browser that
// can be read is used instead — one already holding the app's sign-in, else Chrome, else the first one found — with the page
// opened there (`openIn`, `open -b <bundle id>`). With none installed, 'no-browser': the caller says which browsers it needs.
// A Keychain refusal on one browser goes on to the next that holds the sign-in (Firefox needs no Keychain); only when none is
// left is it 'denied'. `signInQuiet` is the same without ever opening a page: the check made when a web app is ticked on the
// choose screen (2026-10-10, after `keychainTarget` says which browser macOS will be asked about) or before the survey starts.

const { appOf, READABLE_NAMES, SIGN_IN_COOKIES } = require('../../shared/connect-sources.cjs');

// Where the default browser is sent to sign in; any other app, its start page (which asks for a sign-in when there is none).
const SIGN_IN_PAGES = Object.freeze({
  ChatGPT: 'https://chatgpt.com/auth/login',
  Claude: 'https://claude.ai/login',
  'Google Docs': 'https://accounts.google.com/',
  'Google Meet': 'https://accounts.google.com/',
  Gmail: 'https://accounts.google.com/',
  Gemini: 'https://accounts.google.com/',
  Overleaf: 'https://www.overleaf.com/login',
});

// macOS's name for the default browser (app.getApplicationNameForProtocol) → the importer's id. Safari has none.
const BROWSER_NAMES = [[/chromium/i, 'chromium'], [/canary/i, null], [/chrome/i, 'chrome'], [/brave/i, 'brave'], [/edge/i, 'edge'], [/vivaldi/i, 'vivaldi'], [/opera/i, 'opera'], [/^arc\b/i, 'arc'], [/comet/i, 'comet'], [/^dia\b/i, 'dia'], [/firefox/i, 'firefox']];

const POLL_MS = 4000;
const TIMEOUT_MS = 5 * 60_000;

/** The registrable domains of an app's sites ('docs.google.com' → 'google.com'), the cookie's own first. */
function domainsOf(app) {
  const [own] = SIGN_IN_COOKIES[app] || [];
  const out = new Set(own ? [own] : []);
  for (const site of (appOf(app) && appOf(app).sites) || []) {
    const labels = String(site).toLowerCase().split('.').filter(Boolean);
    if (labels.length >= 2) out.add(labels.slice(-2).join('.'));
  }
  return [...out];
}

/** The importer's id for the default browser's name, or null when it is one whose cookies Engelbart cannot read. */
function browserIdOf(name) {
  const hit = BROWSER_NAMES.find(([pattern]) => pattern.test(String(name || '').trim()));
  return hit ? hit[1] : null;
}

/**
 * `cookieImport` the importer (createCookieImport, or null off macOS); `defaultBrowser()` macOS's name for the default
 * browser; `openExternal(url)` opens a page there; `openIn(browserId, url)` opens one in another installed browser;
 * `getSession()` the Stage's session (where the agents' sign-ins are).
 * → { supports, signedIn, browserName, signIn, signInQuiet, keychainTarget, keychainNote }
 */
function createWebSignIn({ cookieImport, defaultBrowser = () => '', openExternal, openIn = null, getSession, pollMs = POLL_MS, timeoutMs = TIMEOUT_MS, sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }) }) {
  // The Chromium browsers whose Keychain key has been asked for while Engelbart runs (keychainNote).
  const asked = new Set();
  // One import per browser at a time: two apps looked at together wait for the one answer macOS gives (a refusal is then
  // known before the second asks, so macOS is asked once).
  const queues = new Map();
  const oneAtATime = (id, work) => {
    const next = (queues.get(id) || Promise.resolve()).then(work);
    queues.set(id, next.catch(() => {}));
    return next;
  };

  /** A web app whose sign-in cookie is known: the only ones whose sign-in can be told apart, so brought over. */
  const supports = (app) => !!(cookieImport && SIGN_IN_COOKIES[app] && appOf(app) && appOf(app).reach === 'web');

  /** Whether Engelbart's browser holds the app's sign-in cookie. */
  async function signedIn(app) {
    const [domain, pattern] = SIGN_IN_COOKIES[app] || [];
    if (!domain) return false;
    const held = await getSession().cookies.get({ domain }).catch(() => []);
    return held.some((cookie) => pattern.test(cookie.name));
  }

  const browserName = () => String(defaultBrowser() || '').replace(/^Google /, '') || 'your browser';

  /** The installed browsers whose cookies can be read, the default first, each one's "Default" profile first. */
  function readable() {
    let found = [];
    try { found = (cookieImport && cookieImport.sources()) || []; } catch { found = []; }
    const defaultId = browserIdOf(defaultBrowser());
    return found
      .filter((source) => source.profiles && source.profiles.length)
      .map((source) => ({ ...source, profiles: [...source.profiles].sort((a, b) => (b.id === 'Default') - (a.id === 'Default')) }))
      .sort((a, b) => (b.id === defaultId) - (a.id === defaultId));
  }

  /** The profiles of `source` that hold the app's sign-in cookie (names only: no Keychain). */
  function holders(app, source) {
    const [domain, pattern] = SIGN_IN_COOKIES[app];
    const domains = domainsOf(app);
    return source.profiles.filter((profile) => {
      try {
        return cookieImport.cookieNames(source.id, profile.id, domains).some((entry) => entry.domain === domain && pattern.test(entry.name));
      } catch { return false; } // locked or gone
    });
  }

  /** Where the sign-in page opens: the default browser when it can be read, else Chrome, else the first that can be opened. */
  function opener(sources) {
    const defaultId = browserIdOf(defaultBrowser());
    return sources.find((source) => source.id === defaultId)
      || sources.find((source) => source.id === 'chrome' && source.bundle)
      || sources.find((source) => source.bundle)
      || null;
  }

  /**
   * The app's sign-in from the first browser holding it, brought into Engelbart's browser → { browser } | { refused,
   * refusedId } | {}. A browser in `denied` is not asked again; one that refuses is added to it and the next is tried. A
   * browser holding the sign-in that macOS refused, now or before, is the one named when none other had it.
   */
  async function bringOver(app, sources, denied) {
    const domains = domainsOf(app);
    let refused = null;
    let failure = null;
    for (const source of sources) {
      const holding = holders(app, source);
      if (denied.has(source.id)) { if (holding.length) refused = refused || source; continue; }
      for (const profile of holding) {
        try {
          await oneAtATime(source.id, () => {
            if (denied.has(source.id)) throw Object.assign(new Error('Keychain access was denied'), { denied: true });
            if (source.family === 'chromium') asked.add(source.id);
            return cookieImport.import({ browser: source.id, profile: profile.id, domains, quiet: true });
          });
        } catch (error) {
          if (error && error.denied) { refused = refused || source; denied.add(source.id); break; }
          failure = failure || error;
          continue;
        }
        if (await signedIn(app)) return { browser: source.name };
      }
    }
    if (refused) return { refused: refused.name, refusedId: refused.id };
    if (failure) throw failure;
    return {};
  }

  /**
   * Sign in to `app` → { status: 'signed-in', browser, opened } | { status: 'timeout', browser } | { status: 'cancelled' } |
   * { status: 'denied', browser, browserId } (macOS refused every browser holding it) | { status: 'no-browser' } (none can
   * be read) | { status: 'unsupported', browser } (no known sign-in cookie). `onOpened(browser)` once the sign-in page is
   * open there. Held already (a check when it was ticked brought it over): signed in, and macOS is not asked.
   */
  async function signIn(app, { signal = null, onOpened = () => {} } = {}) {
    if (await signedIn(app)) return { status: 'signed-in', browser: '', opened: false };
    if (!supports(app) || !cookieImport) return { status: 'unsupported', browser: browserName() };
    const sources = readable();
    if (!sources.length) return { status: 'no-browser' };
    const denied = new Set();
    const first = await bringOver(app, sources, denied);
    if (first.browser) return { status: 'signed-in', browser: first.browser, opened: false };
    if (first.refused) return { status: 'denied', browser: first.refused, browserId: first.refusedId };
    if (signal && signal.aborted) return { status: 'cancelled' };
    const target = opener(sources);
    if (!target) return { status: 'no-browser' };
    const url = SIGN_IN_PAGES[app] || appOf(app).start;
    if (target.id === browserIdOf(defaultBrowser()) || !openIn) await openExternal(url);
    else await openIn(target.id, url);
    onOpened(target.name);
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      await sleep(pollMs);
      if (signal && signal.aborted) return { status: 'cancelled' };
      const found = await bringOver(app, sources, denied);
      if (found.browser) return { status: 'signed-in', browser: found.browser, opened: true };
      if (found.refused) return { status: 'denied', browser: found.refused, browserId: found.refusedId };
    }
    return { status: 'timeout', browser: target.name };
  }

  /**
   * Whether the app's sign-in is in Engelbart's browser or can be brought over without opening anything → { signedIn,
   * browser, refused, refusedId, noBrowser }. `denied` is shared across checks (the choose screen's lasts while Engelbart
   * runs), so macOS is never asked twice about one browser; `noBrowser` when no browser's cookies can be read.
   */
  async function signInQuiet(app, { denied = new Set() } = {}) {
    if (!supports(app) || !cookieImport) return { signedIn: false, browser: '' };
    if (await signedIn(app)) return { signedIn: true, browser: '' };
    const sources = readable();
    if (!sources.length) return { signedIn: false, browser: '', noBrowser: true };
    const found = await bringOver(app, sources, denied).catch(() => ({}));
    return found.browser ? { signedIn: true, browser: found.browser } : { signedIn: false, browser: '', refused: found.refused || '', refusedId: found.refusedId || '' };
  }

  /**
   * The browser macOS will be asked about to bring the app's sign-in over, when it has not been yet while Engelbart runs →
   * { id, name } | null: the first holding it, else where its sign-in page would open; Firefox needs no Keychain.
   * `holdersOnly` (the choose screen's check when an app is ticked, 2026-10-11): only a browser holding the sign-in, since
   * the check opens nothing, so with none macOS is not asked and there is no browser to name.
   */
  function keychainTarget(app, { holdersOnly = false } = {}) {
    if (!supports(app) || !cookieImport) return null;
    const sources = readable();
    const target = sources.find((source) => holders(app, source).length) || (holdersOnly ? null : opener(sources));
    if (!target || target.family !== 'chromium' || asked.has(target.id)) return null;
    return { id: target.id, name: target.name };
  }

  /** What to tell the person before Log in first asks macOS for a browser's sign-ins this run, or ''. `options` as keychainTarget's. */
  function keychainNote(app, options) {
    const target = keychainTarget(app, options);
    return target ? `macOS will ask to use ${target.name}'s sign-ins. Choose Always Allow so it doesn't ask again.` : '';
  }

  return { supports, signedIn, browserName, signIn, signInQuiet, keychainTarget, keychainNote };
}

module.exports = { createWebSignIn, SIGN_IN_COOKIES, SIGN_IN_PAGES, READABLE_NAMES, domainsOf, browserIdOf };
