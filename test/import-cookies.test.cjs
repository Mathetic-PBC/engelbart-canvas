'use strict';

// Importing sign-ins from the person's browsers into the Stage (MATH-18, src/main/browser/import-cookies.cjs). Everything
// here runs against fixtures: Chromium databases (meta version < 24 and >= 24) encrypted with a known password, a Firefox
// database, a fake Keychain and a fake persist:browser session. No real profile or Keychain is read. The checks cover the
// decryption and the >= 24 hash-prefix strip, the time and sameSite conversions, __Host- and host-only domains, the skipped
// count, that a fake cookies.set gets the right calls and flushStore is called, that a Keychain denial writes nothing, and
// that no cookie value reaches the IPC result or browser-imports.json.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
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

// A Chromium Cookies database at `file`. `rows` describe cookies; `bad` ones get a value that will not decrypt.
function makeChromiumDb(file, version, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE meta (key TEXT NOT NULL, value TEXT)');
  db.prepare('INSERT INTO meta VALUES (?, ?)').run('version', String(version));
  db.exec('CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, has_expires INTEGER, is_persistent INTEGER)');
  const insert = db.prepare('INSERT INTO cookies (host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite, has_expires, is_persistent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const row of rows) {
    const encrypted = row.bad ? Buffer.concat([Buffer.from('v10'), Buffer.from('not-a-valid-block')]) : encryptV10(row.value, { version });
    insert.run(
      row.host, row.name, '', encrypted, row.path || '/',
      BigInt(Math.round(row.expiresUtc != null ? row.expiresUtc : unixToChrome(4102444800))), // default 2100
      row.secure ? 1 : 0, row.httpOnly ? 1 : 0, row.samesite == null ? -1 : row.samesite,
      row.persistent === false ? 0 : 1, row.persistent === false ? 0 : 1,
    );
  }
  db.close();
}

function makeFirefoxDb(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, host TEXT, name TEXT, value TEXT, path TEXT, expiry INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER, creationTime INTEGER, lastAccessed INTEGER)');
  const insert = db.prepare('INSERT INTO moz_cookies (host, name, value, path, expiry, isSecure, isHttpOnly, sameSite, creationTime, lastAccessed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const row of rows) {
    insert.run(row.host, row.name, row.value, row.path || '/', row.expiry || 0, row.secure ? 1 : 0, row.httpOnly ? 1 : 0, row.samesite || 0,
      BigInt('16700000000000000'), BigInt('16700000000000000')); // microseconds: large, must not break the read
  }
  db.close();
}

// A fake persist:browser session: records every cookies.set and flushStore, and answers fetch from a script. Each value
// in `fetchMap` is the response the check sees — a number status (200 signed in), { status, type } for a redirect, or
// 'throw' for a failed fetch. The importer fetches with redirect:'manual', so a bounced sign-in is a 3xx / opaqueredirect.
function fakeSession(fetchMap = {}) {
  const calls = [];
  let flushed = 0;
  return {
    calls,
    flushes: () => flushed,
    cookies: {
      set: async (details) => { calls.push(details); },
      flushStore: async () => { flushed += 1; },
    },
    fetch: async (url) => {
      const landed = fetchMap[url];
      if (landed === 'throw' || landed === undefined) throw new Error('not scripted');
      return typeof landed === 'number' ? { status: landed } : landed;
    },
  };
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

test('a Firefox database is read with plaintext values and seconds expiry', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'firefox-'));
  const file = path.join(dir, 'cookies.sqlite');
  makeFirefoxDb(file, [
    { host: '.overleaf.com', name: 'overleaf_session2', value: 'ff-value', path: '/', expiry: 1893456000, secure: true, httpOnly: true, samesite: 2 },
  ]);
  const { cookies, skipped } = mod.normalizeFirefox(mod.withCopy(file, dir, mod.readFirefoxDb));
  assert.equal(skipped, 0);
  assert.equal(cookies[0].value, 'ff-value');
  assert.equal(cookies[0].expires, 1893456000);
  assert.equal(cookies[0].sameSite, 'strict');
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
  ]);

  const ffRoot = path.join(support, 'Firefox', 'Profiles', 'abcd.default-release');
  fs.mkdirSync(ffRoot, { recursive: true });
  makeFirefoxDb(path.join(ffRoot, 'cookies.sqlite'), [
    { host: '.overleaf.com', name: 'overleaf_session2', value: 'ol-secret', expiry: 1893456000, secure: true, httpOnly: true, samesite: 2 },
  ]);

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
  assert.equal(github.count, 4);
  assert.deepEqual(result.defaults, ['github.com', 'google.com', 'overleaf.com', 'zotero.org']);
  for (const entry of result.domains) assert.deepEqual(Object.keys(entry).sort(), ['count', 'domain'], 'domain and count only');
});

test('import writes the ticked domains into the session, calls flushStore, and returns counts only', async () => {
  const { support, userData } = makeMachine();
  const session = fakeSession({ 'https://github.com/settings/profile': 200, 'https://myaccount.google.com/': { status: 302 } });
  const importer = mod.createCookieImport({ supportDir: support, userDataDir: userData, getSession: () => session, keychain: async () => PASSWORD, now: () => new Date('2026-10-06T00:00:00Z') });
  const result = await importer.import({ browser: 'brave', profile: 'Default', domains: ['github.com', 'google.com'] });

  // github.com: user_session, __Host-… and session_only decrypt (broken is skipped); google.com: SID. unrelated.com is
  // not ticked, so it is never decrypted or written.
  assert.equal(result.imported, 4);
  assert.equal(result.skipped, 1);
  assert.equal(result.sessionOnly, 1);
  assert.equal(session.flushes(), 1, 'flushStore was called');
  const names = session.calls.map((c) => c.name).sort();
  assert.ok(names.includes('user_session') && names.includes('SID'));
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
  const session = fakeSession({ 'https://www.overleaf.com/project': 200 });
  let keychainCalled = false;
  const importer = mod.createCookieImport({ supportDir: support, userDataDir: userData, getSession: () => session, keychain: async () => { keychainCalled = true; return PASSWORD; } });
  const result = await importer.import({ browser: 'firefox', profile: 'abcd.default-release', domains: ['overleaf.com'] });
  assert.equal(keychainCalled, false, 'Firefox is not encrypted, so no Keychain prompt');
  assert.equal(result.imported, 1);
  assert.equal(result.checks.find((c) => c.site === 'Overleaf').signedIn, true);

  const record = JSON.parse(fs.readFileSync(path.join(userData, 'browser-imports.json'), 'utf8'));
  assert.equal(record.length, 1);
  assert.deepEqual(record[0].domains, ['overleaf.com']);
  assert.equal(record[0].imported, 1);
  assert.equal(record[0].browser, 'firefox');
  const blob = JSON.stringify(record);
  for (const secret of ['ol-secret', 'gh-secret', 'g-secret', 'gh-host']) assert.equal(blob.includes(secret), false, 'no cookie value in the record');
});

test('no cookie value appears anywhere the renderer can see (sources, domains, import)', async () => {
  const { support, userData } = makeMachine();
  const session = fakeSession({ 'https://github.com/settings/profile': 200 });
  const importer = mod.createCookieImport({ supportDir: support, userDataDir: userData, getSession: () => session, keychain: async () => PASSWORD });
  const crossed = JSON.stringify([importer.sources(), importer.domains('brave', 'Default'), await importer.import({ browser: 'brave', profile: 'Default', domains: ['github.com'] })]);
  for (const secret of ['gh-secret', 'gh-host', 'g-secret', 'ephemeral', 'skip-me']) {
    assert.equal(crossed.includes(secret), false, `the value "${secret}" never crosses to the renderer`);
  }
});
