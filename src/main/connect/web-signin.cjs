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
// One browser and one profile, chosen once (2026-10-16, C4: the Onboarding note's "Select your {browser} profile", and Bart:
// "Treat the selected profile as a boundary … rather than silently trying other accounts"): the browser the person picked
// (`chosen().browser`, else the default) and its profile (`chosen().profile`, else the one picked for this sign-in before,
// else "Default", else its first) are the only ones any copy reads and the only place a page opens. Nothing falls through
// to another profile or browser any more (it used to pass over Safari and a refusing Keychain for the next browser). Safari
// is read like the others now (../browser/safari-cookies.cjs) once Full Disk Access is granted; before, a copy says
// `needs: 'disk-access'`. `signInQuiet` is the same without ever opening a page: the check made when a web app is ticked on
// the choose screen (2026-10-10, after `keychainTarget` says which browser macOS will be asked about) or before the survey.
//
// The Keychain answer (`chosen().keychain`, onboarding's "Allow Engelbart to use your <browser> sign-ins?", C5/C6): declined,
// nothing is copied from the browser at all; allowed, macOS may be asked (`unlockBrowser` asks at once, on Allow); unanswered,
// a quiet look that may only use what macOS was asked already (`askedOnly`) asks nothing.
//
// Every tool, not only the registered apps (2026-10-16, C7/C8: "Modify the code such that it uses the cookies for all tools,
// including ones in the 'other' category or that are added by the agents"): `copyFor({ name, domains })` copies a tool's
// sites from the chosen profile, and `recapture` is the native-browser fallback ("have the user sign in to the application
// in their native browser, capture these new/updated cookies"): copied at once when they are there, else the page opens in
// the chosen browser and profile and the cookies are copied once they appear or change. A copy that fails its check is
// undone completely (C3: every cookie it wrote, not only the session cookie; 16 Google cookies of other accounts were left).

// A copy is held only once it works (2026-10-12, "make Chrome sign-ins dependable"): a cookie can be there for a sign-in
// Google has since ended, which read "✓ Signed in" and then failed in the run. An app whose site has a check page
// (../browser/import-cookies.cjs SIGN_IN_CHECKS: Google's is Drive's own page) has that page asked for over Engelbart's
// browser after a copy, and whenever a copy already there is about to be counted. Signed in: held. Signed out: dropped,
// copied again from the browser (which may have signed in anew since), and checked again; still signed out, not signed in.
// No answer (offline, too slow): held, and said (`unchecked`), never waited on longer than the check's own limit. One
// answer stands for a few minutes per site, so ticking Google Drive, Gmail and Gemini asks Google once. An app with no
// check page (ChatGPT, Notion…) is held on its cookie alone, as before (Claude has one since 2026-10-16).
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

const { appOf, READABLE_NAMES, SIGN_IN_COOKIES, signsInThroughBrowser } = require('../../shared/connect-sources.cjs');
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

// macOS's name for the default browser (app.getApplicationNameForProtocol) → the importer's id (Safari's too, 2026-10-16).
const BROWSER_NAMES = [[/chromium/i, 'chromium'], [/canary/i, null], [/chrome/i, 'chrome'], [/brave/i, 'brave'], [/edge/i, 'edge'], [/vivaldi/i, 'vivaldi'], [/opera/i, 'opera'], [/^arc\b/i, 'arc'], [/comet/i, 'comet'], [/^dia\b/i, 'dia'], [/firefox/i, 'firefox'], [/technology preview/i, null], [/^safari\b/i, 'safari']];

// "Use another account" on a Google row waiting on the browser (2026-10-12): Google's add-an-account page, in that browser,
// straight to signing another account in.
const ANOTHER_ACCOUNT_PAGE = 'https://accounts.google.com/AddSession';

// A wait looks at the browser's cookies every POLL_MS for its first FAST_FOR_MS, then every SLOW_POLL_MS (2026-10-12): each
// look copies the cookie databases, so a wait left open for an hour should not do it every few seconds.
const POLL_MS = 4000;
const SLOW_POLL_MS = 15_000;
const FAST_FOR_MS = 2 * 60_000;
const TIMEOUT_MS = 5 * 60_000;
// recapture's wait when the chosen browser already holds the sign-in and Engelbart's copy of it was turned away (2026-10-16:
// "Google Drive sign in kept saying Waiting…" for its ten minutes): the page opens there in case that browser's own
// sign-in ended too, and is waited on this long for a new one; a new one turned away as well ends it at once.
const HELD_WAIT_MS = 2 * 60_000;
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

/** A tool's sites as registrable domains ('www.linear.app' → 'linear.app'), each once, nonsense left out. */
const registrable = (domains) => [...new Set((domains || []).map((domain) => String(domain).toLowerCase().trim().replace(/^https?:\/\//, '').split('/')[0].split('.').filter(Boolean).slice(-2).join('.')).filter((domain) => domain.includes('.')))];

/**
 * The `open` arguments that show `url` in one profile of a Chromium browser (C8): a second launch with
 * --profile-directory hands the page to the running browser, in that profile ("Profile 1", "Default").
 */
const profileOpenArgs = (bundle, profileId, url) => ['-n', '-b', bundle, '--args', `--profile-directory=${profileId}`, url];

/**
 * `cookieImport` the importer (createCookieImport, or null off macOS; its `check(domain)` asks a site's check page);
 * `defaultBrowser()` macOS's name for the default browser; `openExternal(url)` opens a page there; `openIn(browserId,
 * url)` opens one in another installed browser; `openInProfile(browserId, profileId, url)` one in a given profile of a
 * Chromium browser (profileOpenArgs; without it, the browser's own last profile); `getSession()` the Stage's session (where
 * the agents' sign-ins are); `picks` { get(key) → { browser, profile } | null, set(key, pick) } the profiles the person
 * picked per sign-in; `chosen()` → { browser, profile, keychain } the browser, profile and Keychain answer onboarding
 * remembered (../onboarding/prefs.cjs); `log(line, detail?)` what is worth noting (every check's answer, C2).
 * `pollMs` / `slowPollMs` / `fastForMs` how often a wait looks again (POLL_MS…).
 * → { supports, canSignIn, signedIn, stillSignedIn, signedInHere, isHere, browserName, signIn, signInQuiet, unlock, anotherAccount,
 *     keychainTarget, keychainNote, holdersOf, picked, choose, opensIn, copyFor, recapture, unlockBrowser, profilesOf }
 */
function createWebSignIn({ cookieImport, defaultBrowser = () => '', openExternal, openIn = null, openInProfile = null, getSession, picks = null, chosen = () => ({}), log = () => {}, pollMs = POLL_MS, slowPollMs = SLOW_POLL_MS, fastForMs = FAST_FOR_MS, timeoutMs = TIMEOUT_MS, heldWaitMs = HELD_WAIT_MS, checkCacheMs = CHECK_CACHE_MS, now = () => Date.now(), sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }) }) {
  // The Chromium browsers whose Keychain key has been asked for while Engelbart runs (keychainNote).
  const asked = new Set();
  // The browsers macOS refused when Allow asked for them at once (unlockBrowser): not asked again until Allow asks again.
  const refusedHere = new Set();
  /** What onboarding remembered → { browser, profile, keychain } (any of them null). */
  const choice = () => { try { const value = chosen() || {}; return { browser: value.browser || null, profile: value.profile || null, keychain: value.keychain || null }; } catch { return { browser: null, profile: null, keychain: null }; } };
  /** The browser every copy reads: the one picked, else the default (by its name). */
  const chosenId = () => choice().browser || browserIdOf(defaultBrowser());
  /** Whether the importer can read `id` now (Safari: Full Disk Access granted). */
  const canRead = (id) => { try { return !cookieImport || typeof cookieImport.canRead !== 'function' || cookieImport.canRead(id) !== false; } catch { return false; } };
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

  // A web app, or a connector app with sites of its own (Notion, round 3: its sign-in was never copied, so its Log in fell
  // through to Engelbart's window), whose sign-in cookie is known.
  const onTheWeb = (app) => !!(appOf(app) && (appOf(app).reach === 'web' || (appOf(app).reach === 'connector' && (appOf(app).sites || []).length)));
  /** A web app whose sign-in cookie is known: the only ones whose sign-in can be told apart, so brought over. */
  const supports = (app) => !!(cookieImport && SIGN_IN_COOKIES[app] && onTheWeb(app));
  /** A web app whose sign-in can be told apart in Engelbart's own session: signed in through Engelbart's window, anywhere. */
  const canSignIn = (app) => !!(Object.hasOwn(SIGN_IN_COOKIES, app) && onTheWeb(app));
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
    if (!CHECKED_SITES.has(domain)) return Promise.resolve(true);
    return checkSite(domain);
  }

  /**
   * A checked site's answer (../browser/import-cookies.cjs: 2xx signed in, its login page or a 401 signed out, anything else
   * null) → true | false | null, the same for every app on it for a few minutes. Every answer is logged with the status and
   * where a redirect went (C2), so the trace says why a sign-in was kept or dropped. No check page, or no importer: null.
   */
  function checkSite(domain) {
    if (!CHECKED_SITES.has(domain) || !cookieImport || (typeof cookieImport.check !== 'function' && typeof cookieImport.checkDetail !== 'function')) return Promise.resolve(null);
    const cached = verdicts.get(domain);
    if (cached && now() - cached.at < checkCacheMs) return cached.answer;
    const site = CHECKED_SITES.get(domain);
    const asking = typeof cookieImport.checkDetail === 'function'
      ? Promise.resolve().then(() => cookieImport.checkDetail(domain))
      : Promise.resolve().then(() => cookieImport.check(domain)).then((signedIn) => ({ signedIn }));
    const answer = asking.catch(() => null).then((detail) => {
      const value = detail && detail.signedIn != null ? !!detail.signedIn : null;
      const said = detail && (detail.status || detail.location) ? ` (${detail.status || 'no status'}${detail.location ? ` → ${detail.location}` : ''})` : detail && detail.reason ? ` (${detail.reason})` : '';
      if (value == null) log(`No answer checking the ${site} sign-in${said || ' (offline or too slow)'}: counted as signed in.`, { kind: 'signin-check', site, domain, verdict: 'unknown', ...(detail || {}) });
      else log(`Checked the ${site} sign-in${said}: ${value ? 'signed in' : 'signed out'}.`, { kind: 'signin-check', site, domain, verdict: value ? 'signed-in' : 'signed-out', ...(detail || {}) });
      return value;
    });
    verdicts.set(domain, { at: now(), answer });
    return answer;
  }

  /** What Engelbart's browser holds for `domains` → Map(domain|path|name → cookie), values kept in main only (C3). */
  async function snapshot(domains) {
    const store = getSession().cookies;
    const out = new Map();
    for (const domain of domains) {
      const held = await store.get({ domain }).catch(() => []);
      for (const cookie of held || []) out.set(`${String(cookie.domain || domain).replace(/^\./, '')}|${cookie.path || '/'}|${cookie.name}`, cookie);
    }
    return out;
  }

  /**
   * A copy that failed its check undone completely (C3): every cookie of `domains` it wrote or changed taken out, and any
   * it overwrote put back as it was (`before`, snapshot()). Cookies it left alone stay.
   */
  async function undo(before, domains) {
    const store = getSession().cookies;
    if (typeof store.remove !== 'function') return;
    const after = await snapshot(domains);
    for (const [key, cookie] of after) {
      const was = before.get(key);
      if (was && was.value === cookie.value) continue;
      const host = String(cookie.domain || '').replace(/^\./, '');
      await store.remove(`http${cookie.secure ? 's' : ''}://${host}${cookie.path || '/'}`, cookie.name).catch(() => {});
      if (was && typeof store.set === 'function') {
        const back = { url: `http${was.secure ? 's' : ''}://${host}${was.path || '/'}`, name: was.name, value: was.value, path: was.path || '/', secure: !!was.secure, httpOnly: !!was.httpOnly, ...(was.sameSite ? { sameSite: was.sameSite } : {}), ...(was.hostOnly ? {} : { domain: was.domain }), ...(was.session || !was.expirationDate ? {} : { expirationDate: was.expirationDate }) };
        await store.set(back).catch(() => {});
      }
    }
    for (const domain of domains) verdicts.delete(domain);
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

  /** Every browser the importer lists (installed, with a profile). */
  function listed() {
    try { return ((cookieImport && cookieImport.sources()) || []).filter((source) => source.profiles && source.profiles.length); } catch { return []; }
  }

  /**
   * The one profile of `source` a copy reads (C4): the one onboarding remembered, else the one picked for `app`'s sign-in
   * (the choose screen's question, 2026-10-12), else "Default", else its first.
   */
  function profileOf(source, app = null) {
    const want = choice().profile;
    const pick = app ? picked(app) : null;
    return (want && source.profiles.find((profile) => profile.id === want))
      || (pick && pick.browser === source.id && source.profiles.find((profile) => profile.id === pick.profile))
      || source.profiles.find((profile) => profile.id === 'Default')
      || source.profiles[0];
  }

  /**
   * The chosen browser, with only the profile a copy reads (C4) → [source] | [] (not installed, or no profile yet). `count`
   * says how many profiles it has, so a row names the profile only when there was a choice.
   */
  function readable(app = null) {
    const id = chosenId();
    const source = id ? listed().find((one) => one.id === id) : null;
    if (!source) return [];
    return [{ ...source, count: source.profiles.length, profiles: [profileOf(source, app)] }];
  }

  /**
   * Where a sign-in page can open when the chosen browser can't be read yet (2026-10-15: Chrome installed but never opened
   * on a new account): that browser, with no profile; signed in there, `readable` lists it.
   */
  function openable(app = null) {
    const now = readable(app);
    if (now.length) return now;
    let found = [];
    try { found = (cookieImport && typeof cookieImport.installedChromium === 'function' && cookieImport.installedChromium()) || []; } catch { found = []; }
    return found.filter((source) => source.id === chosenId()).map((source) => ({ ...source, count: (source.profiles || []).length, profiles: source.profiles && source.profiles.length ? [profileOf(source, app)] : [] }));
  }

  /**
   * Every cookie name a profile holds for `domains` as one string (C8, 2026-10-16): it changes when any of them is set
   * anew, not only the session cookie (Bart: "after a rejected copy, its polling can ignore that profile until the
   * session-cookie timestamp changes"). '' when none, or unreadable.
   */
  function printOf(source, profile, domains) {
    try {
      return cookieImport.cookieNames(source.id, profile.id, domains).map((entry) => `${entry.domain}/${entry.name}@${entry.stamp || 0}`).sort().join('\n');
    } catch { return ''; }
  }

  /** The sign-in cookie a profile holds for the app → { stamp, print } | null (names only: no Keychain). */
  function holding(app, source, profile) {
    const [domain, pattern] = SIGN_IN_COOKIES[app];
    try {
      const names = cookieImport.cookieNames(source.id, profile.id, domainsOf(app));
      const hit = names.find((entry) => entry.domain === domain && pattern.test(entry.name));
      return hit ? { stamp: hit.stamp || 0, print: names.map((entry) => `${entry.domain}/${entry.name}@${entry.stamp || 0}`).sort().join('\n') } : null;
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
   * The chosen profile, when it holds the app's sign-in → [{ browserId, browser, profileId, name, email, keychain }]
   * (`keychain`: macOS will be asked before it can be copied). One profile at most (C4): the choose screen asks nothing.
   */
  function holdersOf(app) {
    if (!copies(app)) return [];
    const out = [];
    for (const source of readable(app)) {
      for (const profile of holders(app, source)) {
        out.push({ browserId: source.id, browser: source.name, profileId: profile.id, name: profile.name || profile.id, email: profile.email || '', keychain: source.family === 'chromium' && !asked.has(source.id) });
      }
    }
    return out;
  }

  /** Where the sign-in page opens: the chosen browser (C4), or null when it can't be opened. */
  function opener(sources) {
    return openers(sources)[0] || null;
  }

  /** The browsers a sign-in page can open in: the chosen one only, when it can be opened (C4: no next browser). */
  function openers(sources) {
    const defaultId = browserIdOf(defaultBrowser());
    return sources.filter((source) => source.id === chosenId() && (source.bundle || source.id === defaultId)).slice(0, 1);
  }

  /** Whether a browser counts as installed once macOS has answered (at most ~2 s), so one that is not is never opened. */
  async function installedNow(source) {
    if (!cookieImport || typeof cookieImport.ready !== 'function') return true;
    try { return !!(await cookieImport.ready(source.id)); } catch { return true; }
  }

  /**
   * Open `url` in `source`: the default browser through openExternal, any other with `open -b` (openIn). The "default"
   * is the browser the person chose (index.cjs defaultBrowser), and index.cjs's openExternal opens that one, not macOS's
   * default (round 3: a sign-in opened somewhere other than the browser they selected). A Chromium browser with more than
   * one profile opens it in the chosen profile (`openInProfile`, C8), so the cookies it sets are the ones copied; Firefox and
   * Safari open it where they are.
   */
  async function openPage(source, url) {
    const profile = source.profiles && source.profiles[0];
    if (openInProfile && source.family === 'chromium' && profile && (source.count || 0) > 1) {
      try { await openInProfile(source.id, profile.id, url); return; } catch (error) {
        log(`Couldn't open a page in ${source.name}'s ${profile.name || profile.id} profile (${(error && error.message) || error}): opened where ${source.name} is.`);
      }
    }
    if (source.id === browserIdOf(defaultBrowser()) || !openIn) await openExternal(url);
    else await openIn(source.id, url);
  }

  /**
   * The app's sign-in page (else its start page) opened in the browser the person chose (round 3: "no logins should happen
   * in Engelbart's Chromium browser") → that browser's name, or '' when nothing could open it.
   */
  async function openApp(app) {
    const url = SIGN_IN_PAGES[app] || (appOf(app) && appOf(app).start) || '';
    if (!url) return '';
    const sources = openable(app);
    if (!sources.length) { try { await openExternal(url); return browserName(); } catch { return ''; } }
    const target = await openFirst(sources, url);
    return target ? target.name : '';
  }

  /**
   * An app with no known sign-in cookie (OneNote, Evernote…): every cookie of its sites copied from the browser the person
   * chose, once they say they are signed in there → true when copied. `denied` as signIn's.
   */
  async function copyBlind(app, { denied = new Set() } = {}) {
    return copyDomains(domainsOf(app), { denied });
  }

  /**
   * Every cookie of `domains` copied from the browser the person chose (round 3: the other tools they named, Linear or
   * Figma, read in Engelbart's browser with their sign-ins rather than in their own browser) → true when copied. copyFor's,
   * as a yes or no.
   */
  async function copyDomains(domains, { denied = new Set() } = {}) {
    const out = await copyFor({ domains }, { denied }).catch(() => ({ copied: 0 }));
    return out.copied > 0;
  }

  /**
   * A tool's sign-in (C7, 2026-10-16), for one with no registered app: an "Other" tool, one the agents found or the person
   * added. Every cookie of its `domains` copied from the chosen browser and profile into Engelbart's browser, and checked
   * where its site has a check page (../browser/import-cookies.cjs SIGN_IN_CHECKS) →
   *   { copied: number, signedIn: true | false | null, browser?, profile? } and, when nothing could be copied, why:
   *   `declined` (the person turned their browser's sign-ins down), `needs: 'disk-access'` (Safari, no Full Disk Access),
   *   `needs: 'keychain'` (not allowed yet: macOS is never asked then), `refused`/`refusedId` (macOS said no), `noBrowser`.
   * `signedIn`: the check's answer; with no check, null, or false when nothing was copied and Engelbart's browser holds
   * nothing for those sites either (no session cookie at all). A copy the check says is signed out is undone (C3).
   */
  async function copyFor({ name = '', domains = [] } = {}, { denied = new Set() } = {}) {
    const wanted = registrable(domains);
    if (!cookieImport || !wanted.length) return { copied: 0, signedIn: null };
    if (choice().keychain === 'declined') return { copied: 0, signedIn: null, declined: true };
    const [source] = readable();
    if (!source) return { copied: 0, signedIn: null, noBrowser: true };
    if (!canRead(source.id)) return { copied: 0, signedIn: null, needs: 'disk-access', browser: source.name };
    if (denied.has(source.id) || refusedHere.has(source.id)) return { copied: 0, signedIn: null, refused: source.name, refusedId: source.id };
    if (source.family === 'chromium' && !asked.has(source.id) && choice().keychain !== 'allowed') return { copied: 0, signedIn: null, needs: 'keychain', browser: source.name };
    const profile = source.profiles[0];
    const named = { browser: source.name, ...(source.count > 1 ? { profile: profile.name || profile.id } : {}) };
    const before = await snapshot(wanted);
    let result;
    try {
      result = await oneAtATime(source.id, () => {
        if (denied.has(source.id)) throw Object.assign(new Error('Keychain access was denied'), { denied: true });
        if (source.family === 'chromium') asked.add(source.id);
        return cookieImport.import({ browser: source.id, profile: profile.id, domains: wanted, quiet: true });
      });
    } catch (error) {
      if (error && error.denied) { denied.add(source.id); return { copied: 0, signedIn: null, refused: source.name, refusedId: source.id }; }
      if (error && error.needs) return { copied: 0, signedIn: null, needs: error.needs, browser: source.name };
      log(`Couldn't copy ${name || wanted.join(', ')} from ${source.name}: ${(error && error.message) || error}`);
      return { copied: 0, signedIn: null, ...named };
    }
    if (result && result.needs) return { copied: 0, signedIn: null, needs: result.needs, browser: source.name };
    // An importer that doesn't count (a fake) counts as one copied.
    const copied = result && Number.isFinite(Number(result.imported)) ? Number(result.imported) : 1;
    let signedIn = null;
    for (const domain of wanted.filter((one) => CHECKED_SITES.has(one))) {
      verdicts.delete(domain); // a new copy: asked about afresh
      const answer = await checkSite(domain);
      if (answer === false) signedIn = false;
      else if (answer === true && signedIn !== false) signedIn = true;
    }
    if (signedIn === false) { await undo(before, wanted); return { copied: 0, signedIn: false, ...named }; }
    if (!copied && signedIn === null && !before.size) signedIn = false;
    return { copied, signedIn, ...named };
  }

  /**
   * Whether a browser of theirs holds the app's sign-in where a copy can't work in Engelbart (round 3): Google's sign-in
   * group only, which ties a session to the browser that made it ("I know I am signed into Gmail in my browser"). Another
   * app's copy that doesn't work means that sign-in has ended there too, and the person signs in again.
   */
  function heldThere(app) {
    if (!supports(app) || !signsInThroughBrowser(app)) return false;
    try { return readable(app).some((source) => holders(app, source).length > 0); } catch { return false; }
  }

  /** Open `url` in the chosen browser (openers) once it is known to be installed → that source, or null when it won't open. */
  async function openFirst(sources, url) {
    for (const source of openers(sources)) {
      if (!(await installedNow(source))) continue;
      try {
        await openPage(source, url);
        return source;
      } catch (error) {
        log(`Couldn't open a page in ${source.name} (${(error && error.message) || error}).`);
      }
    }
    return null;
  }

  /** The browser `app`'s sign-in page would open in (signIn), by name, or '' when none can be read. */
  function opensIn(app) {
    if (!copies(app)) return '';
    const target = opener(openable(app));
    return target ? target.name : '';
  }

  /**
   * The app's sign-in from the chosen profile (C4), brought into Engelbart's browser → { browser, browserId, profile,
   * unchecked } | { refused, refusedId } | { dead } | { needs: 'disk-access', browser } | { declined } | {}. A browser in
   * `denied` is not asked again; one that refuses is added to it. A copy found signed out is undone (C3: every cookie it
   * wrote, and what it overwrote put back); `seen` (shared across a wait's looks) keeps the profile from being copied again
   * until any of its cookies for the app's sites is set anew (C8). `profile` is named only when the browser has more than
   * one. `askedOnly`: a Chromium browser macOS hasn't been asked about this run is passed over unless the person allowed
   * their browser's sign-ins (C6: an allowed browser may be asked).
   */
  async function bringOver(app, sources, denied, seen = new Map(), { askedOnly = false } = {}) {
    if (isHere(app)) return {};
    if (choice().keychain === 'declined') return { declined: true };
    const domains = domainsOf(app);
    let refused = null;
    let failure = null;
    let dead = false;
    let copiedDead = false; // a copy made by this call turned away (not one passed over as unchanged since)
    for (const source of sources) {
      if (!canRead(source.id)) return { needs: 'disk-access', from: source.name };
      const profile = source.profiles[0];
      if (!profile) continue;
      const cookie = holding(app, source, profile);
      if (!cookie) continue;
      if (denied.has(source.id) || refusedHere.has(source.id)) { refused = refused || source; continue; }
      if (askedOnly && source.family === 'chromium' && !asked.has(source.id) && choice().keychain !== 'allowed') continue;
      const key = `${source.id}/${profile.id}`;
      if (seen.has(key) && seen.get(key) === cookie.print) { dead = true; continue; }
      const before = await snapshot(domains);
      let result;
      try {
        result = await oneAtATime(source.id, () => {
          if (denied.has(source.id)) throw Object.assign(new Error('Keychain access was denied'), { denied: true });
          if (source.family === 'chromium') asked.add(source.id);
          return cookieImport.import({ browser: source.id, profile: profile.id, domains, quiet: true });
        });
      } catch (error) {
        if (error && error.denied) { refused = refused || source; denied.add(source.id); continue; }
        if (error && error.needs) return { needs: error.needs, from: source.name };
        failure = failure || error;
        continue;
      }
      if (result && result.needs) return { needs: result.needs, from: source.name };
      verdicts.delete(pickKey(app)); // a new copy: asked about afresh
      const ok = (await signedIn(app)) ? await works(app) : false;
      if (ok !== false) {
        return { browser: source.name, browserId: source.id, profile: (source.count || source.profiles.length) > 1 ? (profile.name || profile.id) : '', ...(ok === null ? { unchecked: true } : {}) };
      }
      await undo(before, domains);
      dead = true;
      copiedDead = true;
      seen.set(key, cookie.print);
    }
    if (refused) return { refused: refused.name, refusedId: refused.id };
    if (dead) return { dead: true, ...(copiedDead ? { copied: true } : {}) };
    if (failure) throw failure;
    return {};
  }

  /** bringOver's answer, as signIn and signInQuiet give it: the browser and profile it came from. */
  const from = (found, extra = {}) => ({ browser: found.browser, ...(found.profile ? { profile: found.profile } : {}), ...(found.unchecked ? { unchecked: true } : {}), ...extra });

  /**
   * Sign in to `app` → { status: 'signed-in', browser, profile?, opened, unchecked? } | { status: 'timeout', browser } |
   * { status: 'cancelled' } | { status: 'denied', browser, browserId } (macOS refused the chosen browser) |
   * { status: 'no-browser' } (it can't be read) | { status: 'unsupported', browser } (no known sign-in cookie, or signed in
   * through Engelbart's window this run, so never copied: Engelbart's window is where it signs in again) |
   * { status: 'needs-disk-access', browser } (Safari without Full Disk Access) | { status: 'declined' }.
   * `onOpened(browser)` once the sign-in page is open there. Held already and working: signed in, and macOS is not asked.
   * `timeoutMs` Infinity waits until signed in or `signal` aborts (Google's Sign in on the choose screen, 2026-10-12).
   * `denied` the browsers macOS refused this run (not asked again; one refusing now is added).
   */
  async function signIn(app, { signal = null, onOpened = () => {}, timeoutMs: limit = timeoutMs, denied: deniedBefore = null } = {}) {
    const held = supports(app) ? await live(app) : { live: await signedIn(app) };
    if (held.live) return { status: 'signed-in', browser: '', opened: false, ...(held.unchecked ? { unchecked: true } : {}) };
    if (!copies(app) || !cookieImport) return { status: 'unsupported', browser: browserName() };
    const sources = readable(app);
    const targets = sources.length ? sources : openable(app); // none read yet: one to sign in in, read once it is signed in
    if (!targets.length) return { status: 'no-browser' };
    const denied = deniedBefore || new Set();
    const seen = new Map();
    const first = sources.length ? await bringOver(app, sources, denied, seen) : {};
    if (first.browser) return { status: 'signed-in', ...from(first), opened: false };
    if (first.refused) return { status: 'denied', browser: first.refused, browserId: first.refusedId };
    if (first.needs) return { status: 'needs-disk-access', browser: first.from };
    if (first.declined) return { status: 'declined' };
    if (signal && signal.aborted) return { status: 'cancelled' };
    // Signed in there already, but the copy doesn't work in Engelbart (Google ties a session to the browser that made it):
    // opening its sign-in page would only show them they are signed in (round 3: "it always just brings me to this
    // page"). Said instead, for the run to read it some other way.
    if (first.dead && heldThere(app)) { const holder = opener(sources); return { status: 'held-elsewhere', browser: holder ? holder.name : browserName() }; }
    const url = SIGN_IN_PAGES[app] || appOf(app).start;
    const target = await openFirst(targets, url);
    if (!target) return { status: 'no-browser' };
    onOpened(target.name);
    const key = pickKey(app);
    waitingIn.set(key, target);
    try {
      const found = await waitFor(() => {
        const now_ = sources.length ? sources : readable(app); // a browser opened for the first time has a profile now
        return now_.length ? bringOver(app, now_, denied, seen) : {};
      }, { signal, limit, stop: () => isHere(app) });
      if (found === 'cancelled') return { status: 'cancelled' };
      // Signed in through Engelbart's window meanwhile ("Sign in here instead"): that sign-in stands.
      if (found === 'here') return (await signedIn(app)) ? { status: 'signed-in', browser: '', opened: true } : { status: 'cancelled' };
      if (found && found.browser) return { status: 'signed-in', ...from(found), opened: true };
      if (found && found.refused) return { status: 'denied', browser: found.refused, browserId: found.refusedId };
    } finally {
      if (waitingIn.get(key) === target) waitingIn.delete(key);
    }
    return { status: 'timeout', browser: target.name };
  }

  /**
   * A wait's looks: `look()` every POLL_MS for FAST_FOR_MS, then every SLOW_POLL_MS, until it answers with a browser or a
   * refusal, `signal` aborts ('cancelled'), `stop()` says to ('here'), or `limit` ms pass (null).
   */
  async function waitFor(look, { signal = null, limit = timeoutMs, stop = () => false } = {}) {
    const until = Date.now() + limit;
    let waited = 0;
    while (Date.now() < until) {
      const wait = waited < fastForMs ? pollMs : slowPollMs;
      await sleep(wait);
      waited += wait;
      if (signal && signal.aborted) return 'cancelled';
      if (stop()) return 'here';
      const found = await look();
      if (found && (found.browser || found.refused || found.done || found.turnedAway)) return found;
    }
    return null;
  }

  /**
   * Whether the app's sign-in is in Engelbart's browser and works, or can be brought over without opening anything →
   * { signedIn, browser, profile?, unchecked?, refused, refusedId, noBrowser, needs?, declined? }. A copy held that is
   * signed out is copied again from the browser and checked again. `denied` is shared across checks (the choose screen's
   * lasts while Engelbart runs), so macOS is never asked twice about one browser; `noBrowser` when the chosen browser's
   * cookies can't be read; `needs: 'disk-access'` Safari without Full Disk Access; `declined` the person turned their
   * browser's sign-ins down. `askedOnly` (a sign-in lost partway through a run, 2026-10-12): unless their browser's
   * sign-ins were allowed (C6), only a browser macOS was asked about already, so it asks nothing new; `fresh` the copy held
   * dropped first, as an agent found it signed out (the quiet retries' call: allowed, it may ask). A sign-in Engelbart's
   * window made this run is only looked at, never copied (`here`: true), as is every sign-in off the Mac; `fresh`, it is
   * dropped and not signed in. `signedIn: false` only when the site said so or no session cookie is there (C2); a check
   * that couldn't answer keeps the copy (`unchecked`).
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
    const sources = readable(app);
    if (!sources.length) return { signedIn: false, browser: '', noBrowser: true };
    const found = await bringOver(app, sources, denied, new Map(), { askedOnly }).catch(() => ({}));
    if (found.browser) return { signedIn: true, ...from(found) };
    if (found.needs) return { signedIn: false, browser: found.from || '', needs: found.needs };
    if (found.declined) return { signedIn: false, browser: '', declined: true };
    // `held`: their browser is signed in (the copy was refused by the site, or not tried for a browser not asked yet).
    return { signedIn: false, browser: '', refused: found.refused || '', refusedId: found.refusedId || '', ...(!found.refused && !askedOnly && found.dead && heldThere(app) ? { held: true } : {}) };
  }

  /**
   * The native-browser fallback (C8, 2026-10-16, the Onboarding note's "Cookies fallback": "have the user sign in to the
   * application in their native browser, capture these new/updated cookies, and then import them to Engelbart's chromium").
   * `target` a registered app ('Google Docs') or a tool { name, url, domains } (an Other tool). Its cookies are copied from
   * the chosen browser and profile at once when they are there (an already signed-in person never signs in again); else its
   * page opens there, in that profile, and the cookies are copied once any of them appears or changes; then checked.
   * Bounded by `timeoutMs`; `signal` ends it. →
   *   { signedIn: true, unchecked?, browser?, profile? } | { signedIn: false, reason? } | { refused, refusedId, signedIn: false }
   *   (`reason`: 'timeout', 'cancelled', 'declined', 'disk-access', 'keychain', 'no-browser', 'signed-out', 'unsupported', 'turned-away': their browser is signed in and the site turns Engelbart's copy away).
   */
  async function recapture(target, { signal = null, timeoutMs: limit = timeoutMs, denied: deniedBefore = null } = {}) {
    const denied = deniedBefore || new Set();
    const app = typeof target === 'string' ? target : null;
    if (!cookieImport) return { signedIn: false, reason: 'unsupported' };
    if (choice().keychain === 'declined') return { signedIn: false, reason: 'declined' };
    if (app && supports(app)) return recaptureApp(app, { signal, limit, denied });
    const tool = app ? { name: app, domains: domainsOf(app), url: SIGN_IN_PAGES[app] || (appOf(app) && appOf(app).start) || '' } : (target || {});
    const domains = registrable(tool.domains && tool.domains.length ? tool.domains : (tool.url ? [String(tool.url)] : []));
    if (!domains.length) return { signedIn: false, reason: 'unsupported' };
    const url = tool.url || `https://${domains[0]}/`;
    return recaptureSites({ name: tool.name || domains[0], domains, url }, { signal, limit, denied });
  }

  const failedCopy = (found) => (found.refused ? { signedIn: false, refused: found.refused, refusedId: found.refusedId }
    : found.needs === 'disk-access' ? { signedIn: false, reason: 'disk-access' }
      : found.needs === 'keychain' ? { signedIn: false, reason: 'keychain' }
        : found.declined ? { signedIn: false, reason: 'declined' }
          : found.noBrowser ? { signedIn: false, reason: 'no-browser' } : null);

  /** recapture for a registered app with a known sign-in cookie (bringOver's copy and check). */
  async function recaptureApp(app, { signal, limit, denied }) {
    if (isHere(app)) {
      const held = await live(app);
      return held.live ? { signedIn: true, ...(held.unchecked ? { unchecked: true } : {}) } : { signedIn: false, reason: 'signed-out' };
    }
    const sources = readable(app);
    const targets = sources.length ? sources : openable(app);
    if (!targets.length) return { signedIn: false, reason: 'no-browser' };
    const seen = new Map();
    const done = (found) => ({ signedIn: true, ...from(found) });
    const first = sources.length ? await bringOver(app, sources, denied, seen).catch(() => ({})) : {};
    if (first.browser) return done(first);
    const failed = failedCopy(first);
    if (failed) return failed;
    if (signal && signal.aborted) return { signedIn: false, reason: 'cancelled' };
    const url = SIGN_IN_PAGES[app] || (appOf(app) && appOf(app).start);
    const opened = url ? await openFirst(targets, url) : null;
    if (!opened) return { signedIn: false, reason: 'no-browser' };
    // Their browser holds the sign-in and Engelbart's copy was turned away (`first.dead`): a short wait for a new one, and
    // a new one turned away too (a copy made and refused, `copied`) ends it: the site won't take a copy from that browser.
    const held = !!first.dead;
    const found = await waitFor(async () => {
      const now_ = sources.length ? sources : readable(app);
      const out = now_.length ? await bringOver(app, now_, denied, seen).catch(() => ({})) : {};
      return out.dead && out.copied ? { turnedAway: true } : out;
    }, { signal, limit: held ? Math.min(limit, heldWaitMs) : limit, stop: () => isHere(app) });
    if (found === 'cancelled') return { signedIn: false, reason: 'cancelled' };
    if (found === 'here') return (await signedIn(app)) ? { signedIn: true } : { signedIn: false, reason: 'signed-out' };
    if (found && found.browser) return done(found);
    if (found && found.refused) return failedCopy(found);
    if ((found && found.turnedAway) || held) return { signedIn: false, reason: 'turned-away' };
    return { signedIn: false, reason: 'timeout' };
  }

  /** recapture for a tool's sites (copyFor's copy and check), the page opened at `url`. */
  async function recaptureSites({ name, domains, url }, { signal, limit, denied }) {
    const good = (out) => out.copied > 0 && out.signedIn !== false;
    const done = (out) => ({ signedIn: true, ...(out.signedIn === null ? { unchecked: true } : {}), ...(out.browser ? { browser: out.browser } : {}), ...(out.profile ? { profile: out.profile } : {}) });
    const first = await copyFor({ name, domains }, { denied });
    if (good(first)) return done(first);
    const failed = failedCopy(first);
    if (failed) return failed;
    if (signal && signal.aborted) return { signedIn: false, reason: 'cancelled' };
    const targets = openable();
    if (!targets.length) return { signedIn: false, reason: 'no-browser' };
    const opened = await openFirst(targets, url);
    if (!opened) return { signedIn: false, reason: 'no-browser' };
    const printNow = () => { const [source] = readable(); return source ? printOf(source, source.profiles[0], domains) : ''; };
    let last = printNow();
    const found = await waitFor(async () => {
      const print = printNow();
      if (!print || print === last) return {};
      last = print;
      const out = await copyFor({ name, domains }, { denied });
      if (good(out)) return { done: true, out };
      if (out.refused) return { refused: out.refused, refusedId: out.refusedId };
      return {};
    }, { signal, limit });
    if (found === 'cancelled') return { signedIn: false, reason: 'cancelled' };
    if (found && found.done) return done(found.out);
    if (found && found.refused) return failedCopy(found);
    return { signedIn: false, reason: 'timeout' };
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
   * Allow on "Allow Engelbart to use your <browser> sign-ins?" (C5, S12, 2026-10-16): macOS asked for the chosen browser's
   * key at once, one prompt, kept for the run (index.cjs's key cache), resolving once macOS answered →
   *   { keychain: 'allowed' } | { keychain: 'refused', browser } (macOS said no, or Safari without Full Disk Access:
   *   `needs: 'disk-access'`). Firefox and a browser with no key: nothing to ask, allowed. Safari has no Keychain prompt:
   *   allowed means Full Disk Access is granted and its cookie file reads.
   */
  async function unlockBrowser(browserId = chosenId()) {
    const id = browserId || chosenId();
    if (!cookieImport || !id) return { keychain: 'allowed' };
    const source = listed().find((one) => one.id === id);
    const name = (source && source.name) || (id === 'safari' ? 'Safari' : id);
    const family = source ? source.family : id === 'safari' ? 'safari' : id === 'firefox' ? 'firefox' : 'chromium';
    if (family === 'safari') return canRead(id) ? { keychain: 'allowed' } : { keychain: 'refused', browser: name, needs: 'disk-access' };
    if (family !== 'chromium' || typeof cookieImport.unlock !== 'function') return { keychain: 'allowed' };
    try {
      await oneAtATime(id, () => { asked.add(id); return cookieImport.unlock(id); });
      refusedHere.delete(id);
      return { keychain: 'allowed' };
    } catch (error) {
      if (error && error.denied) { asked.delete(id); refusedHere.add(id); return { keychain: 'refused', browser: name }; }
      return { keychain: 'allowed' }; // not installed after all, or no key yet: nothing to ask
    }
  }

  /**
   * A browser's profiles for "Select your {browser} profile" (C4, S10) → [{ id, name, email }], or [] when it has one or
   * none that can be read (Safari without Full Disk Access).
   */
  function profilesOf(browserId) {
    const source = listed().find((one) => one.id === browserId);
    const profiles = source ? source.profiles.filter((profile) => !profile.locked) : [];
    return profiles.length > 1 ? profiles.map((profile) => ({ id: profile.id, name: profile.name || profile.id, email: profile.email || '' })) : [];
  }

  /**
   * The browser macOS will be asked about to bring the app's sign-in over, when it has not been yet while Engelbart runs →
   * { id, name } | null: the chosen one (C4); Firefox and Safari need no Keychain. `holdersOnly` (the choose screen's check
   * when an app is ticked, 2026-10-11): only when it holds the sign-in, since the check opens nothing.
   */
  function keychainTarget(app, { holdersOnly = false } = {}) {
    if (!copies(app) || !cookieImport) return null;
    const sources = readable(app);
    const target = sources.find((source) => holders(app, source).length) || (holdersOnly ? null : opener(sources.length ? sources : openable(app)));
    if (!target || target.family !== 'chromium' || asked.has(target.id)) return null;
    return { id: target.id, name: target.name };
  }

  /** What to tell the person before Log in first asks macOS for a browser's sign-ins this run, or ''. `options` as keychainTarget's. */
  function keychainNote(app, options) {
    const target = keychainTarget(app, options);
    return target ? `macOS will ask to use ${target.name}'s sign-ins. Choose Allow.` : '';
  }

  /** Every answer kept in memory dropped (test mode's reset, 2026-10-15): the next check asks again. */
  const forget = () => { verdicts.clear(); waitingIn.clear(); here.clear(); refusedHere.clear(); };

  return { forget, supports, canSignIn, signedIn, stillSignedIn, signedInHere, isHere, browserName, signIn, signInQuiet, unlock, unlockBrowser, profilesOf, anotherAccount, keychainTarget, keychainNote, holdersOf, heldThere, openApp, copyBlind, copyDomains, copyFor, recapture, picked, choose, opensIn, readableCount: () => readable().length };
}

module.exports = { createWebSignIn, SIGN_IN_COOKIES, SIGN_IN_PAGES, ANOTHER_ACCOUNT_PAGE, READABLE_NAMES, domainsOf, browserIdOf, registrable, profileOpenArgs };
