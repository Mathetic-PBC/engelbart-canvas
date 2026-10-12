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

// A copy is held only once it works (2026-10-12, "make Chrome sign-ins dependable"): a cookie can be there for a sign-in
// Google has since ended, which read "✓ Signed in" and then failed in the run. An app whose site has a check page
// (../browser/import-cookies.cjs SIGN_IN_CHECKS: Google's is myaccount.google.com) has that page asked for over Engelbart's
// browser after a copy, and whenever a copy already there is about to be counted. Signed in: held. Signed out: dropped,
// copied again from the browser (which may have signed in anew since), and checked again; still signed out, not signed in.
// No answer (offline, too slow): held, and said (`unchecked`), never waited on longer than the check's own limit. One
// answer stands for a few minutes per site, so ticking Google Drive, Gmail and Gemini asks Google once. An app with no
// check page (ChatGPT, Claude…) is held on its cookie alone, as before.
//
// Several profiles holding a sign-in (two Chrome profiles, or Chrome and Brave): the person picks one on the choose screen
// (`holdersOf`, `choose`), and the pick is remembered per sign-in (`picks`, Connect's .connect/signin-profiles.json: ids
// only, never a cookie). The remembered profile is tried first, including the copies made again above.
//
// Engelbart's own sign-in window (./signin-window.cjs, 2026-10-12) is the fallback on the Mac and the only way elsewhere:
// `supports(app)` says whether an app's sign-in can be copied from a browser (the importer is macOS's only), `canSignIn(app)`
// whether it can be signed in at all (a known sign-in cookie, read from Engelbart's own session). Once the window has signed
// an app in (`signedInHere`), its sign-in is never copied over from a browser again while Engelbart runs, not even when an
// agent finds it signed out: a copy would replace the account the person chose there.

const { appOf, READABLE_NAMES, SIGN_IN_COOKIES } = require('../../shared/connect-sources.cjs');
const { SIGN_IN_CHECKS } = require('../browser/import-cookies.cjs');

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

// The browsers a sign-in page opens in when the default can't be read (Safari), in this order.
const OPEN_ORDER = ['chrome', 'brave', 'firefox'];

// "Use another account" on a Google row waiting on the browser (2026-10-12): Google's add-an-account page, in that browser,
// straight to signing another account in.
const ANOTHER_ACCOUNT_PAGE = 'https://accounts.google.com/AddSession';

// A wait looks at the browser's cookies every POLL_MS for its first FAST_FOR_MS, then every SLOW_POLL_MS (2026-10-12): each
// look copies the cookie databases, so a wait left open for an hour should not do it every few seconds.
const POLL_MS = 4000;
const SLOW_POLL_MS = 15_000;
const FAST_FOR_MS = 2 * 60_000;
const TIMEOUT_MS = 5 * 60_000;
// How long one check's answer stands for every app on that site.
const CHECK_CACHE_MS = 3 * 60_000;
// The sites with a check page: their copies are checked, not taken on the cookie alone.
const CHECKED_SITES = new Map(SIGN_IN_CHECKS.map((check) => [check.domain, check.site]));

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

/** The key a sign-in's remembered profile is kept under: its cookie's site ('google.com' for every Google app). */
const pickKey = (app) => (SIGN_IN_COOKIES[app] || [])[0] || '';

/**
 * `cookieImport` the importer (createCookieImport, or null off macOS; its `check(domain)` asks a site's check page);
 * `defaultBrowser()` macOS's name for the default browser; `openExternal(url)` opens a page there; `openIn(browserId,
 * url)` opens one in another installed browser; `getSession()` the Stage's session (where the agents' sign-ins are);
 * `picks` { get(key) → { browser, profile } | null, set(key, pick) } the profiles the person picked; `log(line)` what is
 * worth noting (a check with no answer).
 * `pollMs` / `slowPollMs` / `fastForMs` how often a wait looks again (POLL_MS…).
 * → { supports, canSignIn, signedIn, stillSignedIn, signedInHere, isHere, browserName, signIn, signInQuiet, unlock, anotherAccount,
 *     keychainTarget, keychainNote, holdersOf, picked, choose, opensIn }
 */
function createWebSignIn({ cookieImport, defaultBrowser = () => '', openExternal, openIn = null, getSession, picks = null, log = () => {}, pollMs = POLL_MS, slowPollMs = SLOW_POLL_MS, fastForMs = FAST_FOR_MS, timeoutMs = TIMEOUT_MS, checkCacheMs = CHECK_CACHE_MS, now = () => Date.now(), sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }) }) {
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
  // Each checked site's last answer, { at, answer: Promise<true | false | null> }, shared by the apps on it.
  const verdicts = new Map();
  // The browser each sign-in (by its cookie's site) is being waited for in, while signIn waits: "Use another account".
  const waitingIn = new Map();

  /** A web app whose sign-in cookie is known: the only ones whose sign-in can be told apart, so brought over. */
  const supports = (app) => !!(cookieImport && SIGN_IN_COOKIES[app] && appOf(app) && appOf(app).reach === 'web');
  /** A web app whose sign-in can be told apart in Engelbart's own session: signed in through Engelbart's window, anywhere. */
  const canSignIn = (app) => !!(Object.hasOwn(SIGN_IN_COOKIES, app) && appOf(app) && appOf(app).reach === 'web');
  // The sign-ins (by their cookie's site) Engelbart's window made this run: never copied over from a browser again.
  const here = new Set();
  /** Whether Engelbart's window signed `app` in (or an app sharing its sign-in) while Engelbart runs. */
  const isHere = (app) => here.has(pickKey(app));
  /** Engelbart's window signed `app` in: its sign-in (every app sharing it) is not copied from a browser again this run. */
  const signedInHere = (app) => { if (pickKey(app)) { here.add(pickKey(app)); verdicts.delete(pickKey(app)); } return true; };
  /** Whether `app`'s sign-in may be copied over from a browser now. */
  const copies = (app) => supports(app) && !isHere(app);

  /** Whether Engelbart's browser holds the app's sign-in cookie (the cookie only: `works` says whether it is live). */
  async function signedIn(app) {
    const [domain, pattern] = SIGN_IN_COOKIES[app] || [];
    if (!domain) return false;
    const held = await getSession().cookies.get({ domain }).catch(() => []);
    return held.some((cookie) => pattern.test(cookie.name));
  }

  /**
   * Whether the sign-in Engelbart's browser holds for `app` works, by its site's check page → true, false (signed out) or
   * null (no answer). An app whose site has no check page: true, its cookie being all there is to go on.
   */
  function works(app) {
    const domain = pickKey(app);
    if (!CHECKED_SITES.has(domain) || !cookieImport || typeof cookieImport.check !== 'function') return Promise.resolve(true);
    const cached = verdicts.get(domain);
    if (cached && now() - cached.at < checkCacheMs) return cached.answer;
    const answer = Promise.resolve().then(() => cookieImport.check(domain)).catch(() => null).then((value) => {
      if (value == null) log(`No answer checking the ${CHECKED_SITES.get(domain)} sign-in (offline or too slow): counted as signed in.`);
      return value == null ? null : !!value;
    });
    verdicts.set(domain, { at: now(), answer });
    return answer;
  }

  /**
   * Whether the sign-in Engelbart's browser holds for `app` still stands, asked when an agent says it is signed out (an
   * agent's page or API can fail for a moment and look signed out, 2026-10-12): its cookie still held, and a fresh look
   * at its check page (where it has one) not saying signed out (no answer counts as standing).
   */
  async function stillSignedIn(app) {
    if (!(await signedIn(app))) return false;
    verdicts.delete(pickKey(app));
    return (await works(app)) !== false;
  }

  /** A copy found signed out: its sign-in cookies taken out of Engelbart's browser, so nothing counts it as held. */
  async function drop(app) {
    const [domain, pattern] = SIGN_IN_COOKIES[app] || [];
    const store = getSession().cookies;
    verdicts.delete(domain);
    if (!domain || typeof store.remove !== 'function') return;
    const held = await store.get({ domain }).catch(() => []);
    for (const cookie of held) {
      if (!pattern.test(cookie.name)) continue;
      const url = `http${cookie.secure ? 's' : ''}://${String(cookie.domain || domain).replace(/^\./, '')}${cookie.path || '/'}`;
      await store.remove(url, cookie.name).catch(() => {});
    }
  }

  /** Held and working → { live, unchecked }: a copy found signed out is dropped first. */
  async function live(app) {
    if (!(await signedIn(app))) return { live: false };
    const ok = await works(app);
    if (ok === false) { await drop(app); return { live: false, dead: true }; }
    return { live: true, unchecked: ok === null };
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

  /** The sign-in cookie a profile holds for the app → { stamp } | null (names only: no Keychain). */
  function holding(app, source, profile) {
    const [domain, pattern] = SIGN_IN_COOKIES[app];
    try {
      const hit = cookieImport.cookieNames(source.id, profile.id, domainsOf(app)).find((entry) => entry.domain === domain && pattern.test(entry.name));
      return hit ? { stamp: hit.stamp || 0 } : null;
    } catch { return null; } // locked or gone
  }

  /** The profiles of `source` that hold the app's sign-in cookie. */
  function holders(app, source) {
    return source.profiles.filter((profile) => holding(app, source, profile));
  }

  /** The profile the person picked for the app's sign-in, when one was → { browser, profile } | null. */
  function picked(app) {
    if (!picks) return null;
    try { const pick = picks.get(pickKey(app)); return pick && pick.browser && pick.profile ? { browser: pick.browser, profile: pick.profile } : null; } catch { return null; }
  }

  /** Remember `pick` ({ browser, profile }, ids) for the app's sign-in, so it is tried first from now on. */
  function choose(app, pick) {
    if (!picks || !pickKey(app) || !pick || !pick.browser || !pick.profile) return false;
    picks.set(pickKey(app), { browser: String(pick.browser), profile: String(pick.profile) });
    verdicts.delete(pickKey(app));
    return true;
  }

  /**
   * Every profile, in every browser that can be read, holding the app's sign-in → [{ browserId, browser, profileId, name,
   * email, keychain }] (`keychain`: macOS will be asked before it can be copied). Where the person is asked which one.
   */
  function holdersOf(app) {
    if (!copies(app)) return [];
    const out = [];
    for (const source of readable()) {
      for (const profile of holders(app, source)) {
        out.push({ browserId: source.id, browser: source.name, profileId: profile.id, name: profile.name || profile.id, email: profile.email || '', keychain: source.family === 'chromium' && !asked.has(source.id) });
      }
    }
    return out;
  }

  /**
   * Where the sign-in page opens: the default browser when it can be read, else (Safari, 2026-10-12) Chrome, else Brave,
   * else Firefox, whichever is installed (the importer lists only installed ones), else the first that can be opened.
   */
  function opener(sources) {
    return openers(sources)[0] || null;
  }

  /** Every browser a sign-in page can open in, in opener's order: the next is tried when one fails to open. */
  function openers(sources) {
    const defaultId = browserIdOf(defaultBrowser());
    const out = [];
    const add = (source) => { if (source && !out.includes(source)) out.push(source); };
    add(sources.find((source) => source.id === defaultId));
    for (const id of OPEN_ORDER) add(sources.find((source) => source.id === id && source.bundle));
    for (const source of sources) if (source.bundle) add(source);
    return out;
  }

  /** Whether a browser counts as installed once macOS has answered (at most ~2 s), so one that is not is never opened. */
  async function installedNow(source) {
    if (!cookieImport || typeof cookieImport.ready !== 'function') return true;
    try { return !!(await cookieImport.ready(source.id)); } catch { return true; }
  }

  /** Open `url` in `source`: the default browser through openExternal, any other with `open -b` (openIn). */
  async function openPage(source, url) {
    if (source.id === browserIdOf(defaultBrowser()) || !openIn) await openExternal(url);
    else await openIn(source.id, url);
  }

  /**
   * Open `url` in the first of `sources` (openers' order) that is installed and opens → the source, or null. One that fails
   * to open (`open -b` erring) is passed over for the next (2026-10-12), not the end of the sign-in.
   */
  async function openFirst(sources, url) {
    for (const source of openers(sources)) {
      if (!(await installedNow(source))) continue;
      try {
        await openPage(source, url);
        return source;
      } catch (error) {
        log(`Couldn't open a page in ${source.name} (${(error && error.message) || error}): trying the next browser.`);
      }
    }
    return null;
  }

  /** The browser `app`'s sign-in page would open in (signIn), by name, or '' when none can be read. */
  function opensIn(app) {
    if (!copies(app)) return '';
    const target = opener(readable());
    return target ? target.name : '';
  }

  /**
   * The app's sign-in from the first browser holding a copy that works, brought into Engelbart's browser → { browser,
   * browserId, profile, unchecked } | { refused, refusedId } | { dead } | {}. The profile the person picked goes first. A
   * browser in `denied` is not asked again; one that refuses is added to it and the next is tried. A copy found signed out
   * is dropped and the next tried; `seen` (shared across a wait's looks) keeps such a profile from being copied again until
   * its browser has set the sign-in anew. `profile` is named only when the browser has more than one.
   */
  async function bringOver(app, sources, denied, seen = new Map(), { askedOnly = false } = {}) {
    if (isHere(app)) return {};
    const domains = domainsOf(app);
    const pick = picked(app);
    const candidates = [];
    for (const source of sources) {
      for (const profile of source.profiles) {
        const first = !!(pick && pick.browser === source.id && pick.profile === profile.id);
        candidates.push({ source, profile, first });
      }
    }
    candidates.sort((a, b) => b.first - a.first);
    let refused = null;
    let failure = null;
    let dead = false;
    for (const { source, profile } of candidates) {
      const cookie = holding(app, source, profile);
      if (!cookie) continue;
      if (denied.has(source.id)) { refused = refused || source; continue; }
      // `askedOnly`: a Chromium browser macOS has not been asked about this run is passed over, so no prompt comes up.
      if (askedOnly && source.family === 'chromium' && !asked.has(source.id)) continue;
      const key = `${source.id}/${profile.id}`;
      if (seen.has(key) && seen.get(key) === cookie.stamp) { dead = true; continue; }
      try {
        await oneAtATime(source.id, () => {
          if (denied.has(source.id)) throw Object.assign(new Error('Keychain access was denied'), { denied: true });
          if (source.family === 'chromium') asked.add(source.id);
          return cookieImport.import({ browser: source.id, profile: profile.id, domains, quiet: true });
        });
      } catch (error) {
        if (error && error.denied) { refused = refused || source; denied.add(source.id); continue; }
        failure = failure || error;
        continue;
      }
      verdicts.delete(pickKey(app)); // a new copy: asked about afresh
      const now_ = await live(app);
      if (now_.live) {
        return { browser: source.name, browserId: source.id, profile: source.profiles.length > 1 ? (profile.name || profile.id) : '', ...(now_.unchecked ? { unchecked: true } : {}) };
      }
      if (now_.dead) { dead = true; seen.set(key, cookie.stamp); }
    }
    if (refused) return { refused: refused.name, refusedId: refused.id };
    if (dead) return { dead: true };
    if (failure) throw failure;
    return {};
  }

  /** bringOver's answer, as signIn and signInQuiet give it: the browser and profile it came from. */
  const from = (found, extra = {}) => ({ browser: found.browser, ...(found.profile ? { profile: found.profile } : {}), ...(found.unchecked ? { unchecked: true } : {}), ...extra });

  /**
   * Sign in to `app` → { status: 'signed-in', browser, profile?, opened, unchecked? } | { status: 'timeout', browser } |
   * { status: 'cancelled' } | { status: 'denied', browser, browserId } (macOS refused every browser holding it) |
   * { status: 'no-browser' } (none can be read) | { status: 'unsupported', browser } (no known sign-in cookie, or signed in
   * through Engelbart's window this run, so never copied: Engelbart's window is where it signs in again).
   * `onOpened(browser)` once the sign-in page is open there. Held already and working: signed in, and macOS is not asked.
   * `timeoutMs` Infinity waits until signed in or `signal` aborts (Google's Sign in on the choose screen, 2026-10-12).
   * `denied` the browsers macOS refused this run (not asked again; one refusing now is added).
   */
  async function signIn(app, { signal = null, onOpened = () => {}, timeoutMs: limit = timeoutMs, denied: deniedBefore = null } = {}) {
    const held = supports(app) ? await live(app) : { live: await signedIn(app) };
    if (held.live) return { status: 'signed-in', browser: '', opened: false, ...(held.unchecked ? { unchecked: true } : {}) };
    if (!copies(app) || !cookieImport) return { status: 'unsupported', browser: browserName() };
    const sources = readable();
    if (!sources.length) return { status: 'no-browser' };
    const denied = deniedBefore || new Set();
    const seen = new Map();
    const first = await bringOver(app, sources, denied, seen);
    if (first.browser) return { status: 'signed-in', ...from(first), opened: false };
    if (first.refused) return { status: 'denied', browser: first.refused, browserId: first.refusedId };
    if (signal && signal.aborted) return { status: 'cancelled' };
    const url = SIGN_IN_PAGES[app] || appOf(app).start;
    const target = await openFirst(sources, url);
    if (!target) return { status: 'no-browser' };
    onOpened(target.name);
    const key = pickKey(app);
    waitingIn.set(key, target);
    try {
      const until = Date.now() + limit;
      let waited = 0;
      while (Date.now() < until) {
        const wait = waited < fastForMs ? pollMs : slowPollMs;
        await sleep(wait);
        waited += wait;
        if (signal && signal.aborted) return { status: 'cancelled' };
        // Signed in through Engelbart's window meanwhile ("Sign in here instead"): that sign-in stands.
        if (isHere(app)) return (await signedIn(app)) ? { status: 'signed-in', browser: '', opened: true } : { status: 'cancelled' };
        const found = await bringOver(app, sources, denied, seen);
        if (found.browser) return { status: 'signed-in', ...from(found), opened: true };
        if (found.refused) return { status: 'denied', browser: found.refused, browserId: found.refusedId };
      }
    } finally {
      if (waitingIn.get(key) === target) waitingIn.delete(key);
    }
    return { status: 'timeout', browser: target.name };
  }

  /**
   * Whether the app's sign-in is in Engelbart's browser and works, or can be brought over without opening anything →
   * { signedIn, browser, profile?, unchecked?, refused, refusedId, noBrowser }. A copy held that is signed out is copied
   * again from the browser and checked again. `denied` is shared across checks (the choose screen's lasts while Engelbart
   * runs), so macOS is never asked twice about one browser; `noBrowser` when no browser's cookies can be read. `askedOnly`
   * (a sign-in lost partway through a run, 2026-10-12): only browsers macOS was asked about already, so it asks nothing new;
   * `fresh` the copy held dropped first, as an agent found it signed out. A sign-in Engelbart's window made this run is only
   * looked at, never copied (`here`: true), as is every sign-in off the Mac; `fresh`, it is dropped and not signed in.
   */
  async function signInQuiet(app, { denied = new Set(), askedOnly = false, fresh = false } = {}) {
    // Signed in through Engelbart's window this run, or off the Mac (nothing to copy from): Engelbart's own session alone.
    if (canSignIn(app) && (isHere(app) || !supports(app))) {
      const mark = isHere(app) ? { here: true } : {};
      if (fresh) { await drop(app); return { signedIn: false, browser: '', ...mark }; }
      const held = await live(app);
      return held.live ? { signedIn: true, browser: '', ...mark, ...(held.unchecked ? { unchecked: true } : {}) } : { signedIn: false, browser: '', ...mark };
    }
    if (!supports(app) || !cookieImport) return { signedIn: false, browser: '' };
    // `fresh`: the copy held is known not to work (an agent hit the app's login page): dropped, and copied anew.
    if (fresh) await drop(app);
    const held = fresh ? { live: false } : await live(app);
    if (held.live) return { signedIn: true, browser: '', ...(held.unchecked ? { unchecked: true } : {}) };
    const sources = readable();
    if (!sources.length) return { signedIn: false, browser: '', noBrowser: true };
    const found = await bringOver(app, sources, denied, new Map(), { askedOnly }).catch(() => ({}));
    return found.browser ? { signedIn: true, ...from(found) } : { signedIn: false, browser: '', refused: found.refused || '', refusedId: found.refusedId || '' };
  }

  /**
   * "Use another account" (2026-10-12): while `app`'s sign-in (a Google one) is waited for in a browser, Google's
   * add-an-account page opens in that same browser. The wait goes on, and copies whichever account signs in there → { opened, browser }.
   */
  async function anotherAccount(app) {
    if (!copies(app) || pickKey(app) !== 'google.com') return { opened: false, browser: '' };
    const target = waitingIn.get(pickKey(app));
    if (!target) return { opened: false, browser: '' };
    try {
      await openPage(target, ANOTHER_ACCOUNT_PAGE);
      return { opened: true, browser: target.name };
    } catch (error) {
      log(`Couldn't open Google's add-an-account page in ${target.name} (${(error && error.message) || error}).`);
      return { opened: false, browser: target.name };
    }
  }

  /**
   * Ask macOS for the Keychain key of the browser `app`'s sign-in will be copied from, before anything opens (2026-10-12:
   * Google's Sign in asked only once the sign-in showed up, minutes later, with nothing on screen explaining it). Copies
   * nothing; the key is kept for the run, so the copy later needs no second prompt →
   *   { status: 'allowed', browser } (or nothing to ask: Firefox, asked already, no browser) |
   *   { status: 'denied', browser, browserId }.
   * A browser in `denied` (refused this run) is not asked again.
   */
  async function unlock(app, { denied = null } = {}) {
    if (!copies(app) || !cookieImport || typeof cookieImport.unlock !== 'function') return { status: 'allowed', browser: '' };
    const target = keychainTarget(app);
    if (!target) return { status: 'allowed', browser: '' };
    if (denied && denied.has(target.id)) return { status: 'denied', browser: target.name, browserId: target.id };
    try {
      await oneAtATime(target.id, () => {
        asked.add(target.id);
        return cookieImport.unlock(target.id);
      });
      return { status: 'allowed', browser: target.name };
    } catch (error) {
      if (error && error.denied) {
        if (denied) denied.add(target.id);
        // Try again comes back here through the panel, which says macOS will ask: not counted as asked.
        asked.delete(target.id);
        return { status: 'denied', browser: target.name, browserId: target.id };
      }
      // Not installed after all, or no key yet (a browser that never stored one): nothing to ask; the copy says what it finds.
      return { status: 'allowed', browser: target.name };
    }
  }

  /**
   * The browser macOS will be asked about to bring the app's sign-in over, when it has not been yet while Engelbart runs →
   * { id, name } | null: the one picked, else the first holding it, else where its sign-in page would open; Firefox needs no
   * Keychain. `holdersOnly` (the choose screen's check when an app is ticked, 2026-10-11): only a browser holding the
   * sign-in, since the check opens nothing, so with none macOS is not asked and there is no browser to name.
   */
  function keychainTarget(app, { holdersOnly = false } = {}) {
    if (!copies(app) || !cookieImport) return null;
    const sources = readable();
    const pick = picked(app);
    const target = (pick && sources.find((source) => source.id === pick.browser && holders(app, source).some((profile) => profile.id === pick.profile)))
      || sources.find((source) => holders(app, source).length) || (holdersOnly ? null : opener(sources));
    if (!target || target.family !== 'chromium' || asked.has(target.id)) return null;
    return { id: target.id, name: target.name };
  }

  /** What to tell the person before Log in first asks macOS for a browser's sign-ins this run, or ''. `options` as keychainTarget's. */
  function keychainNote(app, options) {
    const target = keychainTarget(app, options);
    return target ? `macOS will ask to use ${target.name}'s sign-ins. Choose Allow.` : '';
  }

  return { supports, canSignIn, signedIn, stillSignedIn, signedInHere, isHere, browserName, signIn, signInQuiet, unlock, anotherAccount, keychainTarget, keychainNote, holdersOf, picked, choose, opensIn, readableCount: () => readable().length };
}

module.exports = { createWebSignIn, SIGN_IN_COOKIES, SIGN_IN_PAGES, ANOTHER_ACCOUNT_PAGE, READABLE_NAMES, domainsOf, browserIdOf };
