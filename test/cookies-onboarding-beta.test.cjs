'use strict';

// The onboarding beta's cookie core (2026-10-16, docs/onboarding-beta-10-16.md C1-C9): Safari's Cookies.binarycookies read
// by a parser of our own (a synthetic file built here, never a real Safari), one verdict rule for every sign-in check, a
// failed copy undone completely, one browser profile for every copy, Allow asking macOS at once, copies for any tool, the
// native-browser recapture, and Engelbart's sign-in window for any site. Fakes and temp folders only: no real browser
// profile, Keychain, network or System Settings.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const safari = require('../src/main/browser/safari-cookies.cjs');
const cookies = require('../src/main/browser/import-cookies.cjs');
const { createWebSignIn, registrable, profileOpenArgs } = require('../src/main/connect/web-signin.cjs');
const { createSignInWindow } = require('../src/main/connect/signin-window.cjs');
const { createBrowsers } = require('../src/main/onboarding/browsers.cjs');
const prefsFile = require('../src/main/onboarding/prefs.cjs');
const { createDiskAccess, FULL_DISK_ACCESS_PANE } = require('../src/main/onboarding/disk-access.cjs');

/* --------------------------------------------------------------------------------------- a synthetic binarycookies */

const MAC = safari.MAC_EPOCH_UNIX;

/** One record, as Safari writes it (yt-dlp's layout): a 56-byte header, then the NUL-terminated strings. */
function record({ domain, name, path: cookiePath = '/', value = '', flags = 0, expires = 2000000000, created = 1700000000 }) {
  const strings = [domain, name, cookiePath, value].map((text) => Buffer.concat([Buffer.from(text, 'utf8'), Buffer.from([0])]));
  const header = Buffer.alloc(56);
  let at = 56;
  const offsets = strings.map((bytes) => { const here = at; at += bytes.length; return here; });
  header.writeUInt32LE(at, 0);
  header.writeUInt32LE(0, 4);
  header.writeUInt32LE(flags, 8);
  header.writeUInt32LE(0, 12);
  offsets.forEach((offset, index) => header.writeUInt32LE(offset, 16 + index * 4));
  header.writeUInt32LE(0, 32); // comment
  header.writeUInt32LE(0, 36); // end of header
  header.writeDoubleLE(expires - MAC, 40);
  header.writeDoubleLE(created - MAC, 48);
  return Buffer.concat([header, ...strings]);
}

/** One page: 00 00 01 00, the count and offsets little-endian, four zero bytes, then the records. */
function page(records) {
  const head = Buffer.alloc(8 + records.length * 4 + 4);
  head.writeUInt32BE(0x00000100, 0);
  head.writeUInt32LE(records.length, 4);
  let at = head.length;
  records.forEach((bytes, index) => { head.writeUInt32LE(at, 8 + index * 4); at += bytes.length; });
  return Buffer.concat([head, ...records]);
}

/** A whole file: 'cook', the page count and sizes big-endian, the pages, an 8-byte footer. */
function binaryCookies(pages) {
  const head = Buffer.alloc(8 + pages.length * 4);
  head.write('cook', 0, 'latin1');
  head.writeUInt32BE(pages.length, 4);
  pages.forEach((bytes, index) => head.writeUInt32BE(bytes.length, 8 + index * 4));
  return Buffer.concat([head, ...pages, Buffer.alloc(8)]);
}

const SECURE_HTTPONLY = safari.FLAG_SECURE | safari.FLAG_HTTP_ONLY;

test('C1: Safari\'s binarycookies parsed: big-endian page table, little-endian records, Mac absolute time, the secure and HttpOnly flags', () => {
  const file = binaryCookies([
    page([record({ domain: '.linear.app', name: 'session', value: 'abc', flags: SECURE_HTTPONLY, expires: 1900000000, created: 1800000000 }), record({ domain: 'www.overleaf.com', name: 'overleaf_session2', value: 's:x', path: '/', flags: safari.FLAG_SECURE })]),
    page([record({ domain: '.google.com', name: 'SID', value: 'g', flags: 0 })]),
  ]);
  const { cookies: parsed, skipped } = safari.parseBinaryCookies(file);
  assert.equal(skipped, 0);
  assert.deepEqual(parsed.map((c) => [c.host, c.name, c.value, c.path, c.secure, c.httpOnly]), [
    ['.linear.app', 'session', 'abc', '/', true, true],
    ['www.overleaf.com', 'overleaf_session2', 's:x', '/', true, false],
    ['.google.com', 'SID', 'g', '/', false, false],
  ]);
  assert.equal(parsed[0].expires, 1900000000, 'Mac absolute time → Unix seconds');
  assert.equal(parsed[0].created, 1800000000);
  assert.equal(safari.macTimeToUnix(0), 0);
});

test('C1: not a Safari file is thrown; a page or a record that does not parse is skipped and counted, the rest kept', () => {
  assert.throws(() => safari.parseBinaryCookies(Buffer.from('SQLite format 3\0')), /Not a Safari cookie file/);
  assert.throws(() => safari.parseBinaryCookies(Buffer.concat([Buffer.from('cook'), Buffer.from([0, 0, 0, 9])])), /cut short/);
  const good = record({ domain: '.a.com', name: 'ok', value: '1' });
  const broken = record({ domain: '.b.com', name: 'bad', value: '2' });
  broken.writeUInt32LE(9999, 20); // its name's offset runs off the record
  const notAPage = Buffer.from([1, 2, 3, 4, 0, 0, 0, 0]);
  const out = safari.parseBinaryCookies(binaryCookies([page([good, broken]), notAPage]));
  assert.deepEqual(out.cookies.map((c) => c.name), ['ok']);
  assert.equal(out.skipped, 2);
});

/** A home folder with Safari's files where macOS keeps them, and Chrome's Application Support folder empty. */
function safariHome({ main = [], profiles = {}, old = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'safari-home-'));
  const write = (file, list) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, binaryCookies([page(list.map(record))])); };
  if (main) write(safari.CONTAINER_FILE(home), main);
  if (old) write(safari.OLD_FILE(home), old);
  for (const [uuid, list] of Object.entries(profiles)) write(path.join(safari.PROFILES_DIR(home), uuid, 'Cookies', 'Cookies.binarycookies'), list);
  fs.mkdirSync(path.join(home, 'Library', 'Application Support'), { recursive: true });
  return home;
}

function stage() {
  const jar = [];
  const calls = { set: [], flushes: 0 };
  return {
    jar,
    calls,
    cookies: {
      set: async (details) => { calls.set.push(details); jar.push(details); },
      get: async ({ domain, url }) => jar.filter((c) => (domain ? String(c.domain || new URL(c.url).hostname).replace(/^\./, '').endsWith(domain) : true) && (!url || true)),
      remove: async () => {},
      flushStore: async () => { calls.flushes += 1; },
    },
  };
}

const UUID = '0A1B2C3D-0000-4000-8000-00000000ABCD';

test('C1: with Full Disk Access, Safari is a source like any other: its profiles, names only, then the sites asked for imported into the Stage', async () => {
  const home = safariHome({
    main: [{ domain: '.linear.app', name: 'session', value: 'lin', flags: SECURE_HTTPONLY }, { domain: '.unrelated.com', name: 'x', value: 'no' }, { domain: '.linear.app', name: 'gone', value: 'old', expires: 1000000000 }],
    profiles: { [UUID]: [{ domain: '.github.com', name: 'user_session', value: 'gh', flags: SECURE_HTTPONLY }] },
  });
  const session = stage();
  const importer = cookies.createCookieImport({ supportDir: path.join(home, 'Library', 'Application Support'), userDataDir: path.join(home, 'ud'), getSession: () => session, keychain: async () => { throw new Error('Safari needs no Keychain'); }, fullDiskAccess: () => true, now: () => new Date('2026-10-16T00:00:00Z') });
  const source = importer.sources().find((one) => one.id === 'safari');
  assert.deepEqual(source.profiles, [{ id: 'Default', name: 'Personal' }, { id: UUID, name: 'Profile 1' }], 'Default first; a profile with no readable name is numbered');
  assert.equal(source.family, 'safari');
  assert.equal(importer.canRead('safari'), true);
  assert.deepEqual(importer.cookieNames('safari', 'Default', ['linear.app']).map((entry) => entry.name), ['session'], 'expired left out');
  const out = await importer.import({ browser: 'safari', profile: 'Default', domains: ['linear.app'], quiet: true });
  assert.equal(out.imported, 1);
  assert.deepEqual(session.calls.set.map((c) => [c.name, c.value, c.domain, c.secure, c.httpOnly, c.sameSite]), [['session', 'lin', '.linear.app', true, true, 'unspecified']]);
  assert.equal(out.needs, undefined);
  const other = await importer.import({ browser: 'safari', profile: UUID, domains: ['github.com'], quiet: true });
  assert.equal(other.imported, 1, 'a Safari 17+ profile\'s own file');
});

test('C1: the old ~/Library/Cookies file is the fallback when the container has none', () => {
  const home = safariHome({ main: null, old: [{ domain: '.zotero.org', name: 'zotero_www_session_v2', value: 'z' }] });
  assert.equal(safari.defaultCookieFile(home), safari.OLD_FILE(home));
});

test('C1: without Full Disk Access Safari is never touched: one locked profile, and every read says needs disk-access (no crash, no empty copy)', async () => {
  const home = safariHome({ main: [{ domain: '.linear.app', name: 'session', value: 'lin' }] });
  const session = stage();
  let touched = 0;
  const realRead = fs.readFileSync;
  const importer = cookies.createCookieImport({ supportDir: path.join(home, 'Library', 'Application Support'), userDataDir: path.join(home, 'ud'), getSession: () => session, keychain: async () => 'x', fullDiskAccess: () => false, installed: (bundle) => bundle === 'com.apple.Safari' });
  fs.readFileSync = (file, ...rest) => { if (String(file).includes('com.apple.Safari')) touched += 1; return realRead(file, ...rest); };
  try {
    assert.deepEqual(importer.sources(), [{ id: 'safari', name: 'Safari', family: 'safari', bundle: 'com.apple.Safari', profiles: [{ id: 'Default', name: 'Safari', locked: true }] }]);
    assert.equal(importer.canRead('safari'), false);
    assert.deepEqual(await importer.import({ browser: 'safari', profile: 'Default', domains: ['linear.app'] }), { browser: 'safari', profile: 'Safari', imported: 0, skipped: 0, sessionOnly: 0, checks: [], needs: 'disk-access' });
    assert.equal(importer.domains('safari', 'Default').needs, 'disk-access');
    assert.throws(() => importer.cookieNames('safari', 'Default', ['linear.app']), (error) => error.needs === 'disk-access');
  } finally { fs.readFileSync = realRead; }
  assert.equal(touched, 0, 'Safari\'s files never read');
  assert.equal(session.calls.set.length, 0, 'nothing written');
});

test('C1: macOS refusing the read anyway (EACCES/EPERM) is needs disk-access too', { skip: process.platform === 'win32' && 'Windows has no file modes: chmod 000 does not refuse the read' }, async () => {
  if (process.getuid && process.getuid() === 0) return; // root reads anything
  const home = safariHome({ main: [{ domain: '.linear.app', name: 'session', value: 'lin' }] });
  fs.chmodSync(safari.CONTAINER_FILE(home), 0o000);
  try {
    const importer = cookies.createCookieImport({ supportDir: path.join(home, 'Library', 'Application Support'), userDataDir: path.join(home, 'ud'), getSession: () => stage(), keychain: async () => 'x', fullDiskAccess: () => true });
    assert.equal((await importer.import({ browser: 'safari', profile: 'Default', domains: ['linear.app'] })).needs, 'disk-access');
  } finally { fs.chmodSync(safari.CONTAINER_FILE(home), 0o600); }
});

/* ---------------------------------------------------------------------------------------- C2: one verdict rule */

test('C2: every check page by the one rule, with what each site answered signed out on 2026-10-16', () => {
  const by = (domain) => cookies.SIGN_IN_CHECKS.find((check) => check.domain === domain);
  const verdict = (domain, response) => cookies.checkResult(by(domain), response);
  // Probed from net.request over an empty session (Electron's user agent and the Stage's alike):
  assert.equal(verdict('google.com', { status: 302, location: 'https://accounts.google.com/ServiceLogin?service=wise&passive=1209600' }), false);
  assert.equal(verdict('github.com', { status: 302, location: 'https://github.com/login?return_to=%2Fsettings%2Fprofile' }), false);
  assert.equal(verdict('overleaf.com', { status: 302, location: 'https://www.overleaf.com/login?' }), false);
  assert.equal(verdict('zotero.org', { status: 303, location: 'https://www.zotero.org/user/login' }), false);
  assert.equal(verdict('evernote.com', { status: 302, location: 'https://www.evernote.com/Login.action?targetUrl=%2Fclient%2Fweb' }), false);
  assert.equal(verdict('overleaf.com', { status: 302, location: '/login' }), false, 'a relative Location read from the check page');
  for (const domain of ['google.com', 'github.com', 'overleaf.com', 'zotero.org', 'evernote.com']) {
    assert.equal(verdict(domain, { status: 200 }), true, `${domain}: a 2xx is signed in`);
    assert.equal(verdict(domain, { status: 401 }), false, `${domain}: a 401 is signed out`);
    for (const status of [403, 429, 500, 502]) assert.equal(verdict(domain, { status }), null, `${domain}: a ${status} is not confirmed`);
    assert.equal(verdict(domain, { status: 302, location: 'https://example.com/elsewhere' }), null, `${domain}: a redirect elsewhere is not confirmed`);
    assert.equal(verdict(domain, null), null, `${domain}: no answer (a timeout, a network error) is not confirmed`);
  }
  // Claude's check reads its answer: the 403 that names the session invalid is signed out; Cloudflare's 403 is not
  // (2026-10-16: net.request over an empty session, and a page, both got the first).
  const invalid = JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'Invalid authorization', details: { error_visibility: 'user_facing', error_code: 'account_session_invalid' } }, request_id: 'req_1' });
  assert.equal(verdict('claude.ai', { status: 403, body: invalid }), false);
  assert.equal(verdict('claude.ai', { status: 403, body: '<!DOCTYPE html><html><head><title>Just a moment...</title>' }), null);
  assert.equal(verdict('claude.ai', { status: 403 }), null, 'no body read: not confirmed');
  assert.equal(verdict('claude.ai', { status: 200 }), true);
  assert.equal(verdict('claude.ai', { status: 401 }), false);
  assert.equal(verdict('google.com', { status: 403, body: invalid }), null, 'only Claude\'s check reads an answer');
  assert.ok(!cookies.DEFAULT_DOMAINS.includes('claude.ai'), 'the Stage\'s picker pre-ticks nothing new');
  assert.equal(verdict('overleaf.com', { status: 302, location: 'https://evil.example/login' }), null, 'another site\'s login page is not this site\'s');
  assert.equal(verdict('zotero.org', { status: 302, location: 'https://www.zotero.org/settings/storage' }), null);
  assert.equal(cookies.shownLocation('https://accounts.google.com/ServiceLogin?continue=https://drive.google.com&hint=me', 'https://drive.google.com/'), 'https://accounts.google.com/ServiceLogin', 'the trace keeps no query');
});

test('Claude\'s check reads the answer\'s body (its only one that does); the others are aborted at the status', async () => {
  const invalid = JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'Invalid authorization', details: { error_code: 'account_session_invalid' } } });
  const read = [];
  const request = ({ url }) => {
    const req = new EventEmitter();
    req.end = () => setImmediate(() => {
      const response = Object.assign(new EventEmitter(), { statusCode: 403 });
      response.on('newListener', (name) => { if (name === 'data') read.push(url); });
      req.emit('response', response);
      setImmediate(() => { response.emit('data', Buffer.from(invalid.slice(0, 40))); response.emit('data', Buffer.from(invalid.slice(40))); response.emit('end'); });
    });
    req.abort = () => {};
    return req;
  };
  const importer = cookies.createCookieImport({ supportDir: os.tmpdir(), userDataDir: os.tmpdir(), getSession: () => ({ cookies: { get: async () => [] } }), request, keychain: async () => 'x' });
  assert.deepEqual(await importer.checkDetail('claude.ai'), { site: 'Claude', domain: 'claude.ai', url: 'https://claude.ai/api/organizations', signedIn: false, status: 403, location: '' });
  assert.equal(await importer.check('overleaf.com'), null, 'a bare 403 elsewhere: not confirmed');
  assert.deepEqual(read, ['https://claude.ai/api/organizations'], 'only Claude\'s body was read');
});

test('C2: check(domain) says what the site answered (status, redirect) for the trace, and webSignIn logs every check', async () => {
  const session = { cookies: { get: async () => [{ name: 'user_session' }] } };
  const answers = { 'https://www.overleaf.com/project': { status: 302, location: 'https://www.overleaf.com/login?x=1' }, 'https://drive.google.com/drive/u/0/': { status: 429 } };
  const request = ({ url }) => {
    const req = new EventEmitter();
    req.end = () => setImmediate(() => { const a = answers[url]; if (a.location) req.emit('redirect', a.status, 'GET', a.location); else req.emit('response', Object.assign(new EventEmitter(), { statusCode: a.status })); });
    req.abort = () => {};
    return req;
  };
  const importer = cookies.createCookieImport({ supportDir: os.tmpdir(), userDataDir: os.tmpdir(), getSession: () => session, request, keychain: async () => 'x' });
  assert.deepEqual(await importer.checkDetail('overleaf.com'), { site: 'Overleaf', domain: 'overleaf.com', url: 'https://www.overleaf.com/project', signedIn: false, status: 302, location: 'https://www.overleaf.com/login' });
  assert.deepEqual(await importer.checkDetail('google.com'), { site: 'Google', domain: 'google.com', url: 'https://drive.google.com/drive/u/0/', signedIn: null, status: 429, location: '' });
  assert.equal(await importer.check('google.com'), null);
  assert.equal(await importer.checkDetail('linear.app'), null, 'no check page');

  const logged = [];
  const web = createWebSignIn({ cookieImport: { ...importer, sources: () => [] }, getSession: () => ({ cookies: { get: async () => [{ domain: '.google.com', name: 'SID' }] } }), log: (text, detail) => logged.push([text, detail]) });
  assert.equal(await web.stillSignedIn('Gmail'), true, 'a 429 keeps the sign-in');
  assert.equal(logged.length, 1);
  assert.match(logged[0][0], /No answer checking the Google sign-in \(429\)/);
  assert.equal(logged[0][1].kind, 'signin-check');
  assert.equal(logged[0][1].status, 429);
});

/* ------------------------------------------------------------- a Mac for webSignIn: one browser, profiles, a jar */

/**
 * `browsers` { id: { profiles: { id: [names] }, deny } }: each profile's cookie names for any domain asked (stamp 1, or
 * `stamps`). `writes` { 'id/profile': [cookies] } what an import of that profile writes into the jar (domain, name, value).
 * `checks` the answers check pages give in turn. `chosen` onboarding's answers.
 */
function mac({ browsers = {}, writes = {}, checks = [], chosen = {}, defaultName = 'Google Chrome', jar: start = [], stamps = {}, options = {} } = {}) {
  const NAMES = { chrome: ['Chrome', 'chromium', 'com.google.Chrome'], brave: ['Brave', 'chromium', 'com.brave.Browser'], firefox: ['Firefox', 'firefox', 'org.mozilla.firefox'], safari: ['Safari', 'safari', 'com.apple.Safari'] };
  let jar = start.map((cookie) => ({ path: '/', secure: true, ...cookie }));
  const calls = { imports: [], unlocked: [], opened: [], openedIn: [], openedProfile: [], removed: [], set: [], checks: [] };
  const answers = [...checks];
  const readable = { safari: true, ...(chosen.readable || {}) };
  const cookieImport = {
    sources: () => Object.keys(browsers).map((id) => ({ id, name: NAMES[id][0], family: NAMES[id][1], bundle: NAMES[id][2], profiles: Object.keys(browsers[id].profiles).map((pid) => ({ id: pid, name: pid === 'Default' ? 'Me' : `Name of ${pid}` })) })),
    canRead: (id) => readable[id] !== false,
    cookieNames: (id, pid, domains) => (browsers[id].profiles[pid] || []).map((name) => ({ domain: domains[0], name, stamp: stamps[`${id}/${pid}/${name}`] || 1 })),
    checkDetail: async (domain) => { calls.checks.push(domain); const answer = answers.length ? answers.shift() : true; return { site: domain, domain, signedIn: answer, status: answer === true ? 200 : answer === false ? 302 : 429, location: '' }; },
    import: async ({ browser: id, profile, domains, quiet }) => {
      if (browsers[id].deny) throw Object.assign(new Error('Keychain access was denied'), { denied: true });
      calls.imports.push({ browser: id, profile, domains, quiet });
      // Only what the profile holds now comes over.
      const wrote = (writes[`${id}/${profile}`] || []).filter((cookie) => (browsers[id].profiles[profile] || []).includes(cookie.name));
      for (const cookie of wrote) jar = [...jar.filter((c) => !(c.name === cookie.name && c.domain === cookie.domain)), { path: '/', secure: true, ...cookie }];
      return { imported: wrote.length, skipped: 0, sessionOnly: 0, checks: [] };
    },
    unlock: async (id) => { calls.unlocked.push(id); if (browsers[id] && browsers[id].deny) throw Object.assign(new Error('Keychain access was denied'), { denied: true }); return { browser: id, keychain: true }; },
    ready: async () => true,
  };
  const getSession = () => ({ cookies: {
    get: async ({ domain }) => jar.filter((cookie) => cookie.domain.replace(/^\./, '').endsWith(domain)),
    remove: async (url, name) => { calls.removed.push([url, name]); jar = jar.filter((cookie) => !(cookie.name === name && url.includes(cookie.domain.replace(/^\./, '')))); },
    set: async (details) => { calls.set.push(details); jar.push({ ...details, domain: details.domain || new URL(details.url).hostname }); },
  } });
  const state = { chosen: { browser: null, profile: null, keychain: null, ...chosen } };
  const web = createWebSignIn({
    cookieImport, defaultBrowser: () => defaultName, getSession, pollMs: 1, timeoutMs: 300, sleep: () => new Promise((resolve) => setImmediate(resolve)),
    openExternal: async (url) => { calls.opened.push(url); },
    openIn: async (id, url) => { calls.openedIn.push([id, url]); },
    openInProfile: async (id, pid, url) => { calls.openedProfile.push([id, pid, url]); },
    chosen: () => state.chosen,
    ...options,
  });
  return { web, calls, jar: () => jar, browsers, state };
}

/* ------------------------------------------------------------------------ C3: a failed copy undone completely */

test('C3: a copy whose check says signed out is undone completely: every cookie it wrote, and the one it overwrote put back', async () => {
  // Google's copy brought 16 cookies of other accounts with it (the Google note's side finding); here three, and an older
  // NID Engelbart already held.
  const { web, jar, calls } = mac({
    browsers: { chrome: { profiles: { Default: ['SID', 'NID', '__Secure-1PSID', 'GMAIL_AT'] } } },
    writes: { 'chrome/Default': [{ domain: '.google.com', name: 'SID', value: 'new' }, { domain: '.google.com', name: '__Secure-1PSID', value: 'p' }, { domain: '.google.com', name: 'NID', value: 'theirs' }, { domain: 'mail.google.com', name: 'GMAIL_AT', value: 'school' }] },
    checks: [false],
    chosen: { keychain: 'allowed' },
    jar: [{ domain: '.google.com', name: 'NID', value: 'ours', path: '/', secure: true }],
  });
  const out = await web.signInQuiet('Gmail');
  assert.equal(out.signedIn, false);
  assert.deepEqual(jar().map((c) => [c.name, c.value]), [['NID', 'ours']], 'nothing the copy wrote is left; the NID it overwrote is back');
  assert.equal(calls.removed.length, 4);
});

/* ---------------------------------------------------------------------- C4: one browser, one profile, chosen once */

test('C4: the profile onboarding chose is the only one read, for every copy; another browser holding it is never read', async () => {
  const { web, calls } = mac({
    browsers: { chrome: { profiles: { Default: ['session-token'], 'Profile 2': ['__Secure-next-auth.session-token'] } }, brave: { profiles: { Default: ['__Secure-next-auth.session-token'] } } },
    writes: { 'chrome/Profile 2': [{ domain: '.chatgpt.com', name: '__Secure-next-auth.session-token', value: 'v' }] },
    chosen: { browser: 'chrome', profile: 'Profile 2', keychain: 'allowed' },
  });
  assert.deepEqual(await web.signInQuiet('ChatGPT'), { signedIn: true, browser: 'Chrome', profile: 'Name of Profile 2' });
  assert.deepEqual(calls.imports.map((one) => `${one.browser}/${one.profile}`), ['chrome/Profile 2']);
  assert.deepEqual(web.profilesOf('chrome'), [{ id: 'Default', name: 'Me', email: '' }, { id: 'Profile 2', name: 'Name of Profile 2', email: '' }]);
  assert.deepEqual(web.profilesOf('brave'), [], 'one profile: no question');
});

test('C4: browsers.list gives each browser\'s profiles, the chosen profile and Safari\'s Full Disk Access; a profile is chosen once, with its browser', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prefs-'));
  const prefs = { get: () => prefsFile.get(root), set: (patch) => prefsFile.set(root, patch) };
  const unlocked = [];
  const browsers = createBrowsers({ platform: 'darwin',
    installedApps: null,
    override: ['chrome', 'safari'],
    prefs,
    profilesOf: (id) => (id === 'chrome' ? [{ id: 'Default', name: 'Me', email: 'me@x.example' }, { id: 'Profile 1', name: 'Work', email: '' }] : []),
    unlock: async (id) => { unlocked.push(id); return { keychain: 'allowed' }; },
    diskAccess: async () => ({ granted: false }),
  });
  const first = await browsers.list();
  assert.deepEqual(first.browsers.map((b) => [b.id, b.profiles.length, b.isDefault]), [['chrome', 2, true], ['safari', 0, false]]);
  assert.deepEqual([first.chosenId, first.chosenProfile, first.keychain, first.safari], ['chrome', null, null, { diskAccess: false }]);
  const picked = await browsers.chooseProfile('chrome', 'Profile 1');
  assert.equal(picked.chosenProfile, 'Profile 1');
  assert.deepEqual(prefsFile.get(root), { browser: 'chrome', profile: 'Profile 1' }, 'kept with its browser, ids only');
  await assert.rejects(browsers.chooseProfile('chrome', 'Nope'), /no such profile/);
  const moved = await browsers.choose('safari');
  assert.deepEqual([moved.chosenId, moved.chosenProfile], ['safari', null]);
  assert.equal(prefsFile.get(root).profile, undefined, 'another browser: its profile forgotten');
  assert.deepEqual(unlocked, [], 'nothing asked macOS');
});

/* ------------------------------------------------------------------------------- C5 / C6: the Keychain answer */

test('C5: Allow asks macOS for the chosen browser at once and resolves on its answer; declined never asks', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prefs-'));
  const prefs = { get: () => prefsFile.get(root), set: (patch) => prefsFile.set(root, patch) };
  const answers = { chrome: { keychain: 'allowed' }, brave: { keychain: 'refused', browser: 'Brave' } };
  const unlocked = [];
  const browsers = createBrowsers({ platform: 'darwin', installedApps: null, override: ['chrome', 'brave'], prefs, unlock: async (id) => { unlocked.push(id); return answers[id]; } });
  await browsers.list();
  assert.deepEqual(await browsers.setKeychain('declined'), { keychain: 'declined' });
  assert.deepEqual(unlocked, [], 'declined: macOS never asked');
  assert.deepEqual(await browsers.setKeychain('allowed'), { keychain: 'allowed' });
  assert.deepEqual(unlocked, ['chrome'], 'the chosen (default) browser, once');
  await browsers.choose('brave');
  assert.deepEqual(await browsers.setKeychain('allowed'), { keychain: 'refused', browser: 'Brave' });
  assert.equal(prefsFile.get(root).keychain, 'allowed', 'the answer is the person\'s; macOS\'s refusal is the run\'s');
});

test('C5: unlockBrowser: one prompt, kept for the run; refused is said and not asked again until Allow asks again; Safari is Full Disk Access', async () => {
  const fine = mac({ browsers: { chrome: { profiles: { Default: [] } } } });
  assert.deepEqual(await fine.web.unlockBrowser(), { keychain: 'allowed' });
  assert.deepEqual(fine.calls.unlocked, ['chrome']);
  assert.equal(fine.web.keychainTarget('Gmail'), null, 'asked this run: no note before the copy');
  const refusing = mac({ browsers: { chrome: { profiles: { Default: ['SID'] }, deny: true } }, chosen: { keychain: 'allowed' } });
  assert.deepEqual(await refusing.web.unlockBrowser('chrome'), { keychain: 'refused', browser: 'Chrome' });
  const quiet = await refusing.web.signInQuiet('Gmail');
  assert.equal(quiet.refused, 'Chrome', 'a copy after the refusal asks nothing');
  assert.deepEqual(refusing.calls.imports, []);
  const locked = mac({ browsers: { safari: { profiles: { Default: [] } } }, defaultName: 'Safari', chosen: { readable: { safari: false } } });
  assert.deepEqual(await locked.web.unlockBrowser(), { keychain: 'refused', browser: 'Safari', needs: 'disk-access' });
  const open = mac({ browsers: { safari: { profiles: { Default: [] } } }, defaultName: 'Safari' });
  assert.deepEqual(await open.web.unlockBrowser(), { keychain: 'allowed' });
  assert.deepEqual([locked.calls.unlocked, open.calls.unlocked], [[], []], 'Safari has no Keychain prompt');
});

test('C6: askedOnly with their browser\'s sign-ins allowed may ask macOS (the Google note\'s second silent path); unanswered asks nothing; declined copies nothing', async () => {
  const allowed = mac({ browsers: { chrome: { profiles: { Default: ['SID'] } } }, writes: { 'chrome/Default': [{ domain: '.google.com', name: 'SID', value: 'x' }] }, chosen: { keychain: 'allowed' } });
  assert.deepEqual(await allowed.web.signInQuiet('Gmail', { askedOnly: true }), { signedIn: true, browser: 'Chrome' });
  const unanswered = mac({ browsers: { chrome: { profiles: { Default: ['SID'] } } }, writes: { 'chrome/Default': [{ domain: '.google.com', name: 'SID', value: 'x' }] } });
  assert.equal((await unanswered.web.signInQuiet('Gmail', { askedOnly: true })).signedIn, false);
  assert.deepEqual(unanswered.calls.imports, [], 'no prompt while the answer is missing');
  const fresh = mac({ browsers: { chrome: { profiles: { Default: ['SID'] } } }, writes: { 'chrome/Default': [{ domain: '.google.com', name: 'SID', value: 'x' }] }, chosen: { keychain: 'allowed' }, jar: [{ domain: '.google.com', name: 'SID', value: 'dead' }] });
  assert.deepEqual(await fresh.web.signInQuiet('Gmail', { fresh: true }), { signedIn: true, browser: 'Chrome' }, 'the quiet retries\' call, allowed: copied anew');
  const declined = mac({ browsers: { chrome: { profiles: { Default: ['SID'] } } }, chosen: { keychain: 'declined' } });
  assert.deepEqual(await declined.web.signInQuiet('Gmail'), { signedIn: false, browser: '', declined: true });
  assert.deepEqual(await declined.web.copyFor({ name: 'Linear', domains: ['linear.app'] }), { copied: 0, signedIn: null, declined: true });
  assert.deepEqual(declined.calls.imports, []);
});

test('C1 in the flow: Safari chosen without Full Disk Access says so; with it, its sign-ins come over with no Keychain', async () => {
  const locked = mac({ defaultName: 'Safari', browsers: { safari: { profiles: { Default: ['SID'] } } }, chosen: { keychain: 'allowed', readable: { safari: false } } });
  assert.deepEqual(await locked.web.signInQuiet('Gmail'), { signedIn: false, browser: 'Safari', needs: 'disk-access' });
  assert.deepEqual(await locked.web.copyFor({ name: 'Linear', domains: ['linear.app'] }), { copied: 0, signedIn: null, needs: 'disk-access', browser: 'Safari' });
  const granted = mac({ defaultName: 'Safari', browsers: { safari: { profiles: { Default: ['session'] } } }, writes: { 'safari/Default': [{ domain: '.linear.app', name: 'session', value: 'v' }] } });
  assert.deepEqual(await granted.web.copyFor({ name: 'Linear', domains: ['https://linear.app/team'] }), { copied: 1, signedIn: null, browser: 'Safari' }, 'Safari needs no Keychain answer');
});

/* ------------------------------------------------------------------------------------- C7: copies for any tool */

test('C7: copyFor copies a tool\'s sites from the chosen profile, checks where it can, and never asks macOS before Allow', async () => {
  const { web, calls, jar } = mac({ browsers: { chrome: { profiles: { Default: ['session'] } } }, writes: { 'chrome/Default': [{ domain: '.linear.app', name: 'session', value: 'v' }] }, chosen: { keychain: 'allowed' } });
  assert.deepEqual(await web.copyFor({ name: 'Linear', domains: ['linear.app', 'www.linear.app', 'nonsense'] }), { copied: 1, signedIn: null, browser: 'Chrome' });
  assert.deepEqual(calls.imports, [{ browser: 'chrome', profile: 'Default', domains: ['linear.app'], quiet: true }]);
  assert.equal(jar().length, 1);
  const before = mac({ browsers: { chrome: { profiles: { Default: ['session'] } } } });
  assert.deepEqual(await before.web.copyFor({ name: 'Linear', domains: ['linear.app'] }), { copied: 0, signedIn: null, needs: 'keychain', browser: 'Chrome' });
  assert.deepEqual(before.calls.imports, [], 'unanswered: macOS not asked');
  await before.web.unlockBrowser();
  assert.equal((await before.web.copyFor({ name: 'Linear', domains: ['linear.app'] })).signedIn, false, 'asked now; nothing there to copy and nothing held: signed out');
  assert.deepEqual(registrable(['https://www.figma.com/files', 'FIGMA.com']), ['figma.com']);
});

test('C7: a tool whose site has a check page (Evernote) is checked; signed out, its copy is undone', async () => {
  const { web, jar } = mac({ browsers: { chrome: { profiles: { Default: ['auth'] } } }, writes: { 'chrome/Default': [{ domain: '.evernote.com', name: 'auth', value: 'a' }, { domain: 'www.evernote.com', name: 'JSESSIONID', value: 'j' }] }, checks: [false], chosen: { keychain: 'allowed' } });
  assert.deepEqual(await web.copyFor({ name: 'Evernote', domains: ['evernote.com'] }), { copied: 0, signedIn: false, browser: 'Chrome' });
  assert.deepEqual(jar(), [], 'undone');
});

/* ------------------------------------------------------------------------------ C8: the native-browser fallback */

test('C8: recapture with the sign-in already in the chosen browser: copied at once, nothing opens', async () => {
  const { web, calls } = mac({ browsers: { chrome: { profiles: { Default: ['SID'] } } }, writes: { 'chrome/Default': [{ domain: '.google.com', name: 'SID', value: 'x' }] }, chosen: { keychain: 'allowed' } });
  assert.deepEqual(await web.recapture('Google Docs'), { signedIn: true, browser: 'Chrome' });
  assert.deepEqual([calls.opened, calls.openedIn, calls.openedProfile], [[], [], []]);
});

test('C8: recapture signed out there: the page opens in the chosen browser and profile, and the cookies are copied once they appear', async () => {
  const machine = mac({ browsers: { chrome: { profiles: { Default: [], 'Profile 3': [] } } }, writes: { 'chrome/Profile 3': [{ domain: '.google.com', name: 'SID', value: 'x' }] }, chosen: { browser: 'chrome', profile: 'Profile 3', keychain: 'allowed' } });
  let looks = 0;
  const signal = { get aborted() { looks += 1; if (looks === 3) machine.browsers.chrome.profiles['Profile 3'] = ['SID']; return false; } };
  assert.deepEqual(await machine.web.recapture('Gmail', { signal }), { signedIn: true, browser: 'Chrome', profile: 'Name of Profile 3' });
  assert.deepEqual(machine.calls.openedProfile, [['chrome', 'Profile 3', 'https://accounts.google.com/']], 'in that profile');
  assert.deepEqual(profileOpenArgs('com.google.Chrome', 'Profile 3', 'https://x.example/'), ['-n', '-b', 'com.google.Chrome', '--args', '--profile-directory=Profile 3', 'https://x.example/']);
});

test('C8: after a rejected copy, any of the site\'s cookies set anew (not only the session cookie) brings a second copy', async () => {
  // Bart: "after a rejected copy, its polling can ignore that profile until the session-cookie timestamp changes".
  const stamps = { 'chrome/Default/SID': 7, 'chrome/Default/NID': 1 };
  const machine = mac({ stamps, browsers: { chrome: { profiles: { Default: ['SID', 'NID'] } } }, writes: { 'chrome/Default': [{ domain: '.google.com', name: 'SID', value: 'x' }] }, checks: [false, true], chosen: { keychain: 'allowed' } });
  let looks = 0;
  const signal = { get aborted() { looks += 1; if (looks === 3) stamps['chrome/Default/NID'] = 2; return false; } };
  assert.deepEqual(await machine.web.recapture('Gmail', { signal }), { signedIn: true, browser: 'Chrome' });
  assert.equal(machine.calls.imports.length, 2, 'copied again once NID changed, though SID\'s stamp never did');
  assert.ok(looks >= 3, 'not before the change');

  const still = mac({ stamps: { 'chrome/Default/SID': 7 }, browsers: { chrome: { profiles: { Default: ['SID'] } } }, writes: { 'chrome/Default': [{ domain: '.google.com', name: 'SID', value: 'x' }] }, checks: [false, true], chosen: { keychain: 'allowed' } });
  assert.deepEqual(await still.web.recapture('Gmail', { timeoutMs: 30 }), { signedIn: false, reason: 'turned-away' }, 'nothing changed there: not copied again, and their browser holds a sign-in the site turns away');
  assert.equal(still.calls.imports.length, 1);
});

test('C8: their browser signed in and the copy turned away: a new copy turned away too ends the wait at once; none new, it ends after the short wait (2026-10-16, "kept saying Waiting…")', async () => {
  const stamps = { 'chrome/Default/SID': 7 };
  const again = mac({ stamps, browsers: { chrome: { profiles: { Default: ['SID'] } } }, writes: { 'chrome/Default': [{ domain: '.google.com', name: 'SID', value: 'x' }] }, checks: [false, false], chosen: { keychain: 'allowed' }, options: { timeoutMs: 60_000 } });
  let looks = 0;
  const signal = { get aborted() { looks += 1; if (looks === 3) stamps['chrome/Default/SID'] = 8; return false; } };
  const started = Date.now();
  assert.deepEqual(await again.web.recapture('Gmail', { signal, timeoutMs: 60_000 }), { signedIn: false, reason: 'turned-away' });
  assert.equal(again.calls.imports.length, 2, 'copied again once the browser\'s cookies changed, and turned away again');
  assert.ok(Date.now() - started < 5000, 'not the minute it was given');
  const quiet = mac({ browsers: { chrome: { profiles: { Default: ['SID'] } } }, writes: { 'chrome/Default': [{ domain: '.google.com', name: 'SID', value: 'x' }] }, checks: [false], chosen: { keychain: 'allowed' }, options: { timeoutMs: 60_000, heldWaitMs: 40 } });
  const at = Date.now();
  assert.deepEqual(await quiet.web.recapture('Gmail', { timeoutMs: 60_000 }), { signedIn: false, reason: 'turned-away' });
  assert.ok(Date.now() - at < 5000, 'the short wait, not the minute');
  const fresh = mac({ browsers: { chrome: { profiles: { Default: [] } } }, writes: { 'chrome/Default': [{ domain: '.google.com', name: 'SID', value: 'x' }] }, chosen: { keychain: 'allowed' }, options: { heldWaitMs: 1 } });
  assert.deepEqual(await fresh.web.recapture('Gmail', { timeoutMs: 30 }), { signedIn: false, reason: 'timeout' }, 'nothing held there: waited for a sign-in to the end, as before');
});

test('C8: recapture for an Other tool: copied at once when there; else its page opens and the cookies are taken once they change; bounded', async () => {
  const there = mac({ browsers: { chrome: { profiles: { Default: ['session'] } } }, writes: { 'chrome/Default': [{ domain: '.linear.app', name: 'session', value: 'v' }] }, chosen: { keychain: 'allowed' } });
  assert.deepEqual(await there.web.recapture({ name: 'Linear', url: 'https://linear.app/login', domains: ['linear.app'] }), { signedIn: true, unchecked: true, browser: 'Chrome' });
  assert.deepEqual(there.calls.opened, []);

  const later = mac({ browsers: { chrome: { profiles: { Default: [] } } }, writes: { 'chrome/Default': [{ domain: '.linear.app', name: 'session', value: 'v' }] }, chosen: { keychain: 'allowed' } });
  let looks = 0;
  const signal = { get aborted() { looks += 1; if (looks === 3) { later.browsers.chrome.profiles.Default = ['session']; } return false; } };
  assert.deepEqual(await later.web.recapture({ name: 'Linear', url: 'https://linear.app/login', domains: ['linear.app'] }, { signal }), { signedIn: true, unchecked: true, browser: 'Chrome' });
  assert.deepEqual(later.calls.opened, ['https://linear.app/login'], 'opened in the chosen browser (the default)');

  const never = mac({ browsers: { chrome: { profiles: { Default: [] } } }, chosen: { keychain: 'allowed' } });
  assert.deepEqual(await never.web.recapture({ name: 'Linear', domains: ['linear.app'] }, { timeoutMs: 20 }), { signedIn: false, reason: 'timeout' });
  assert.deepEqual(never.calls.opened, ['https://linear.app/']);
  const refused = mac({ browsers: { chrome: { profiles: { Default: ['session'] }, deny: true } }, chosen: { keychain: 'allowed' } });
  assert.deepEqual(await refused.web.recapture({ name: 'Linear', domains: ['linear.app'] }), { signedIn: false, refused: 'Chrome', refusedId: 'chrome' });
});

/* ------------------------------------------------------------------------------ C9: Engelbart's window, any site */

function windowFakes() {
  const windows = [];
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.destroyed = false;
      this.loaded = [];
      this.webContents = Object.assign(new EventEmitter(), { getUserAgent: () => 'UA', setUserAgent: () => {}, setWindowOpenHandler: () => {} });
      windows.push(this);
    }
    loadURL(url) { this.loaded.push(url); return Promise.resolve(); }
    isDestroyed() { return this.destroyed; }
    show() {}
    focus() {}
    close() { if (this.destroyed) return; this.destroyed = true; this.emit('closed'); }
  }
  const jar = [];
  const session = { cookies: { get: async ({ domain }) => jar.filter((cookie) => cookie.domain.replace(/^\./, '').endsWith(domain)), remove: async () => {} } };
  const timers = { setInterval: () => 1, clearInterval: () => {} };
  const signIn = createSignInWindow({ BrowserWindow, getSession: () => session, signedIn: async () => false, timers, headless: true });
  return { signIn, windows, jar, session };
}

test('C9: openSite signs in to any https site in the agents\' session: closed with its cookies changed is signed in, unchanged is closed', async () => {
  const { signIn, windows, jar, session } = windowFakes();
  const pending = signIn.openSite({ name: 'Linear', url: 'https://linear.app/login', domains: ['linear.app'] });
  const [win] = windows;
  assert.equal(win.options.webPreferences.session, session);
  assert.equal(win.options.title, 'Sign in to Linear');
  assert.deepEqual(win.loaded, ['https://linear.app/login']);
  await new Promise((resolve) => setImmediate(resolve));
  jar.push({ domain: '.linear.app', name: 'session', value: 'new', path: '/' });
  win.close();
  assert.deepEqual(await pending, { status: 'signed-in' });

  const again = windowFakes();
  const nothing = again.signIn.openSite({ name: 'Figma', url: 'https://www.figma.com/login' });
  await new Promise((resolve) => setImmediate(resolve));
  again.windows[0].close();
  assert.deepEqual(await nothing, { status: 'closed' });
  assert.deepEqual(await again.signIn.openSite({ url: 'http://insecure.example/' }), { status: 'closed' }, 'https only');
});

test('C9: a registered app with no known sign-in cookie (Evernote) opens as any site does', async () => {
  const { signIn, windows } = windowFakes();
  const pending = signIn.open('Evernote');
  assert.equal(windows.length, 1);
  assert.match(windows[0].loaded[0], /^https:\/\/[^/]*evernote\.com/);
  windows[0].close();
  assert.deepEqual(await pending, { status: 'closed' });
});

/* ------------------------------------------------------------------------------- Full Disk Access, S9 */

test('openDiskAccess opens System Settings at Full Disk Access and nothing else', async () => {
  const ran = [];
  const access = createDiskAccess({ platform: 'darwin', fake: 'denied', run: (file, args, options, done) => { ran.push([file, args]); done(null); } });
  assert.deepEqual(await access.open(), { opened: true });
  assert.deepEqual(ran, [['/usr/bin/open', [FULL_DISK_ACCESS_PANE]]]);
  assert.match(FULL_DISK_ACCESS_PANE, /^x-apple\.systempreferences:com\.apple\.preference\.security\?Privacy_AllFiles$/);
  assert.deepEqual(await createDiskAccess({ platform: 'linux' }).open(), { opened: false });
  assert.deepEqual(await access.status(), { platform: 'darwin', granted: false });
});

test('prefs keep a profile id, never anything else', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prefs-'));
  prefsFile.set(root, { browser: 'chrome', profile: 'Profile 1' });
  assert.deepEqual(prefsFile.get(root), { browser: 'chrome', profile: 'Profile 1' });
  prefsFile.set(root, { profile: '../../etc/passwd' });
  assert.equal(prefsFile.get(root).profile, undefined);
  prefsFile.set(root, { profile: UUID });
  assert.equal(prefsFile.get(root).profile, UUID, 'a Safari profile\'s UUID');
});
