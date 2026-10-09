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
const { endedGithubSession, GITHUB_SESSION_COOKIES } = require('../../shared/github.cjs');

// The Chromium-family browsers (CK-01). `dir` is under ~/Library/Application Support; `keychain` is the Keychain generic
// password whose value derives the decryption key; `bundle` the macOS bundle id `open -b` opens a page in (Connect your
// library's sign-in in another browser than the default, ../connect/web-signin.cjs). Chrome, Brave, Edge, Vivaldi, Opera and
// Chromium are the long-standing names. Arc, Comet and Dia are newer Chromium forks: their folders and Keychain names are set
// from their published layout but were NOT verified against an installed copy here (the Build may not read real profiles) —
// confirm before relying. Comet's and Dia's bundle ids are not confirmed, so they are left out: a page is never opened in them.
const CHROMIUM = [
  { id: 'chrome', name: 'Chrome', dir: 'Google/Chrome', keychain: 'Chrome Safe Storage', bundle: 'com.google.Chrome' },
  { id: 'brave', name: 'Brave', dir: 'BraveSoftware/Brave-Browser', keychain: 'Brave Safe Storage', bundle: 'com.brave.Browser' },
  { id: 'edge', name: 'Edge', dir: 'Microsoft Edge', keychain: 'Microsoft Edge Safe Storage', bundle: 'com.microsoft.edgemac' },
  { id: 'vivaldi', name: 'Vivaldi', dir: 'Vivaldi', keychain: 'Vivaldi Safe Storage', bundle: 'com.vivaldi.Vivaldi' },
  { id: 'opera', name: 'Opera', dir: 'com.operasoftware.Opera', keychain: 'Opera Safe Storage', bundle: 'com.operasoftware.Opera' },
  { id: 'chromium', name: 'Chromium', dir: 'Chromium', keychain: 'Chromium Safe Storage', bundle: 'org.chromium.Chromium' },
  { id: 'arc', name: 'Arc', dir: 'Arc/User Data', keychain: 'Arc Safe Storage', bundle: 'company.thebrowser.Browser' }, // verify
  { id: 'comet', name: 'Comet', dir: 'Comet', keychain: 'Comet Safe Storage' }, // verify
  { id: 'dia', name: 'Dia', dir: 'Dia/User Data', keychain: 'Dia Safe Storage' }, // verify
];
const FIREFOX = { id: 'firefox', name: 'Firefox', dir: 'Firefox', bundle: 'org.mozilla.firefox' };
const BY_ID = new Map([...CHROMIUM.map((b) => [b.id, { ...b, family: 'chromium' }]), [FIREFOX.id, { ...FIREFOX, family: 'firefox' }]]);

/** The macOS bundle id of a browser the importer knows, or null (none confirmed, or not one it knows). */
const bundleOf = (id) => (BY_ID.get(id) && BY_ID.get(id).bundle) || null;

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
 * `topFrameSiteKey` is set on a partitioned (CHIPS) cookie: a copy a site keeps while embedded in another site.
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
        topFrameSiteKey: cols.has('top_frame_site_key') ? String(row.top_frame_site_key || '') : '',
      })),
    };
  } finally {
    db.close();
  }
}

// Firefox's cookie schema 14 stores moz_cookies.expiry in milliseconds; before it, seconds (2026-10-06, Mozilla's
// netwerk/test/unit/test_schema_14_migration.js). The schema is the database's user_version.
const FIREFOX_EXPIRY_MS_SCHEMA = 14;

/** A SQLite database's user_version (Firefox's cookie schema), or 0 when it cannot be read. */
function userVersion(db) {
  try {
    const row = db.prepare('PRAGMA user_version').get();
    return row ? Number(row.user_version) || 0 : 0;
  } catch {
    return 0;
  }
}

/**
 * Every row of a Firefox cookies.sqlite (CK-02). Firefox leaves values in the clear, so there is no key and no decryption.
 * `expirySeconds` is Unix seconds whatever the schema: milliseconds from schema 14 on are divided down. A non-empty
 * `originAttributes` marks a container's, a partitioned or a first-party-isolated copy rather than the plain sign-in.
 */
function readFirefoxDb(file) {
  const db = openDb(file);
  try {
    const cols = tableColumns(db, 'moz_cookies');
    const schema = userVersion(db);
    const rows = allRows(db, 'SELECT * FROM moz_cookies');
    return {
      schema,
      rows: rows.map((row) => ({
        host: String(row.host || ''),
        name: String(row.name || ''),
        plainValue: typeof row.value === 'string' ? row.value : '',
        path: String(row.path || '/'),
        expirySeconds: schema >= FIREFOX_EXPIRY_MS_SCHEMA ? Math.floor(num(row.expiry) / 1000) : num(row.expiry),
        secure: !!num(row.isSecure),
        httpOnly: !!num(row.isHttpOnly),
        samesite: cols.has('sameSite') ? num(row.sameSite) : 0,
        originAttributes: cols.has('originAttributes') ? String(row.originAttributes || '') : '',
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

// Which rows are left out before anything else (2026-10-06): neither listed in the picker, nor imported, nor counted.
//  - Expired: the browser has not yet swept them from disk, and the site would refuse them anyway.
//  - Partitioned or contained: a copy a site keeps while embedded in another site (Chromium's top_frame_site_key, CHIPS)
//    or in a Firefox container (a non-empty originAttributes). The Stage keeps one unpartitioned store, so writing such a
//    copy would overwrite the real top-level sign-in of the same name, domain and path.
const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Whether a Chromium row is the plain, live cookie (see above). `now` is Unix seconds. */
function chromiumKept(row, now) {
  if (row.topFrameSiteKey) return false;
  const expires = chromeTimeToUnixSeconds(row.expiresUtc);
  return !(row.persistent && row.hasExpires && expires > 0 && expires <= now);
}

/** Whether a Firefox row is the plain, live cookie (see above). `now` is Unix seconds. */
function firefoxKept(row, now) {
  if (row.originAttributes) return false;
  return !(row.expirySeconds > 0 && row.expirySeconds <= now);
}

/**
 * Chromium rows -> cookies for cookies.set, decrypting values and dropping those that will not decrypt (counted). When
 * `want` (a Set of registrable domains) is given, only rows for those domains are considered, so the skipped count and the
 * decryption are scoped to what is being imported — a value from a domain the person did not tick is never even decrypted.
 * Expired and partitioned rows are left out uncounted (chromiumKept); `now` is Unix seconds.
 */
function normalizeChromium({ version, rows }, key, { want = null, now = nowSeconds() } = {}) {
  const cookies = [];
  let skipped = 0;
  for (const row of rows) {
    if (want && !want.has(registrableDomain(row.host))) continue;
    if (!chromiumKept(row, now)) continue;
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

/** Firefox rows -> cookies for cookies.set. Nothing to decrypt, so nothing is skipped for decryption. `want`, `now` as above. */
function normalizeFirefox({ rows }, { want = null, now = nowSeconds() } = {}) {
  const cookies = rows.filter((row) => (!want || want.has(registrableDomain(row.host))) && firefoxKept(row, now)).map((row) => ({
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

// Each site a person is likely to import, with a page that needs a sign-in: asked for over the Stage's session without
// following redirects, it answers 2xx when the session is live and redirects to a login page when it is not.
//
// The request is Electron's net.request, not net.fetch (2026-10-06, tried against Electron 44.4.1): net.fetch with
// redirect:'manual' throws "Redirect was cancelled" instead of returning the 3xx, and with redirects followed its Response
// has no url, so neither says where the page was sent. net.request's 'redirect' event gives the status and the target. A
// "Redirect was cancelled" error that comes back anyway is a redirect to somewhere unknown, and counts as signed out.
//
// GitHub has the signed-out tests the Stage itself uses (src/shared/github.cjs, src/main/browser/views.cjs): the Stage
// holds none of GITHUB_SESSION_COOKIES (nothing to be signed in with, so the page is not even asked for), or the page was
// sent to GitHub's /login (endedGithubSession). A GitHub redirect anywhere else (a device check, say) is not one GitHub
// means as signed out, so it comes back null: not confirmed either way.
const SIGN_IN_CHECKS = [
  { site: 'GitHub', domain: 'github.com', url: 'https://github.com/settings/profile', sessionCookies: GITHUB_SESSION_COOKIES, signedOut: endedGithubSession },
  { site: 'Google', domain: 'google.com', url: 'https://myaccount.google.com/' },
  { site: 'Overleaf', domain: 'overleaf.com', url: 'https://www.overleaf.com/project' },
  { site: 'Zotero', domain: 'zotero.org', url: 'https://www.zotero.org/settings/' },
];
const CHECK_BY_DOMAIN = new Map(SIGN_IN_CHECKS.map((check) => [check.domain, check]));
const DEFAULT_DOMAINS = SIGN_IN_CHECKS.map((check) => check.domain);
// A check that has not answered by then is null ("not confirmed"): the picker never waits on "Importing…" for longer.
const CHECK_TIMEOUT_MS = 10_000;
const REDIRECT_CANCELLED = /Redirect was cancelled/i;

/** Whether the check page was sent elsewhere (a 3xx, or an opaque redirect) rather than shown. */
function wasRedirect(response) {
  if (!response) return false;
  const status = Number(response.status) || 0;
  return response.type === 'opaqueredirect' || status === 0 || (status >= 300 && status < 400);
}

/** A site whose sign-in lives in known cookies (GitHub's), and the Stage holds none of them: nothing to be signed in with. */
const lacksSession = (check, held) => !!(check.sessionCookies && held && !check.sessionCookies.some((name) => held.has(name)));

/**
 * The signed-in verdict for one site: true signed in (a 2xx), false signed out, null when the check could not run or is
 * not confirmed. `response` is probe()'s { status, location }; `held` the names of the cookies the Stage holds for the
 * check page (a Set), or null when unknown.
 */
function checkResult(check, response, held = null) {
  if (lacksSession(check, held)) return false;
  if (!response) return null;
  if (wasRedirect(response)) {
    if (check.signedOut && response.location) return check.signedOut(check.url, response.location) ? false : null;
    return false;
  }
  const status = Number(response.status) || 0;
  return status >= 200 && status < 300;
}

/**
 * Ask for one check page over `session` with Electron's net.request (`request`): redirects not followed, the session's
 * cookies sent. Resolves { status, location } (`location` when the page redirected), or null when it failed or had not
 * answered in `timeoutMs`. The body is never read: the request is aborted as soon as the status or the redirect is known.
 */
function probe(request, session, url, timeoutMs = CHECK_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let req = null;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (req) req.abort(); } catch { /* already over */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      req = request({ url, session, useSessionCookies: true, redirect: 'manual', cache: 'no-store' });
      req.on('redirect', (status, _method, location) => finish({ status: Number(status) || 302, location: String(location || '') }));
      req.on('response', (response) => {
        if (response && typeof response.on === 'function') response.on('error', () => {}); // aborted under it: not ours to report
        finish({ status: response ? Number(response.statusCode) || 0 : 0 });
      });
      req.on('error', (error) => finish(REDIRECT_CANCELLED.test(String(error && error.message)) ? { status: 302, location: '' } : null));
      req.end();
    } catch {
      finish(null);
    }
  });
}

/** The names of the cookies the Stage would send to `url` (their values are dropped unread), or null if the store can't say. */
async function heldNames(store, url) {
  if (!store || typeof store.get !== 'function') return null;
  try {
    return new Set((await store.get({ url })).map((cookie) => cookie.name));
  } catch {
    return null;
  }
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
 *  - `getSession()`: the Stage's session (src/main/browser/views.cjs; its `cookies` store).
 *  - `request(options)`: Electron's net.request, for the sign-in checks (probe()). Without it every check is null.
 *  - `keychain(serviceName)`: the Keychain password for a Chromium browser, or a thrown denial or miss (CK-05).
 *  - `now()`       : the time written into the record, and what an expired cookie is expired by.
 *  - `checkTimeoutMs`: how long a sign-in check may take (CHECK_TIMEOUT_MS).
 */
function createCookieImport({ supportDir, userDataDir, tmpBase = os.tmpdir(), getSession, request = null, keychain, now = () => new Date(), checkTimeoutMs = CHECK_TIMEOUT_MS }) {
  const importsFile = path.join(userDataDir || '.', 'browser-imports.json');
  const unixNow = () => Math.floor(now().getTime() / 1000);

  /** The installed browsers and their profiles, domains and values untouched (CK-03). */
  function sources() {
    const out = [];
    for (const browser of BY_ID.values()) {
      const profiles = profilesFor(browser, supportDir);
      if (profiles.length) out.push({ id: browser.id, name: browser.name, family: browser.family, bundle: browser.bundle || null, profiles: profiles.map((p) => ({ id: p.id, name: p.name })) });
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
    const options = { want, now: unixNow() };
    if (browser.family === 'firefox') return normalizeFirefox(withCopy(profile.cookieFile, tmpBase, readFirefoxDb), options);
    return normalizeChromium(withCopy(profile.cookieFile, tmpBase, readChromiumDb), key, options);
  }

  /** The domains a profile has cookies for, with counts (CK-07). No Keychain: listing never decrypts. Expired and
   *  partitioned rows are not counted, as they will not be imported (chromiumKept, firefoxKept). */
  function domains(browserId, profileId) {
    const { browser, profile } = resolveProfile(browserId, profileId);
    const counts = new Map();
    const firefox = browser.family === 'firefox';
    const read = firefox ? withCopy(profile.cookieFile, tmpBase, readFirefoxDb) : withCopy(profile.cookieFile, tmpBase, readChromiumDb);
    const kept = firefox ? firefoxKept : chromiumKept;
    const at = unixNow();
    for (const row of read.rows) {
      if (!kept(row, at)) continue;
      const domain = registrableDomain(row.host);
      if (!domain) continue;
      counts.set(domain, (counts.get(domain) || 0) + 1);
    }
    const list = [...counts.entries()].map(([domain, count]) => ({ domain, count })).sort((a, b) => (b.count - a.count) || a.domain.localeCompare(b.domain));
    return { browser: browser.id, profile: profile.id, defaults: DEFAULT_DOMAINS, domains: list };
  }

  /**
   * The names of the live cookies a profile holds for `wanted` registrable domains → [{ domain, name }]. No Keychain and no
   * values, as domains(): enough to tell whether a site's sign-in cookie is there before anything is decrypted or written
   * (Connect your library's sign-in in the default browser, ../connect/web-signin.cjs).
   */
  function cookieNames(browserId, profileId, wanted) {
    const { browser, profile } = resolveProfile(browserId, profileId);
    const want = new Set((Array.isArray(wanted) ? wanted : []).map((d) => String(d).toLowerCase()));
    const firefox = browser.family === 'firefox';
    const read = firefox ? withCopy(profile.cookieFile, tmpBase, readFirefoxDb) : withCopy(profile.cookieFile, tmpBase, readChromiumDb);
    const kept = firefox ? firefoxKept : chromiumKept;
    const at = unixNow();
    const out = [];
    for (const row of read.rows) {
      const domain = registrableDomain(row.host);
      if (want.has(domain) && kept(row, at)) out.push({ domain, name: row.name });
    }
    return out;
  }

  /** The signed-in check for each imported domain that has one, all at once over the Stage's session, so together they
   *  take no longer than one (checkTimeoutMs). A check that fails or times out comes back null. */
  async function runChecks(session, importedDomains) {
    const checks = importedDomains.map((domain) => CHECK_BY_DOMAIN.get(domain)).filter(Boolean);
    return Promise.all(checks.map(async (check) => {
      const held = check.sessionCookies ? await heldNames(session.cookies, check.url) : null;
      const response = lacksSession(check, held) || !request ? null : await probe(request, session, check.url, checkTimeoutMs);
      return { site: check.site, domain: check.domain, url: check.url, signedIn: checkResult(check, response, held) };
    }));
  }

  /**
   * Import the ticked domains' cookies into the Stage (CK-08–CK-13). Returns counts only — { imported, skipped, sessionOnly,
   * checks } — with no cookie value anywhere in it. A Keychain denial or miss (Chromium) throws before anything is written
   * (CK-05). No domains is nothing to import (2026-10-06): no Keychain prompt, no read, no write and no record.
   */
  async function run({ browser: browserId, profile: profileId, domains: wanted, quiet = false }) {
    const { browser, profile } = resolveProfile(browserId, profileId);
    const want = new Set((Array.isArray(wanted) ? wanted : []).map((d) => String(d).toLowerCase()));
    if (!want.size) return { browser: browser.id, profile: profile.name, imported: 0, skipped: 0, sessionOnly: 0, checks: [] };

    let key = null;
    if (browser.family === 'chromium') {
      try {
        key = deriveKey(await keychain(browser.keychain));
      } catch (error) {
        const failure = keychainFailure(error);
        const thrown = new Error(failure === 'not-found'
          ? `Engelbart couldn't find ${browser.name}'s key in the Keychain, so its cookies can't be read. Nothing was imported.`
          : failure === 'denied'
            ? `Engelbart needs Keychain access to read ${browser.name}'s cookies, and the request was denied. Nothing was imported.`
            : `Engelbart could not read ${browser.name}'s Keychain key. Nothing was imported.`);
        // Which way it failed, for a caller that goes on to another browser (../connect/web-signin.cjs).
        thrown.denied = failure === 'denied';
        thrown.notFound = failure === 'not-found';
        thrown.browser = browser.name;
        throw thrown;
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
    // `quiet` (an import Connect makes itself, again until the person has signed in): no sign-in checks over the network and
    // no record; the caller checks for itself.
    if (quiet) return { browser: browser.id, profile: profile.name, imported, skipped, sessionOnly, checks: [] };
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

  return { sources, domains, cookieNames, import: run };
}

// `security` exits with the low byte of the Keychain's OSStatus (2026-10-06): 44 is errSecItemNotFound (-25300), no key of
// that name (the browser never stored one here, or its name in CHROMIUM is wrong); 128 errSecUserCanceled (-128) and 51
// errSecAuthFailed (-25293) are the person saying no at the prompt.
const KEYCHAIN_NOT_FOUND = 44;
const KEYCHAIN_DENIED = new Set([128, 51]);

/** Which way a Keychain read failed: 'not-found', 'denied' or 'other' (keychainRunner's flags, else the message). */
function keychainFailure(error) {
  if (!error) return 'other';
  if (error.notFound) return 'not-found';
  if (error.denied) return 'denied';
  const message = String(error.message || '');
  if (/could not be found|no such key/i.test(message)) return 'not-found';
  if (/denied|-128|cancel/i.test(message)) return 'denied';
  return 'other';
}

/**
 * The default Keychain runner (CK-05): `security find-generic-password -w -s "<name>"`, through `run` (execFile; a fake in
 * the tests). A missing key rejects with `notFound`, a denial with `denied`, anything else with neither.
 */
function keychainRunner(serviceName, run = execFile) {
  return new Promise((resolve, reject) => {
    run('/usr/bin/security', ['find-generic-password', '-w', '-s', serviceName], { timeout: 60000 }, (error, stdout) => {
      if (error) {
        const notFound = error.code === KEYCHAIN_NOT_FOUND;
        // No answer within the minute it waits (the prompt left on screen, execFile's timeout kills it) counts as a no.
        const timedOut = !notFound && !!error.killed;
        const denied = !notFound && (timedOut || KEYCHAIN_DENIED.has(error.code) || /denied|user (?:name|interaction)|cancel/i.test(error.message || ''));
        const failure = new Error(notFound ? 'The Keychain has no such key' : denied ? 'Keychain access was denied' : 'The Keychain key could not be read');
        failure.notFound = notFound;
        failure.denied = denied;
        failure.timedOut = timedOut;
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
  bundleOf,
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
  probe,
  CHECK_TIMEOUT_MS,
  FIREFOX_EXPIRY_MS_SCHEMA,
  recordImport,
  createCookieImport,
  keychainRunner,
  loadSqlite,
};
