'use strict';

// Importing sign-ins from the person's browsers into the Stage (MATH-18, src/main/browser/import-cookies.cjs). Everything
// here runs against fixtures: Chromium databases (meta version < 24 and >= 24) encrypted with a known password, a Firefox
// database, a fake Keychain and a fake persist:browser session. No real profile or Keychain is read. The checks cover the
// decryption and the >= 24 hash-prefix strip, the time and sameSite conversions, __Host- and host-only domains, the skipped
// count, that a fake cookies.set gets the right calls and flushStore is called, that a Keychain denial writes nothing, and
// that no cookie value reaches the IPC result or browser-imports.json. The follow-ups (2026-10-06): Firefox's schema-14
// millisecond expiry, expired and partitioned/container rows left out, the sign-in checks over a fake net.request (GitHub's
// own tests, a cancelled redirect, the timeout), the Keychain runner over a fake execFile, and an empty domain list.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { DatabaseSync } = require('node:sqlite');

const mod = require('../src/main/browser/import-cookies.cjs');

const PASSWORD = 'peanuts'; // a fixed Keychain password; the real one is read with `security`
const KEY = mod.deriveKey(PASSWORD);
const WINDOWS_TO_UNIX_SECONDS = 11644473600;

// Chromium's on-disk value: 'v10' then AES-128-CBC with the derived key and the 16-space IV. For a meta version >= 24 a
// 32-byte domain hash precedes the plaintext (dropped on read).
function encryptV10(value, { version = 0 } = {}) {
  const cipher = crypto.createCipheriv('aes-128-cbc', KEY, Buffer.alloc(16, ' '));
  let plain = Buffer.from(value, 'utf8');
  if (version >= 24) plain = Buffer.concat([crypto.createHash('sha256').update('host.example').digest(), plain]);
  return Buffer.concat([Buffer.from('v10'), cipher.update(plain), cipher.final()]);
}

const unixToChrome = (seconds) => (seconds + WINDOWS_TO_UNIX_SECONDS) * 1e6;

// A Chromium Cookies database at `file`. `rows` describe cookies; `bad` ones get a value that will not decrypt, and
// `topFrame` makes a partitioned (CHIPS) copy, kept for when the site is embedded in that top-level site.
function makeChromiumDb(file, version, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE meta (key TEXT NOT NULL, value TEXT)');
  db.prepare('INSERT INTO meta VALUES (?, ?)').run('version', String(version));
  db.exec("CREATE TABLE cookies (host_key TEXT, top_frame_site_key TEXT NOT NULL DEFAULT '', name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, has_expires INTEGER, is_persistent INTEGER)");
  const insert = db.prepare('INSERT INTO cookies (host_key, top_frame_site_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite, has_expires, is_persistent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const row of rows) {
    const encrypted = row.bad ? Buffer.concat([Buffer.from('v10'), Buffer.from('not-a-valid-block')]) : encryptV10(row.value, { version });
    insert.run(
      row.host, row.topFrame || '', row.name, '', encrypted, row.path || '/',
      BigInt(Math.round(row.expiresUtc != null ? row.expiresUtc : unixToChrome(4102444800))), // default 2100
      row.secure ? 1 : 0, row.httpOnly ? 1 : 0, row.samesite == null ? -1 : row.samesite,
      row.persistent === false ? 0 : 1, row.persistent === false ? 0 : 1,
    );
  }
  db.close();
}

// A Firefox cookies.sqlite at `file`, at cookie schema `schema` (its user_version; 14 is current). Each row's `expiry` is
// given in Unix seconds and written as that schema stores it: milliseconds from 14 on, seconds before. `origin` is the
// row's originAttributes ('' for the plain cookie, '^userContextId=1' for a container, '^partitionKey=…' partitioned).
function makeFirefoxDb(file, rows, { schema = 14 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA user_version = ${schema}`);
  db.exec("CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, originAttributes TEXT NOT NULL DEFAULT '', host TEXT, name TEXT, value TEXT, path TEXT, expiry INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER, creationTime INTEGER, lastAccessed INTEGER)");
  const insert = db.prepare('INSERT INTO moz_cookies (originAttributes, host, name, value, path, expiry, isSecure, isHttpOnly, sameSite, creationTime, lastAccessed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const row of rows) {
    const expiry = schema >= 14 ? BigInt(row.expiry || 0) * 1000n : BigInt(row.expiry || 0);
    insert.run(row.origin || '', row.host, row.name, row.value, row.path || '/', expiry, row.secure ? 1 : 0, row.httpOnly ? 1 : 0, row.samesite || 0,
      BigInt('16700000000000000'), BigInt('16700000000000000')); // microseconds: large, must not break the read
  }
  db.close();
}

const hostOf = (url) => new URL(url).hostname;

// A fake Stage session: records every cookies.set and flushStore, and answers cookies.get({ url }) from what was set (the
// names are what the GitHub check reads).
function fakeSession() {
  const calls = [];
  let flushed = 0;
  return {
    calls,
    flushes: () => flushed,
    cookies: {
      set: async (details) => { calls.push(details); },
      get: async ({ url }) => calls.filter((details) => {
        const host = details.domain ? details.domain.replace(/^\./, '') : hostOf(details.url);
        const asked = hostOf(url);
        return asked === host || (!!details.domain && asked.endsWith(`.${host}`));
      }),
      flushStore: async () => { flushed += 1; },
    },
  };
}

// A fake net.request: each request answers from `script` by its url — a number is a response with that status (200 signed
// in); { status, location } a redirect, as net.request's 'redirect' event gives it; 'cancel' the error net.fetch throws
// for a manual redirect; 'hang' never answers; anything else fails. `requests` keeps the options and whether it was aborted.
function fakeRequest(script = {}) {
  const requests = [];
  const request = (options) => {
    const req = new EventEmitter();
    const record = { options, aborted: false };
    requests.push(record);
    req.abort = () => { record.aborted = true; };
    req.end = () => setImmediate(() => {
      const answer = script[options.url];
      if (answer === 'hang') return;
      if (typeof answer === 'number') req.emit('response', Object.assign(new EventEmitter(), { statusCode: answer }));
      else if (answer && typeof answer === 'object') req.emit('redirect', answer.status, 'GET', answer.location || '', {});
      else req.emit('error', new Error(answer === 'cancel' ? 'Redirect was cancelled' : 'net::ERR_NAME_NOT_RESOLVED'));
    });
    return req;
  };
  request.requests = requests;
  return request;
}

// A fake execFile for the Keychain runner: `code` 0 prints `stdout`, anything else fails with that exit code.
function fakeExecFile({ code = 0, stdout = '', stderr = '' } = {}) {
  const runs = [];
  const run = (file, args, options, callback) => {
    runs.push({ file, args, options });
    setImmediate(() => {
      if (code) callback(Object.assign(new Error(`Command failed: ${file} ${args.join(' ')}\n${stderr}`), { code }), '', stderr);
      else callback(null, stdout, '');
    });
  };
  run.runs = runs;
  return run;
}

/* ------------------------------------------------------------------------------------------------------ pure parts */

test('v10 decryption, the >= 24 hash-prefix strip, and skipped undecryptable values', () => {
  assert.equal(mod.decryptChromiumValue(encryptV10('plain', { version: 20 }), '', KEY, 20), 'plain');
  assert.equal(mod.decryptChromiumValue(encryptV10('hashed', { version: 24 }), '', KEY, 24), 'hashed');
  // Read a version-24 value as if it were older (no strip): the 32-byte hash would leak into the value, so the strip matters.
  assert.notEqual(mod.decryptChromiumValue(encryptV10('hashed', { version: 24 }), '', KEY, 20), 'hashed');
  // An unencrypted value Chromium left in the clear.
  assert.equal(mod.decryptChromiumValue(Buffer.alloc(0), 'clear', KEY, 24), 'clear');
  // Will not decrypt -> null (the caller counts it as skipped).
  assert.equal(mod.decryptChromiumValue(Buffer.concat([Buffer.from('v10'), Buffer.from('short')]), '', KEY, 24), null);
  assert.equal(mod.decryptChromiumValue(encryptV10('x', { version: 24 }), '', null, 24), null);
});

test('Chrome microsecond time -> Unix seconds, and session times stay 0', () => {
  assert.equal(mod.chromeTimeToUnixSeconds(unixToChrome(1893456000)), 1893456000);
  assert.equal(mod.chromeTimeToUnixSeconds(0), 0);
  assert.equal(mod.chromeTimeToUnixSeconds(-1), 0);
});

test('sameSite mapping for Chromium and Firefox', () => {
  assert.equal(mod.sameSiteOf(mod.CHROMIUM_SAMESITE, -1), 'unspecified');
  assert.equal(mod.sameSiteOf(mod.CHROMIUM_SAMESITE, 0), 'no_restriction');
  assert.equal(mod.sameSiteOf(mod.CHROMIUM_SAMESITE, 1), 'lax');
  assert.equal(mod.sameSiteOf(mod.CHROMIUM_SAMESITE, 2), 'strict');
  assert.equal(mod.sameSiteOf(mod.FIREFOX_SAMESITE, 0), 'unspecified');
  assert.equal(mod.sameSiteOf(mod.FIREFOX_SAMESITE, 2), 'strict');
});

test('cookies.set details: host-only vs domain, __Host- without a domain, session vs persistent', () => {
  const domainCookie = mod.cookieSetDetails({ host: '.github.com', name: 'user_session', value: 'v', path: '/', secure: true, httpOnly: true, sameSite: 'lax', persistent: true, expires: 1893456000 });
  assert.equal(domainCookie.url, 'https://github.com/');
  assert.equal(domainCookie.domain, '.github.com');
  assert.equal(domainCookie.expirationDate, 1893456000);

  const hostOnly = mod.cookieSetDetails({ host: 'github.com', name: 'a', value: 'v', path: '/', secure: true, persistent: true, expires: 1893456000 });
  assert.equal(hostOnly.domain, undefined, 'a host-only cookie gets no domain');

  const hostPrefixed = mod.cookieSetDetails({ host: '.github.com', name: '__Host-user_session_same_site', value: 'v', path: '/', secure: true, persistent: true, expires: 1893456000 });
  assert.equal(hostPrefixed.domain, undefined, '__Host- cookies are written without a domain');

  const sessionCookie = mod.cookieSetDetails({ host: 'github.com', name: 's', value: 'v', path: '/', secure: false, persistent: false, expires: 0 });
  assert.equal(sessionCookie.expirationDate, undefined, 'a session cookie keeps no expiry');
  assert.equal(sessionCookie.url, 'http://github.com/');
});

test('registrable domain grouping', () => {
  assert.equal(mod.registrableDomain('.www.github.com'), 'github.com');
  assert.equal(mod.registrableDomain('accounts.google.com'), 'google.com');
  assert.equal(mod.registrableDomain('sub.example.co.uk'), 'example.co.uk');
  assert.equal(mod.registrableDomain('overleaf.com'), 'overleaf.com');
});

test('a Chromium database is read and normalized, skipping the undecryptable (both meta versions)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chromium-'));
  for (const version of [20, 24]) {
    const file = path.join(dir, `Cookies-${version}`);
    makeChromiumDb(file, version, [
      { host: '.github.com', name: 'user_session', value: 'abc', secure: true, httpOnly: true, samesite: 1 },
      { host: 'github.com', name: 'logged_in', value: 'yes', secure: true, samesite: 2 },
      { host: '.github.com', name: 'broken', bad: true },
    ]);
    const { cookies, skipped } = mod.normalizeChromium(mod.withCopy(file, dir, mod.readChromiumDb), KEY);
    assert.equal(skipped, 1, `version ${version}: the undecryptable one is skipped`);
    assert.deepEqual(cookies.map((c) => c.value).sort(), ['abc', 'yes']);
    assert.equal(cookies.find((c) => c.name === 'user_session').sameSite, 'lax');
  }
});

test('a Firefox database is read with plaintext values, its expiry in seconds whatever the schema (14+ stores ms)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'firefox-'));
  for (const schema of [12, 13, 14, 15]) {
    const file = path.join(dir, `cookies-${schema}.sqlite`);
    makeFirefoxDb(file, [
      { host: '.overleaf.com', name: 'overleaf_session2', value: 'ff-value', path: '/', expiry: 1893456000, secure: true, httpOnly: true, samesite: 2 },
    ], { schema });
    const read = mod.withCopy(file, dir, mod.readFirefoxDb);
    assert.equal(read.schema, schema);
    const { cookies, skipped } = mod.normalizeFirefox(read);
    assert.equal(skipped, 0);
    assert.equal(cookies[0].value, 'ff-value');
    assert.equal(cookies[0].expires, 1893456000, `schema ${schema}: Unix seconds`);
    assert.equal(cookies[0].sameSite, 'strict');
    assert.equal(mod.cookieSetDetails(cookies[0]).expirationDate, 1893456000, `schema ${schema}: what cookies.set gets`);
  }
});

test('schema 14 read as seconds would be ~1000x too far: the raw column holds milliseconds', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'firefox14-'));
  const file = path.join(dir, 'cookies.sqlite');
  makeFirefoxDb(file, [{ host: 'zotero.org', name: 'zotero_www_session_v2', value: 'z', expiry: 1893456000 }], { schema: mod.FIREFOX_EXPIRY_MS_SCHEMA });
  const db = new DatabaseSync(file);
  const raw = Number(db.prepare('SELECT expiry FROM moz_cookies').get().expiry);
  db.close();
  assert.equal(raw, 1893456000 * 1000);
  assert.equal(mod.withCopy(file, dir, mod.readFirefoxDb).rows[0].expirySeconds, 1893456000);
});

test('expired cookies are left out on both families: not imported, not counted as skipped (2026-10-06)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expired-'));
  const now = 1790000000; // 2026-09
  const chromium = path.join(dir, 'Cookies');
  makeChromiumDb(chromium, 24, [
    { host: '.github.com', name: 'live', value: 'yes', expiresUtc: unixToChrome(now + 3600) },
    { host: '.github.com', name: 'gone', value: 'old', expiresUtc: unixToChrome(now - 3600) },
    { host: '.github.com', name: 'gone_bad', bad: true, expiresUtc: unixToChrome(now - 3600) }, // expired first: not a skip
    { host: '.github.com', name: 'session', value: 's', persistent: false, expiresUtc: 0 }, // a session cookie has no expiry
  ]);
  const fromChromium = mod.normalizeChromium(mod.withCopy(chromium, dir, mod.readChromiumDb), KEY, { now });
  assert.deepEqual(fromChromium.cookies.map((c) => c.name).sort(), ['live', 'session']);
  assert.equal(fromChromium.skipped, 0);

  const firefox = path.join(dir, 'cookies.sqlite');
  makeFirefoxDb(firefox, [
    { host: '.overleaf.com', name: 'live', value: 'yes', expiry: now + 3600 },
    { host: '.overleaf.com', name: 'gone', value: 'old', expiry: now - 3600 },
  ]);
  const fromFirefox = mod.normalizeFirefox(mod.withCopy(firefox, dir, mod.readFirefoxDb), { now });
  assert.deepEqual(fromFirefox.cookies.map((c) => c.name), ['live']);
});

test('partitioned (CHIPS) and container cookies are left out, so they cannot overwrite the real sign-in (2026-10-06)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'partitioned-'));
  const chromium = path.join(dir, 'Cookies');
  makeChromiumDb(chromium, 24, [
    { host: 'github.com', name: 'user_session', value: 'real' },
    { host: 'github.com', name: 'user_session', value: 'third-party', topFrame: 'https://embedder.example' },
  ]);
  const fromChromium = mod.normalizeChromium(mod.withCopy(chromium, dir, mod.readChromiumDb), KEY);
  assert.deepEqual(fromChromium.cookies.map((c) => c.value), ['real']);
  assert.equal(fromChromium.skipped, 0);

  const firefox = path.join(dir, 'cookies.sqlite');
  makeFirefoxDb(firefox, [
    { host: '.overleaf.com', name: 'overleaf_session2', value: 'real', expiry: 1893456000 },
    { host: '.overleaf.com', name: 'overleaf_session2', value: 'container', expiry: 1893456000, origin: '^userContextId=2' },
    { host: '.overleaf.com', name: 'overleaf_session2', value: 'partitioned', expiry: 1893456000, origin: '^partitionKey=%28https%2Cexample.com%29' },
  ]);
  const fromFirefox = mod.normalizeFirefox(mod.withCopy(firefox, dir, mod.readFirefoxDb));
  assert.deepEqual(fromFirefox.cookies.map((c) => c.value), ['real']);
});

test('the private copy is deleted whether reading succeeds or throws', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-'));
  const file = path.join(dir, 'Cookies');
  makeChromiumDb(file, 24, [{ host: 'github.com', name: 'a', value: 'v' }]);
  const before = fs.readdirSync(dir).length;
  mod.withCopy(file, dir, () => 'done');
  assert.equal(fs.readdirSync(dir).length, before, 'the temp copy dir is gone');
  assert.throws(() => mod.withCopy(file, dir, () => { throw new Error('boom'); }), /boom/);
  assert.equal(fs.readdirSync(dir).length, before, 'and gone after a throw too');
});

test('sign-in check verdicts from a manual-redirect fetch status', () => {
  const github = mod.SIGN_IN_CHECKS.find((c) => c.domain === 'github.com');
  assert.equal(mod.checkResult(github, { status: 200 }), true, 'the protected page loaded: signed in');
  assert.equal(mod.checkResult(github, { status: 302 }), false, 'a 3xx to login: signed out');
  assert.equal(mod.checkResult(github, { status: 0, type: 'opaqueredirect' }), false, 'a hidden redirect: signed out');
  assert.equal(mod.checkResult(github, null), null, 'a check that could not run is null');
});

test('GitHub\'s check uses GITHUB_SESSION_COOKIES and endedGithubSession from src/shared/github.cjs (2026-10-06)', () => {
  const { GITHUB_SESSION_COOKIES } = require('../src/shared/github.cjs');
  const github = mod.SIGN_IN_CHECKS.find((c) => c.domain === 'github.com');
  const google = mod.SIGN_IN_CHECKS.find((c) => c.domain === 'google.com');
  assert.deepEqual(github.sessionCookies, GITHUB_SESSION_COOKIES);
  const toLogin = 'https://github.com/login?return_to=https%3A%2F%2Fgithub.com%2Fsettings%2Fprofile';
  assert.equal(mod.checkResult(github, { status: 302, location: toLogin }), false, 'sent to /login: GitHub ended the sign-in');
  assert.equal(mod.checkResult(github, { status: 302, location: 'https://github.com/sessions/verified-device' }), null, 'sent elsewhere: not confirmed');
  assert.equal(mod.checkResult(github, { status: 302, location: '' }), false, 'a redirect to somewhere unknown: signed out');
  assert.equal(mod.checkResult(github, { status: 200 }, new Set(['logged_in', '_gh_sess'])), false, 'no session cookie held: signed out, whatever the page said');
  assert.equal(mod.checkResult(github, { status: 200 }, new Set(['user_session'])), true);
  assert.equal(mod.checkResult(github, null, new Set(['_gh_sess'])), false, 'no session cookie: signed out even unchecked');
  assert.equal(mod.checkResult(google, { status: 302, location: 'https://accounts.google.com/ServiceLogin' }), false, 'any redirect for a site with no test of its own');
});

test('probe: net.request with manual redirects, the redirect target, a cancelled redirect, and the timeout (2026-10-06)', async () => {
  const session = { id: 'stage' };
  const request = fakeRequest({
    'https://a.example/ok': 200,
    'https://a.example/moved': { status: 302, location: 'https://a.example/login' },
    'https://a.example/cancelled': 'cancel',
    'https://a.example/broken': 'throw',
    'https://a.example/hangs': 'hang',
  });
  assert.deepEqual(await mod.probe(request, session, 'https://a.example/ok'), { status: 200 });
  assert.deepEqual(await mod.probe(request, session, 'https://a.example/moved'), { status: 302, location: 'https://a.example/login' });
  assert.deepEqual(await mod.probe(request, session, 'https://a.example/cancelled'), { status: 302, location: '' }, '"Redirect was cancelled" is a redirect');
  assert.equal(await mod.probe(request, session, 'https://a.example/broken'), null);
  const started = Date.now();
  assert.equal(await mod.probe(request, session, 'https://a.example/hangs', 30), null, 'no answer in time: null');
  assert.ok(Date.now() - started < 1000);
  const { options } = request.requests[0];
  assert.equal(options.redirect, 'manual');
  assert.equal(options.useSessionCookies, true);
  assert.equal(options.session, session, 'over the Stage\'s session');
  assert.ok(request.requests.every((r) => r.aborted), 'every request is aborted once it has its answer (no body is read)');
  assert.equal(mod.CHECK_TIMEOUT_MS, 10000);
});

/* ------------------------------------------------------------------------------------- the importer end to end */

// A machine laid out as macOS would have it, with a Chromium browser (Brave) and Firefox, so the importer finds them.
function makeMachine() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const support = path.join(home, 'Library', 'Application Support');
  const userData = path.join(home, 'userData');
  fs.mkdirSync(userData, { recursive: true });

  const braveRoot = path.join(support, 'BraveSoftware/Brave-Browser');
  fs.mkdirSync(path.join(braveRoot, 'Default', 'Network'), { recursive: true });
  fs.writeFileSync(path.join(braveRoot, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Personal' } } } }));
  makeChromiumDb(path.join(braveRoot, 'Default', 'Network', 'Cookies'), 24, [
    { host: '.github.com', name: 'user_session', value: 'gh-secret', secure: true, httpOnly: true, samesite: 1 },
    { host: '.github.com', name: '__Host-user_session_same_site', value: 'gh-host', secure: true, httpOnly: true, samesite: 1 },
    { host: '.google.com', name: 'SID', value: 'g-secret', secure: true, httpOnly: true, samesite: 0 },
    { host: '.github.com', name: 'session_only', value: 'ephemeral', secure: true, persistent: false },
    { host: '.github.com', name: 'broken', bad: true },
    { host: '.unrelated.com', name: 'x', value: 'skip-me', secure: true },
    // Left out (2026-10-06): a third-party (partitioned) copy of the sign-in, and an expired cookie.
    { host: '.github.com', name: 'user_session', value: 'gh-partitioned', secure: true, httpOnly: true, samesite: 0, topFrame: 'https://embedder.example' },
    { host: '.github.com', name: 'old_session', value: 'gh-expired', secure: true, expiresUtc: unixToChrome(1600000000) },
  ]);

  const ffRoot = path.join(support, 'Firefox', 'Profiles', 'abcd.default-release');
  fs.mkdirSync(ffRoot, { recursive: true });
  makeFirefoxDb(path.join(ffRoot, 'cookies.sqlite'), [
    { host: '.overleaf.com', name: 'overleaf_session2', value: 'ol-secret', expiry: 1893456000, secure: true, httpOnly: true, samesite: 2 },
    { host: '.overleaf.com', name: 'overleaf_session2', value: 'ol-container', expiry: 1893456000, secure: true, httpOnly: true, samesite: 2, origin: '^userContextId=1' },
    { host: '.overleaf.com', name: 'gclb', value: 'ol-expired', expiry: 1600000000, secure: true },
  ]); // schema 14: expiry on disk in milliseconds

  return { home, support, userData };
}

test('sources lists installed browsers and their profiles, values untouched', () => {
  const { support, userData } = makeMachine();
  const importer = mod.createCookieImport({ supportDir: support, userDataDir: userData, getSession: () => fakeSession(), keychain: async () => PASSWORD });
  const sources = importer.sources();
  const brave = sources.find((s) => s.id === 'brave');
  const firefox = sources.find((s) => s.id === 'firefox');
  assert.ok(brave && firefox, 'Brave and Firefox are found');
  assert.deepEqual(brave.profiles, [{ id: 'Default', name: 'Personal' }]);
  assert.equal(firefox.profiles[0].name, 'default-release');
});

test('domains lists domain and count only, with the pre-ticked defaults, and no Keychain', () => {
  const { support, userData } = makeMachine();
  let keychainCalled = false;
  const importer = mod.createCookieImport({ supportDir: support, userDataDir: userData, getSession: () => fakeSession(), keychain: async () => { keychainCalled = true; return PASSWORD; } });
  const result = importer.domains('brave', 'Default');
  assert.equal(keychainCalled, false, 'listing domains never unlocks the Keychain');
  const github = result.domains.find((d) => d.domain === 'github.com');
  assert.equal(github.count, 4, 'the partitioned and the expired copies are not counted');
  assert.equal(importer.domains('firefox', 'abcd.default-release').domains.find((d) => d.domain === 'overleaf.com').count, 1, 'nor the container and expired ones');
  assert.deepEqual(result.defaults, ['github.com', 'google.com', 'overleaf.com', 'zotero.org']);
  for (const entry of result.domains) assert.deepEqual(Object.keys(entry).sort(), ['count', 'domain'], 'domain and count only');
});

test('import writes the ticked domains into the session, calls flushStore, and returns counts only', async () => {
  const { support, userData } = makeMachine();
  const session = fakeSession();
  const request = fakeRequest({ 'https://github.com/settings/profile': 200, 'https://myaccount.google.com/': { status: 302 } });
  const importer = mod.createCookieImport({ supportDir: support, userDataDir: userData, getSession: () => session, request, keychain: async () => PASSWORD, now: () => new Date('2026-10-06T00:00:00Z') });
  const result = await importer.import({ browser: 'brave', profile: 'Default', domains: ['github.com', 'google.com'] });

  // github.com: user_session, __Host-… and session_only decrypt (broken is skipped; the partitioned copy and the expired
  // cookie are left out uncounted); google.com: SID. unrelated.com is not ticked, so it is never decrypted or written.
  assert.equal(result.imported, 4);
  assert.equal(result.skipped, 1);
  assert.equal(result.sessionOnly, 1);
  assert.equal(session.flushes(), 1, 'flushStore was called');
  const names = session.calls.map((c) => c.name).sort();
  assert.ok(names.includes('user_session') && names.includes('SID'));
  assert.equal(names.includes('old_session'), false, 'the expired cookie is not written');
  const sessions = session.calls.filter((c) => c.name === 'user_session');
  assert.equal(sessions.length, 1, 'one user_session: the partitioned copy is never written');
  assert.equal(sessions[0].value, 'gh-secret', 'and so cannot overwrite the real sign-in');
  assert.equal(session.calls.find((c) => c.name === 'user_session').domain, '.github.com', 'a domain cookie keeps its domain');
  assert.equal(session.calls.find((c) => c.name === '__Host-user_session_same_site').domain, undefined);
  // The result is counts and check verdicts only — no value field anywhere.
  assert.deepEqual(Object.keys(result).sort(), ['browser', 'checks', 'imported', 'profile', 'sessionOnly', 'skipped']);
  const github = result.checks.find((c) => c.site === 'GitHub');
  assert.equal(github.signedIn, true);
  assert.equal(result.checks.find((c) => c.site === 'Google').signedIn, false);
});

test('a Keychain denial writes nothing and records nothing', async () => {
  const { support, userData } = makeMachine();
  const session = fakeSession();
  const denial = Object.assign(new Error('Keychain access was denied'), { denied: true });
  const importer = mod.createCookieImport({ supportDir: support, userDataDir: userData, getSession: () => session, keychain: async () => { throw denial; } });
  await assert.rejects(() => importer.import({ browser: 'brave', profile: 'Default', domains: ['github.com'] }), /denied|Nothing was imported/);
  assert.equal(session.calls.length, 0, 'no cookie was written');
  assert.equal(session.flushes(), 0, 'the store was not flushed');
  assert.equal(fs.existsSync(path.join(userData, 'browser-imports.json')), false, 'no record was written');
});

test('Firefox imports with no Keychain, and the record holds domains and counts but no value', async () => {
  const { support, userData } = makeMachine();
  const session = fakeSession();
  let keychainCalled = false;
  const importer = mod.createCookieImport({ supportDir: support, userDataDir: userData, getSession: () => session, request: fakeRequest({ 'https://www.overleaf.com/project': 200 }), keychain: async () => { keychainCalled = true; return PASSWORD; } });
  const result = await importer.import({ browser: 'firefox', profile: 'abcd.default-release', domains: ['overleaf.com'] });
  assert.equal(keychainCalled, false, 'Firefox is not encrypted, so no Keychain prompt');
  assert.equal(result.imported, 1, 'the container copy and the expired cookie are left out');
  assert.equal(session.calls[0].value, 'ol-secret');
  assert.equal(session.calls[0].expirationDate, 1893456000, 'schema 14 milliseconds written as Unix seconds');
  assert.equal(result.checks.find((c) => c.site === 'Overleaf').signedIn, true);

  const record = JSON.parse(fs.readFileSync(path.join(userData, 'browser-imports.json'), 'utf8'));
  assert.equal(record.length, 1);
  assert.deepEqual(record[0].domains, ['overleaf.com']);
  assert.equal(record[0].imported, 1);
  assert.equal(record[0].browser, 'firefox');
  const blob = JSON.stringify(record);
  for (const secret of ['ol-secret', 'ol-container', 'gh-secret', 'g-secret', 'gh-host']) assert.equal(blob.includes(secret), false, 'no cookie value in the record');
});

test('no cookie value appears anywhere the renderer can see (sources, domains, import)', async () => {
  const { support, userData } = makeMachine();
  const session = fakeSession();
  const importer = mod.createCookieImport({ supportDir: support, userDataDir: userData, getSession: () => session, request: fakeRequest({ 'https://github.com/settings/profile': 200 }), keychain: async () => PASSWORD });
  const crossed = JSON.stringify([importer.sources(), importer.domains('brave', 'Default'), await importer.import({ browser: 'brave', profile: 'Default', domains: ['github.com'] })]);
  for (const secret of ['gh-secret', 'gh-host', 'g-secret', 'ephemeral', 'skip-me', 'gh-partitioned', 'gh-expired']) {
    assert.equal(crossed.includes(secret), false, `the value "${secret}" never crosses to the renderer`);
  }
});

/* --------------------------------------------------------------------------------------- follow-ups (2026-10-06) */

test('the GitHub check: no session cookie skips the request; a redirect to /login is signed out; checks run at once, within the timeout', async () => {
  const { support, userData } = makeMachine();

  // Signed out in GitHub's own terms: the page went to /login (endedGithubSession). Overleaf's check hangs.
  const request = fakeRequest({ 'https://github.com/settings/profile': { status: 302, location: 'https://github.com/login?return_to=%2Fsettings%2Fprofile' }, 'https://myaccount.google.com/': 'cancel' });
  const importer = mod.createCookieImport({ supportDir: support, userDataDir: userData, getSession: () => fakeSession(), request, keychain: async () => PASSWORD, checkTimeoutMs: 50 });
  const result = await importer.import({ browser: 'brave', profile: 'Default', domains: ['github.com', 'google.com'] });
  assert.equal(result.checks.find((c) => c.site === 'GitHub').signedIn, false);
  assert.equal(result.checks.find((c) => c.site === 'Google').signedIn, false, '"Redirect was cancelled" is signed out, not null');

  // A profile with no GitHub sign-in: nothing GITHUB_SESSION_COOKIES names, so GitHub is not even asked.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const root = path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  makeChromiumDb(path.join(root, 'Default', 'Network', 'Cookies'), 24, [{ host: '.github.com', name: '_octo', value: 'not-a-sign-in', secure: true }]);
  const quiet = fakeRequest({ 'https://github.com/settings/profile': 200 });
  const signedOut = await mod.createCookieImport({ supportDir: path.join(home, 'Library', 'Application Support'), userDataDir: path.join(home, 'ud'), getSession: () => fakeSession(), request: quiet, keychain: async () => PASSWORD })
    .import({ browser: 'chrome', profile: 'Default', domains: ['github.com'] });
  assert.equal(signedOut.checks[0].signedIn, false);
  assert.equal(quiet.requests.length, 0, 'no request for a sign-in that is not there');

  // Every check hangs: the import still finishes, about one timeout later, not one per site.
  const hanging = fakeRequest({ 'https://github.com/settings/profile': 'hang', 'https://myaccount.google.com/': 'hang' });
  const started = Date.now();
  const slow = await mod.createCookieImport({ supportDir: support, userDataDir: userData, getSession: () => fakeSession(), request: hanging, keychain: async () => PASSWORD, checkTimeoutMs: 80 })
    .import({ browser: 'brave', profile: 'Default', domains: ['github.com', 'google.com'] });
  const took = Date.now() - started;
  assert.deepEqual(slow.checks.map((c) => c.signedIn), [null, null], 'not answered in time: not confirmed');
  assert.ok(took < 1000, `the checks ran at once (${took} ms)`);
});

test('an empty domain list imports nothing: no Keychain, no write, no flush, no record, no check (2026-10-06)', async () => {
  const { support, userData } = makeMachine();
  for (const domains of [[], undefined]) {
    const session = fakeSession();
    const request = fakeRequest({ 'https://github.com/settings/profile': 200 });
    let keychainCalled = false;
    const importer = mod.createCookieImport({ supportDir: support, userDataDir: userData, getSession: () => session, request, keychain: async () => { keychainCalled = true; return PASSWORD; } });
    const result = await importer.import({ browser: 'brave', profile: 'Default', domains });
    assert.deepEqual(result, { browser: 'brave', profile: 'Personal', imported: 0, skipped: 0, sessionOnly: 0, checks: [] });
    assert.equal(keychainCalled, false);
    assert.equal(session.calls.length, 0);
    assert.equal(session.flushes(), 0);
    assert.equal(request.requests.length, 0);
    assert.equal(fs.existsSync(path.join(userData, 'browser-imports.json')), false);
  }
});

test('the Keychain runner over a fake execFile: the password, exit 44 is "not found" (not a denial), 128 is a denial', async () => {
  const ok = fakeExecFile({ stdout: 'peanuts\n' });
  assert.equal(await mod.keychainRunner('Brave Safe Storage', ok), 'peanuts', 'the trailing newline is dropped');
  assert.equal(ok.runs[0].file, '/usr/bin/security');
  assert.deepEqual(ok.runs[0].args, ['find-generic-password', '-w', '-s', 'Brave Safe Storage']);

  const missing = await mod.keychainRunner('Dia Safe Storage', fakeExecFile({ code: 44, stderr: 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.' })).catch((error) => error);
  assert.equal(missing.notFound, true);
  assert.equal(missing.denied, false);

  const denied = await mod.keychainRunner('Chrome Safe Storage', fakeExecFile({ code: 128, stderr: 'security: SecKeychainItemCopyContent: User canceled the operation.' })).catch((error) => error);
  assert.equal(denied.denied, true);
  assert.equal(denied.notFound, false);

  const other = await mod.keychainRunner('Chrome Safe Storage', fakeExecFile({ code: 1, stderr: 'security: something else' })).catch((error) => error);
  assert.equal(other.denied, false);
  assert.equal(other.notFound, false);

  // No answer within the minute (execFile's timeout kills it): a refusal too (2026-10-09).
  const unanswered = await mod.keychainRunner('Chrome Safe Storage', (file, args, options, callback) => { callback(Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM', code: null }), '', ''); }).catch((error) => error);
  assert.deepEqual([unanswered.denied, unanswered.timedOut, unanswered.notFound], [true, true, false]);
  assert.equal(mod.bundleOf('chrome'), 'com.google.Chrome');
  assert.equal(mod.bundleOf('dia'), null, 'not confirmed: never opened in');
});

test('a missing Keychain key says so, by browser name, and imports nothing; a denial still says denied', async () => {
  const { support, userData } = makeMachine();
  const attempt = async (code) => {
    const session = fakeSession();
    const importer = mod.createCookieImport({ supportDir: support, userDataDir: userData, getSession: () => session, request: fakeRequest(), keychain: (name) => mod.keychainRunner(name, fakeExecFile({ code })) });
    const error = await importer.import({ browser: 'brave', profile: 'Default', domains: ['github.com'] }).catch((failure) => failure);
    assert.equal(session.calls.length, 0, 'nothing written');
    return error.message;
  };
  const missing = await attempt(44);
  assert.match(missing, /couldn't find Brave's key in the Keychain/);
  assert.doesNotMatch(missing, /denied/);
  assert.match(await attempt(128), /denied/);
  assert.equal(fs.existsSync(path.join(userData, 'browser-imports.json')), false, 'no record');
});
