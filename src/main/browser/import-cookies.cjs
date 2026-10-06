'use strict';

// Import sign-ins from the person's own browsers into the Stage (MATH-18, 2026-10-06). The Stage keeps every tab in one
// shared cookie store (src/main/browser/views.cjs, `persist:browser`); this module reads the cookies a Chromium-family
// browser or Firefox has on disk and writes the ones the person ticks into that same store, so those sites open already
// signed in. Nothing is kept anywhere else: the picker and the IPC results carry domains and counts only, never values,
// and the only record is userData/browser-imports.json (domains and counts, never values — CK-12, CK-13).
//
// macOS only, and only against the person's own machine at import time: a Build must test this with fixtures alone and
// never read the real profiles or Keychain. So everything that touches the machine is injected (the Keychain runner, the
// browsing session, the folders), and the pure parts — the decryption, the time and sameSite conversions, the cookies.set
// details — are plain functions the tests drive directly.
//
// Reference, not a dependency (CK-06): the v10 decryption and the >= 24 hash-prefix strip follow what read-browser-cookies
// and yt-dlp do for Chromium on macOS. No native module is added; node:sqlite (built into Electron 44's Node) reads the
// database, and node:crypto does the decryption.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

// The Chromium-family browsers (CK-01). `dir` is under ~/Library/Application Support; `keychain` is the Keychain generic
// password whose value derives the decryption key. Chrome, Brave, Edge, Vivaldi, Opera and Chromium are the long-standing
// names. Arc, Comet and Dia are newer Chromium forks: their folders and Keychain names are set from their published layout
// but were NOT verified against an installed copy here (the Build may not read real profiles) — confirm before relying.
const CHROMIUM = [
  { id: 'chrome', name: 'Chrome', dir: 'Google/Chrome', keychain: 'Chrome Safe Storage' },
  { id: 'brave', name: 'Brave', dir: 'BraveSoftware/Brave-Browser', keychain: 'Brave Safe Storage' },
  { id: 'edge', name: 'Edge', dir: 'Microsoft Edge', keychain: 'Microsoft Edge Safe Storage' },
  { id: 'vivaldi', name: 'Vivaldi', dir: 'Vivaldi', keychain: 'Vivaldi Safe Storage' },
  { id: 'opera', name: 'Opera', dir: 'com.operasoftware.Opera', keychain: 'Opera Safe Storage' },
  { id: 'chromium', name: 'Chromium', dir: 'Chromium', keychain: 'Chromium Safe Storage' },
  { id: 'arc', name: 'Arc', dir: 'Arc/User Data', keychain: 'Arc Safe Storage' }, // verify
  { id: 'comet', name: 'Comet', dir: 'Comet', keychain: 'Comet Safe Storage' }, // verify
  { id: 'dia', name: 'Dia', dir: 'Dia/User Data', keychain: 'Dia Safe Storage' }, // verify
];
const FIREFOX = { id: 'firefox', name: 'Firefox', dir: 'Firefox' };
const BY_ID = new Map([...CHROMIUM.map((b) => [b.id, { ...b, family: 'chromium' }]), [FIREFOX.id, { ...FIREFOX, family: 'firefox' }]]);

// Chromium stores times as microseconds since 1601-01-01; Unix time counts seconds since 1970-01-01. The gap is fixed.
const WINDOWS_TO_UNIX_SECONDS = 11644473600;
const AES_IV = Buffer.alloc(16, ' '); // 16 spaces, the macOS Chromium IV
const V10 = Buffer.from('v10');

/** The key macOS Chromium derives from its Keychain password: PBKDF2-SHA1, salt 'saltysalt', 1003 rounds, 16 bytes. */
function deriveKey(password) {
  return crypto.pbkdf2Sync(Buffer.from(String(password), 'utf8'), Buffer.from('saltysalt'), 1003, 16, 'sha1');
}

/**
 * One Chromium cookie value, decrypted (CK-06). Values Chromium left in the clear (no `v10` prefix) are returned as they
 * are. A `v10` value is AES-128-CBC with the derived key and the space IV; when the database's meta version is >= 24 the
 * plaintext begins with a 32-byte domain hash that is dropped. Anything that will not decrypt cleanly returns null, so the
 * caller skips and counts it rather than writing a broken value.
 */
function decryptChromiumValue(encrypted, plainValue, key, metaVersion) {
  const buffer = encrypted && encrypted.length ? Buffer.from(encrypted.buffer || encrypted, encrypted.byteOffset || 0, encrypted.length) : Buffer.alloc(0);
  if (!buffer.length) return typeof plainValue === 'string' ? plainValue : '';
  if (!buffer.subarray(0, 3).equals(V10)) {
    // Not Chromium's macOS scheme (e.g. a DPAPI value copied from Windows): nothing to do here but the plaintext, if any.
    return typeof plainValue === 'string' && plainValue ? plainValue : null;
  }
  if (!key) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, AES_IV);
    let plain = Buffer.concat([decipher.update(buffer.subarray(3)), decipher.final()]);
    if (Number(metaVersion) >= 24) {
      if (plain.length < 32) return null;
      plain = plain.subarray(32);
    }
    return plain.toString('utf8');
  } catch {
    return null; // bad padding / wrong key: skip, counted by the caller
  }
}

/** Chromium's microseconds-since-1601 to Unix seconds. 0 (no expiry recorded) comes back as 0. */
function chromeTimeToUnixSeconds(microseconds) {
  const value = Number(microseconds);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value / 1e6 - WINDOWS_TO_UNIX_SECONDS);
}

// Chromium's `samesite` column: -1 unspecified, 0 None, 1 Lax, 2 Strict (CK-08).
const CHROMIUM_SAMESITE = { '-1': 'unspecified', 0: 'no_restriction', 1: 'lax', 2: 'strict' };
// Firefox's `sameSite` column: 0 means unset here (older rows default to it), 1 Lax, 2 Strict — there is no explicit None,
// so 0 maps to 'unspecified' and lets Chromium apply its own default rather than claiming cross-site None.
const FIREFOX_SAMESITE = { 0: 'unspecified', 1: 'lax', 2: 'strict' };

function sameSiteOf(table, value) {
  const key = String(value);
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : 'unspecified';
}

const stripLeadingDot = (host) => String(host || '').replace(/^\./, '');

/**
 * The cookies.set details for one normalized cookie (CK-08, CK-09). `host_key` with a leading dot is a domain cookie and
 * keeps its domain; a host-only cookie gets none. A `__Host-` cookie is written without a domain whatever its host_key
 * says. `secure`/`httpOnly` carry over; `sameSite` is already mapped. A persistent cookie keeps its expiry in Unix seconds;
 * a session cookie is written as a session cookie (no expirationDate), so it lasts only as long as the Stage runs.
 */
function cookieSetDetails(cookie) {
  const host = stripLeadingDot(cookie.host);
  const cookiePath = cookie.path || '/';
  const url = `${cookie.secure ? 'https' : 'http'}://${host}${cookiePath.startsWith('/') ? '' : '/'}${cookiePath}`;
  const details = {
    url,
    name: cookie.name,
    value: cookie.value,
    path: cookiePath,
    secure: !!cookie.secure,
    httpOnly: !!cookie.httpOnly,
    sameSite: cookie.sameSite || 'unspecified',
  };
  const hostPrefixed = /^__Host-/.test(cookie.name);
  if (!hostPrefixed && String(cookie.host || '').startsWith('.')) details.domain = cookie.host;
  if (cookie.persistent && cookie.expires > 0) details.expirationDate = cookie.expires;
  return details;
}

/* ------------------------------------------------------------------------------------------ reading the databases */

// node:sqlite ships with Electron 44's Node but is still gated; load it lazily and let the caller report a clear stop
// rather than reaching for a native module (CK-04).
function loadSqlite() {
  try {
    // eslint-disable-next-line global-require
    return require('node:sqlite');
  } catch {
    return null;
  }
}

/** A private copy of `source` and its -wal/-shm siblings in a fresh temp dir, read by `read`, deleted in a finally (CK-04). */
function withCopy(source, tmpBase, read) {
  const dir = fs.mkdtempSync(path.join(tmpBase || os.tmpdir(), 'engelbart-cookies-'));
  try {
    const copy = path.join(dir, 'Cookies');
    fs.copyFileSync(source, copy);
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(source + suffix)) fs.copyFileSync(source + suffix, copy + suffix);
    }
    return read(copy);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function openDb(file) {
  const sqlite = loadSqlite();
  if (!sqlite) throw new Error('This build of Engelbart cannot read cookie databases (node:sqlite is missing).');
  return new sqlite.DatabaseSync(file, { readOnly: false });
}

function tableColumns(db, table) {
  try { return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name))); } catch { return new Set(); }
}

/** The Chromium `meta` table's schema version (the `version` row), or 0 when it cannot be read. */
function metaVersion(db) {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'version'").get();
    return row ? Number(row.value) || 0 : 0;
  } catch {
    return 0;
  }
}

function asBuffer(value) {
  if (value == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return Buffer.alloc(0);
}

// Chromium times (expires_utc) and Firefox creationTime/lastAccessed are 64-bit and overflow a JS number, so the rows are
// read with BigInt integers; this makes a plain number of whatever comes back (a BigInt loses sub-second precision only).
const num = (value) => (typeof value === 'bigint' ? Number(value) : Number(value || 0));
function allRows(db, sql) {
  const statement = db.prepare(sql);
  if (typeof statement.setReadBigInts === 'function') statement.setReadBigInts(true);
  return statement.all();
}

/**
 * Every row of a Chromium Cookies database, column names handled across versions (older `secure`/`httponly`, newer
 * `is_secure`/`is_httponly`). Values are not decrypted here — that waits for a key, so listing domains needs no Keychain.
 */
function readChromiumDb(file) {
  const db = openDb(file);
  try {
    const cols = tableColumns(db, 'cookies');
    const secureCol = cols.has('is_secure') ? 'is_secure' : 'secure';
    const httpCol = cols.has('is_httponly') ? 'is_httponly' : 'httponly';
    const rows = allRows(db, 'SELECT * FROM cookies');
    return {
      version: metaVersion(db),
      rows: rows.map((row) => ({
        host: String(row.host_key || ''),
        name: String(row.name || ''),
        plainValue: typeof row.value === 'string' ? row.value : '',
        encrypted: asBuffer(row.encrypted_value),
        path: String(row.path || '/'),
        expiresUtc: num(row.expires_utc),
        secure: !!num(row[secureCol]),
        httpOnly: !!num(row[httpCol]),
        samesite: cols.has('samesite') ? num(row.samesite) : -1,
        persistent: cols.has('is_persistent') ? !!num(row.is_persistent) : true,
        hasExpires: cols.has('has_expires') ? !!num(row.has_expires) : true,
      })),
    };
  } finally {
    db.close();
  }
}

/**
 * Every row of a Firefox cookies.sqlite (CK-02). Firefox leaves values in the clear, so there is no key and no decryption;
 * `expiry` is in seconds in current versions (creationTime/lastAccessed are microseconds, but expiry is not), so it is used
 * as-is for the Unix expirationDate.
 */
function readFirefoxDb(file) {
  const db = openDb(file);
  try {
    const cols = tableColumns(db, 'moz_cookies');
    const rows = allRows(db, 'SELECT * FROM moz_cookies');
    return {
      rows: rows.map((row) => ({
        host: String(row.host || ''),
        name: String(row.name || ''),
        plainValue: typeof row.value === 'string' ? row.value : '',
        path: String(row.path || '/'),
        expirySeconds: num(row.expiry),
        secure: !!num(row.isSecure),
        httpOnly: !!num(row.isHttpOnly),
        samesite: cols.has('sameSite') ? num(row.sameSite) : 0,
      })),
    };
  } finally {
    db.close();
  }
}

/* ------------------------------------------------------------------------------------------------- normalizing */

// A few multi-part public suffixes, enough to group cookies by the site a person recognizes (github.com, google.co.uk)
// without a full public-suffix list. A miss only changes how domains are grouped in the picker, never what is written.
const MULTI_SUFFIX = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'co.jp', 'co.nz', 'co.za', 'com.au', 'com.br', 'co.in']);

/** The registrable domain of a host, for grouping and matching ('.www.github.com' -> 'github.com'). */
function registrableDomain(host) {
  const clean = stripLeadingDot(host).toLowerCase();
  const labels = clean.split('.').filter(Boolean);
  if (labels.length <= 2) return clean;
  const lastTwo = labels.slice(-2).join('.');
  if (MULTI_SUFFIX.has(lastTwo)) return labels.slice(-3).join('.');
  return lastTwo;
}

/**
 * Chromium rows -> cookies for cookies.set, decrypting values and dropping those that will not decrypt (counted). When
 * `want` (a Set of registrable domains) is given, only rows for those domains are considered, so the skipped count and the
 * decryption are scoped to what is being imported — a value from a domain the person did not tick is never even decrypted.
 */
function normalizeChromium({ version, rows }, key, want = null) {
  const cookies = [];
  let skipped = 0;
  for (const row of rows) {
    if (want && !want.has(registrableDomain(row.host))) continue;
    const value = decryptChromiumValue(row.encrypted, row.plainValue, key, version);
    if (value == null) { skipped += 1; continue; }
    cookies.push({
      host: row.host,
      name: row.name,
      value,
      path: row.path,
      secure: row.secure,
      httpOnly: row.httpOnly,
      sameSite: sameSiteOf(CHROMIUM_SAMESITE, row.samesite),
      persistent: row.persistent && row.hasExpires,
      expires: chromeTimeToUnixSeconds(row.expiresUtc),
    });
  }
  return { cookies, skipped };
}

/** Firefox rows -> cookies for cookies.set. Nothing to decrypt, so nothing is skipped for decryption. `want` as above. */
function normalizeFirefox({ rows }, want = null) {
  const cookies = rows.filter((row) => !want || want.has(registrableDomain(row.host))).map((row) => ({
    host: row.host,
    name: row.name,
    value: row.plainValue,
    path: row.path,
    secure: row.secure,
    httpOnly: row.httpOnly,
    sameSite: sameSiteOf(FIREFOX_SAMESITE, row.samesite),
    persistent: row.expirySeconds > 0,
    expires: row.expirySeconds,
  }));
  return { cookies, skipped: 0 };
}

/* ------------------------------------------------------------------------------------------- sign-in checks (CK-14) */

// Each site a person is likely to import, with a page that needs a sign-in: visited with the imported session and NOT
// following redirects, it answers 200 when the session is live and redirects to a login page when it is not. The verdict
// is read from the status alone — a 2xx is signed in, a 3xx (or an opaque redirect the browser hides) is signed out —
// because Electron's net.fetch does not report the final URL reliably, only the status. No cookie is ever read. GitHub's
// `endedGithubSession` / GITHUB_SESSION_COOKIES (src/shared/github.cjs) describe the same "GitHub sends you to /login"
// signal this relies on; they stay imported so the Stage and the importer agree on it.
const SIGN_IN_CHECKS = [
  { site: 'GitHub', domain: 'github.com', url: 'https://github.com/settings/profile' },
  { site: 'Google', domain: 'google.com', url: 'https://myaccount.google.com/' },
  { site: 'Overleaf', domain: 'overleaf.com', url: 'https://www.overleaf.com/project' },
  { site: 'Zotero', domain: 'zotero.org', url: 'https://www.zotero.org/settings/' },
];
const CHECK_BY_DOMAIN = new Map(SIGN_IN_CHECKS.map((check) => [check.domain, check]));
const DEFAULT_DOMAINS = SIGN_IN_CHECKS.map((check) => check.domain);

/** Whether a manual-redirect fetch landed on the page itself (signed in) or was bounced to a login (signed out, a 3xx). */
function wasRedirect(response) {
  if (!response) return false;
  const status = Number(response.status) || 0;
  return response.type === 'opaqueredirect' || status === 0 || (status >= 300 && status < 400);
}

/** The signed-in verdict for one site: true signed in (a 2xx, no redirect), false signed out, null if it could not run. */
function checkResult(check, response) {
  if (!response) return null;
  const status = Number(response.status) || 0;
  if (wasRedirect(response)) return false;
  return status >= 200 && status < 300;
}

/* ------------------------------------------------------------------------------------------------ the record (CK-12) */

/** Append one import to userData/browser-imports.json: browser, profile, domains, time and counts. Never values. */
function recordImport(file, entry) {
  let list = [];
  try { const text = fs.readFileSync(file, 'utf8'); const parsed = JSON.parse(text); if (Array.isArray(parsed)) list = parsed; } catch { list = []; }
  list.push(entry);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(list, null, 2));
  return entry;
}

/* ------------------------------------------------------------------------------------------- finding what is installed */

const existsDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const existsFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/** The Cookies file for a Chromium profile: newer Chromium keeps it under Network/, older alongside the profile. */
function chromiumCookieFile(profileDir) {
  const network = path.join(profileDir, 'Network', 'Cookies');
  if (existsFile(network)) return network;
  const direct = path.join(profileDir, 'Cookies');
  return existsFile(direct) ? direct : '';
}

/** A Chromium browser's profiles from its Local State (profile.info_cache gives each its own name), only those with cookies. */
function chromiumProfiles(root) {
  const profiles = [];
  let info = {};
  try { info = (JSON.parse(fs.readFileSync(path.join(root, 'Local State'), 'utf8')).profile || {}).info_cache || {}; } catch { info = {}; }
  const dirs = new Set(Object.keys(info));
  // A fresh browser may have Default before Local State lists it.
  if (existsDir(path.join(root, 'Default'))) dirs.add('Default');
  for (const dir of dirs) {
    const file = chromiumCookieFile(path.join(root, dir));
    if (!file) continue;
    profiles.push({ id: dir, name: (info[dir] && info[dir].name) || dir, cookieFile: file });
  }
  return profiles;
}

/** A Firefox installation's profiles: each Profiles/* folder that has a cookies.sqlite. */
function firefoxProfiles(root) {
  const base = path.join(root, 'Profiles');
  if (!existsDir(base)) return [];
  const profiles = [];
  for (const dir of fs.readdirSync(base)) {
    const file = path.join(base, dir, 'cookies.sqlite');
    if (!existsFile(file)) continue;
    profiles.push({ id: dir, name: dir.replace(/^[^.]*\./, '') || dir, cookieFile: file });
  }
  return profiles;
}

function profilesFor(browser, supportDir) {
  const root = path.join(supportDir, browser.dir);
  if (!existsDir(root)) return [];
  return browser.family === 'firefox' ? firefoxProfiles(root) : chromiumProfiles(root);
}

/* --------------------------------------------------------------------------------------------------- the importer */

/**
 * The cookie importer. Everything that reaches the machine is injected so a Build can exercise it against fixtures:
 *  - `supportDir`  : ~/Library/Application Support (where the browser folders are).
 *  - `userDataDir` : Electron's userData (browser-imports.json goes here).
 *  - `tmpBase`     : where the private database copy is made.
 *  - `getSession()`: the Stage's persist:browser session (its `cookies` store and `fetch`).
 *  - `keychain(serviceName)`: the Keychain password for a Chromium browser, or a thrown denial (CK-05).
 *  - `now()`       : the time written into the record.
 */
function createCookieImport({ supportDir, userDataDir, tmpBase = os.tmpdir(), getSession, keychain, now = () => new Date() }) {
  const importsFile = path.join(userDataDir || '.', 'browser-imports.json');

  /** The installed browsers and their profiles, domains and values untouched (CK-03). */
  function sources() {
    const out = [];
    for (const browser of BY_ID.values()) {
      const profiles = profilesFor(browser, supportDir);
      if (profiles.length) out.push({ id: browser.id, name: browser.name, family: browser.family, profiles: profiles.map((p) => ({ id: p.id, name: p.name })) });
    }
    return out;
  }

  function resolveProfile(browserId, profileId) {
    const browser = BY_ID.get(browserId);
    if (!browser) throw new Error('That browser is not one Engelbart can import from.');
    const profile = profilesFor(browser, supportDir).find((p) => p.id === profileId);
    if (!profile) throw new Error('That browser profile is no longer there.');
    return { browser, profile };
  }

  /** The ticked domains' cookies for a profile, read from a private copy and (Chromium) decrypted. Values stay in main. */
  function readProfile(browser, profile, key, want) {
    if (browser.family === 'firefox') return normalizeFirefox(withCopy(profile.cookieFile, tmpBase, readFirefoxDb), want);
    return normalizeChromium(withCopy(profile.cookieFile, tmpBase, readChromiumDb), key, want);
  }

  /** The domains a profile has cookies for, with counts (CK-07). No Keychain: listing never decrypts. */
  function domains(browserId, profileId) {
    const { browser, profile } = resolveProfile(browserId, profileId);
    const counts = new Map();
    const read = browser.family === 'firefox' ? withCopy(profile.cookieFile, tmpBase, readFirefoxDb) : withCopy(profile.cookieFile, tmpBase, readChromiumDb);
    for (const row of read.rows) {
      const domain = registrableDomain(row.host);
      if (!domain) continue;
      counts.set(domain, (counts.get(domain) || 0) + 1);
    }
    const list = [...counts.entries()].map(([domain, count]) => ({ domain, count })).sort((a, b) => (b.count - a.count) || a.domain.localeCompare(b.domain));
    return { browser: browser.id, profile: profile.id, defaults: DEFAULT_DOMAINS, domains: list };
  }

  /** Run the signed-in check for each imported domain that has one, over the Stage's session. Failures come back null. */
  async function runChecks(session, importedDomains) {
    const checks = [];
    for (const domain of importedDomains) {
      const check = CHECK_BY_DOMAIN.get(domain);
      if (!check) continue;
      let response = null;
      try {
        const res = await session.fetch(check.url, { useSessionCookies: true, cache: 'no-store', redirect: 'manual' });
        response = { status: res.status || 0, type: res.type };
      } catch {
        response = null;
      }
      checks.push({ site: check.site, domain: check.domain, url: check.url, signedIn: checkResult(check, response) });
    }
    return checks;
  }

  /**
   * Import the ticked domains' cookies into the Stage (CK-08–CK-13). Returns counts only — { imported, skipped, sessionOnly,
   * checks } — with no cookie value anywhere in it. A Keychain denial (Chromium) throws before anything is written (CK-05).
   */
  async function run({ browser: browserId, profile: profileId, domains: wanted }) {
    const { browser, profile } = resolveProfile(browserId, profileId);
    const want = new Set((Array.isArray(wanted) && wanted.length ? wanted : DEFAULT_DOMAINS).map((d) => String(d).toLowerCase()));

    let key = null;
    if (browser.family === 'chromium') {
      try {
        key = deriveKey(await keychain(browser.keychain));
      } catch (error) {
        const denied = error && (error.denied || /denied|-128|not be found|cancel/i.test(error.message || ''));
        throw new Error(denied
          ? `Engelbart needs Keychain access to read ${browser.name}'s cookies, and the request was denied. Nothing was imported.`
          : `Engelbart could not read ${browser.name}'s Keychain key. Nothing was imported.`);
      }
    }

    const { cookies, skipped } = readProfile(browser, profile, key, want);
    const session = getSession();
    const store = session.cookies;
    let imported = 0;
    let sessionOnly = 0;
    for (const cookie of cookies) {
      try {
        await store.set(cookieSetDetails(cookie));
        imported += 1;
        if (!(cookie.persistent && cookie.expires > 0)) sessionOnly += 1;
      } catch {
        // A value Chromium holds that Electron will not take (an out-of-range expiry, a host it rejects) is skipped, not
        // fatal. The error is swallowed unread, so no value can leak through its message.
      }
    }
    await store.flushStore();

    const importedDomains = [...want];
    const checks = await runChecks(session, importedDomains);
    recordImport(importsFile, {
      browser: browser.id,
      browserName: browser.name,
      profile: profile.name,
      domains: importedDomains,
      time: now().toISOString(),
      imported,
      skipped,
      sessionOnly,
    });
    return { browser: browser.id, profile: profile.name, imported, skipped, sessionOnly, checks };
  }

  return { sources, domains, import: run };
}

/** The default Keychain runner (CK-05): `security find-generic-password -w -s "<name>"`. A denial is a distinct error. */
function keychainRunner(serviceName) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/security', ['find-generic-password', '-w', '-s', serviceName], { timeout: 60000 }, (error, stdout) => {
      if (error) {
        const denied = error.code === 128 || error.code === 44 || error.code === 45 || /denied|user (?:name|interaction)|cancel/i.test(error.message || '');
        const failure = new Error(denied ? 'Keychain access was denied' : 'The Keychain key could not be read');
        failure.denied = denied;
        reject(failure);
        return;
      }
      resolve(String(stdout).replace(/\n$/, ''));
    });
  });
}

module.exports = {
  CHROMIUM,
  FIREFOX,
  DEFAULT_DOMAINS,
  SIGN_IN_CHECKS,
  deriveKey,
  decryptChromiumValue,
  chromeTimeToUnixSeconds,
  sameSiteOf,
  CHROMIUM_SAMESITE,
  FIREFOX_SAMESITE,
  registrableDomain,
  cookieSetDetails,
  readChromiumDb,
  readFirefoxDb,
  normalizeChromium,
  normalizeFirefox,
  withCopy,
  checkResult,
  recordImport,
  createCookieImport,
  keychainRunner,
  loadSqlite,
};
