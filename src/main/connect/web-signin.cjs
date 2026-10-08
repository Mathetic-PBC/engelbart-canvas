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
// A default browser whose cookies Engelbart cannot read (Safari) is 'unsupported': the caller falls back to the agent's
// own window, as before.

const { appOf } = require('../../shared/connect-sources.cjs');

// The cookie that holds each app's sign-in: the registrable domain it is on, and its name.
const SIGN_IN_COOKIES = Object.freeze({
  ChatGPT: ['chatgpt.com', /session-token/],
  Claude: ['claude.ai', /^sessionKey$/],
  'Google Docs': ['google.com', /^(__Secure-1PSID|SID)$/],
  'Google Meet': ['google.com', /^(__Secure-1PSID|SID)$/],
  Gemini: ['google.com', /^(__Secure-1PSID|SID)$/],
  Overleaf: ['overleaf.com', /^overleaf_session/],
  Perplexity: ['perplexity.ai', /session-token/],
  Grok: ['grok.com', /^sso$/],
  Notion: ['notion.so', /^token_v2$/],
});

// Where the default browser is sent to sign in; any other app, its start page (which asks for a sign-in when there is none).
const SIGN_IN_PAGES = Object.freeze({
  ChatGPT: 'https://chatgpt.com/auth/login',
  Claude: 'https://claude.ai/login',
  'Google Docs': 'https://accounts.google.com/',
  'Google Meet': 'https://accounts.google.com/',
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
 * browser; `openExternal(url)` opens a page there; `getSession()` the Stage's session (where the agents' sign-ins are).
 * → { supports, signedIn, browserName, signIn }
 */
function createWebSignIn({ cookieImport, defaultBrowser = () => '', openExternal, getSession, pollMs = POLL_MS, timeoutMs = TIMEOUT_MS, sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }) }) {
  /** A web app whose sign-in cookie is known: the only ones whose sign-in can be told apart, so brought over. */
  const supports = (app) => !!(SIGN_IN_COOKIES[app] && appOf(app) && appOf(app).reach === 'web');

  /** Whether Engelbart's browser holds the app's sign-in cookie. */
  async function signedIn(app) {
    const [domain, pattern] = SIGN_IN_COOKIES[app] || [];
    if (!domain) return false;
    const held = await getSession().cookies.get({ domain }).catch(() => []);
    return held.some((cookie) => pattern.test(cookie.name));
  }

  const browserName = () => String(defaultBrowser() || '').replace(/^Google /, '') || 'your browser';

  /** The app's sign-in from a profile of `browserId` that has it, brought into Engelbart's browser → its name, or ''. */
  async function bringOver(app, browserId, profiles) {
    const [domain, pattern] = SIGN_IN_COOKIES[app];
    const domains = domainsOf(app);
    for (const profile of profiles) {
      let names;
      try { names = cookieImport.cookieNames(browserId, profile.id, domains); } catch { continue; } // locked or gone: the next
      if (!names.some((entry) => entry.domain === domain && pattern.test(entry.name))) continue;
      await cookieImport.import({ browser: browserId, profile: profile.id, domains, quiet: true }); // a Keychain refusal throws
      if (await signedIn(app)) return profile.name || profile.id;
    }
    return '';
  }

  /**
   * Sign in to `app` in the default browser → { status: 'signed-in', browser, opened } | { status: 'timeout', browser } |
   * { status: 'cancelled' } | { status: 'unsupported', browser }. `onOpened(browser)` once the sign-in page is open there.
   * Throws when the browser's cookies cannot be read (a Keychain refusal).
   */
  async function signIn(app, { signal = null, onOpened = () => {} } = {}) {
    const name = browserName();
    const id = supports(app) && cookieImport ? browserIdOf(defaultBrowser()) : null;
    const source = id ? (cookieImport.sources() || []).find((entry) => entry.id === id) : null;
    if (!source || !source.profiles.length) return { status: 'unsupported', browser: name };
    // Chromium's first profile ("Default") first: most people have only that one.
    const profiles = [...source.profiles].sort((a, b) => (b.id === 'Default') - (a.id === 'Default'));
    if (await bringOver(app, id, profiles)) return { status: 'signed-in', browser: name, opened: false };
    if (signal && signal.aborted) return { status: 'cancelled' };
    await openExternal(SIGN_IN_PAGES[app] || appOf(app).start);
    onOpened(name);
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      await sleep(pollMs);
      if (signal && signal.aborted) return { status: 'cancelled' };
      if (await bringOver(app, id, profiles)) return { status: 'signed-in', browser: name, opened: true };
    }
    return { status: 'timeout', browser: name };
  }

  return { supports, signedIn, browserName, signIn };
}

module.exports = { createWebSignIn, SIGN_IN_COOKIES, SIGN_IN_PAGES, domainsOf, browserIdOf };
