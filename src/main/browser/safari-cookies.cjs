'use strict';

// Safari's sign-ins (2026-10-16, the Onboarding note: "@bart is there a way for us to import safari cookies? have apps done
// this before?" — yt-dlp and browser_cookie3 read Safari's Cookies.binarycookies, with no Keychain key). A parser of our own,
// no dependency: modelled on yt-dlp's yt_dlp/cookies.py (_parse_safari_cookies and its DataParser) and browser_cookie3's
// Safari class, both read 2026-10-16. The file:
//   'cook', then the page count and each page's size, big-endian (u32);
//   each page: 00 00 01 00, its cookie count and each record's offset in the page, little-endian (u32);
//   each record, little-endian: its size, 4 unknown bytes, flags (0x1 secure, 0x4 HttpOnly), 4 unknown bytes, the offsets
//   (from the record's start) of its domain, name, path, value and comment, 4 zero bytes, then the expiry and the creation
//   time as doubles in Mac absolute time (seconds since 2001-01-01 UTC), then the NUL-terminated strings.
// Safari keeps no SameSite on disk here, so every cookie is written as 'unspecified' (Chromium's own default applies).
//
// Where it is (2026-10-16): the Safari container on current macOS (~/Library/Containers/com.apple.Safari/Data/Library/
// Cookies/), the old ~/Library/Cookies/ as the fallback (browser_cookie3's order; yt-dlp tries the old one first). Safari 17+
// profiles keep their own file at ~/Library/Containers/com.apple.Safari/Data/Library/WebKit/WebsiteDataStore/<profile
// UUID>/Cookies/Cookies.binarycookies (robbieg8s/safari-cookie-json's README; Apple says only that each profile keeps its own
// cookies). A profile's name is looked for in Safari's SafariTabs.db (a `bookmarks` row whose external_uuid is the profile's
// UUID): NOT verified against a real Safari here (the container is guarded, and reading it without Full Disk Access may ask),
// so a name that can't be read is "Profile 1", "Profile 2"… in folder order.
//
// All of it is guarded by Full Disk Access: without it, reading fails with EPERM, which comes back as `needsDiskAccess`
// (./import-cookies.cjs turns it into { needs: 'disk-access' }), never a crash or an empty copy. The caller asks whether
// Full Disk Access is granted before touching the container at all, so nothing here can bring up a macOS prompt.

const fs = require('node:fs');
const path = require('node:path');

const MAC_EPOCH_UNIX = 978307200; // 2001-01-01T00:00:00Z
const FILE_SIGNATURE = Buffer.from('cook');
const PAGE_SIGNATURE = Buffer.from([0, 0, 1, 0]);
const FLAG_SECURE = 0x1;
const FLAG_HTTP_ONLY = 0x4;
const RECORD_HEADER = 56;

/** Mac absolute time (seconds since 2001) → Unix seconds; 0 or nonsense → 0. */
function macTimeToUnix(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value + MAC_EPOCH_UNIX);
}

/** The NUL-terminated UTF-8 string at `at` in `buffer`, not past `end` → string, or null when it runs off or isn't UTF-8. */
function cString(buffer, at, end) {
  if (at < 0 || at >= end) return null;
  const stop = buffer.indexOf(0, at);
  if (stop < 0 || stop >= end) return null;
  const bytes = buffer.subarray(at, stop);
  const text = bytes.toString('utf8');
  return Buffer.from(text, 'utf8').equals(bytes) ? text : null;
}

/** One record at `start` in `page` → a cookie, or null when it doesn't parse (counted as skipped). */
function parseRecord(page, start) {
  if (start < 0 || start + RECORD_HEADER > page.length) return null;
  const size = page.readUInt32LE(start);
  if (size < RECORD_HEADER || start + size > page.length) return null;
  const end = start + size;
  const flags = page.readUInt32LE(start + 8);
  const [domainAt, nameAt, pathAt, valueAt] = [16, 20, 24, 28].map((field) => page.readUInt32LE(start + field));
  const strings = [domainAt, nameAt, pathAt, valueAt].map((offset) => cString(page, start + offset, end));
  if (strings.some((value) => value == null)) return null;
  const [host, name, cookiePath, value] = strings;
  if (!host || !name) return null;
  return {
    host,
    name,
    value,
    path: cookiePath || '/',
    expires: macTimeToUnix(page.readDoubleLE(start + 40)),
    created: macTimeToUnix(page.readDoubleLE(start + 48)),
    secure: !!(flags & FLAG_SECURE),
    httpOnly: !!(flags & FLAG_HTTP_ONLY),
  };
}

/**
 * A whole Cookies.binarycookies file → { cookies: [{ host, name, value, path, expires, created, secure, httpOnly }],
 * skipped }. Not Safari's file at all (no 'cook', a page table that runs off): thrown. A record that doesn't parse is
 * skipped and counted, as an undecryptable Chromium value is.
 */
function parseBinaryCookies(data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
  if (buffer.length < 8 || !buffer.subarray(0, 4).equals(FILE_SIGNATURE)) throw new Error('Not a Safari cookie file');
  const pages = buffer.readUInt32BE(4);
  const tableEnd = 8 + pages * 4;
  if (tableEnd > buffer.length) throw new Error('Safari\'s cookie file is cut short');
  const cookies = [];
  let skipped = 0;
  let at = tableEnd;
  for (let index = 0; index < pages; index += 1) {
    const size = buffer.readUInt32BE(8 + index * 4);
    if (at + size > buffer.length) throw new Error('Safari\'s cookie file is cut short');
    const page = buffer.subarray(at, at + size);
    at += size;
    if (page.length < 8 || !page.subarray(0, 4).equals(PAGE_SIGNATURE)) { skipped += 1; continue; }
    const count = page.readUInt32LE(4);
    if (8 + count * 4 > page.length) { skipped += count; continue; }
    for (let record = 0; record < count; record += 1) {
      const cookie = parseRecord(page, page.readUInt32LE(8 + record * 4));
      if (cookie) cookies.push(cookie); else skipped += 1;
    }
  }
  return { cookies, skipped };
}

/* ------------------------------------------------------------------------------------------------ where they are */

const container = (homeDir) => path.join(homeDir, 'Library', 'Containers', 'com.apple.Safari', 'Data', 'Library');
const CONTAINER_FILE = (homeDir) => path.join(container(homeDir), 'Cookies', 'Cookies.binarycookies');
const OLD_FILE = (homeDir) => path.join(homeDir, 'Library', 'Cookies', 'Cookies.binarycookies');
const PROFILES_DIR = (homeDir) => path.join(container(homeDir), 'WebKit', 'WebsiteDataStore');
const TABS_DB = (homeDir) => path.join(container(homeDir), 'Safari', 'SafariTabs.db');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An error that means macOS kept the file from us (no Full Disk Access): EPERM, or EACCES on a guarded folder. */
const guarded = (error) => !!(error && (error.code === 'EPERM' || error.code === 'EACCES'));

const isFile = (file) => { try { return fs.statSync(file).isFile(); } catch (error) { if (guarded(error)) throw error; return false; } };

/** The default profile's cookie file: the container's, else the old one; '' when neither is there. Guarded: thrown. */
function defaultCookieFile(homeDir) {
  if (isFile(CONTAINER_FILE(homeDir))) return CONTAINER_FILE(homeDir);
  if (isFile(OLD_FILE(homeDir))) return OLD_FILE(homeDir);
  return '';
}

/**
 * Profile names from SafariTabs.db (UUID → name), read through `openDb` (a read-only node:sqlite opener, ./import-cookies.cjs).
 * Unverified schema (see above): anything that doesn't read gives an empty map.
 */
function profileNames(homeDir, openDb) {
  const names = new Map();
  if (typeof openDb !== 'function') return names;
  let db = null;
  try {
    db = openDb(TABS_DB(homeDir));
    for (const row of db.prepare("SELECT external_uuid AS uuid, title FROM bookmarks WHERE external_uuid IS NOT NULL AND title IS NOT NULL AND title != ''").all()) {
      if (UUID.test(String(row.uuid))) names.set(String(row.uuid).toUpperCase(), String(row.title));
    }
  } catch { /* not this schema, or not readable */ } finally {
    try { if (db) db.close(); } catch { /* closed */ }
  }
  return names;
}

/**
 * Safari's profiles → [{ id, name, cookieFile }]: 'Default' (the container's file, else the old one), then each Safari 17+
 * profile folder holding a cookie file, by its UUID. Only called with Full Disk Access; a guarded read is thrown
 * (`needsDiskAccess`). `openDb` reads SafariTabs.db for the names.
 */
function safariProfiles(homeDir, { openDb = null } = {}) {
  try {
    const out = [];
    const main = defaultCookieFile(homeDir);
    let dirs = [];
    try { dirs = fs.readdirSync(PROFILES_DIR(homeDir)).filter((dir) => UUID.test(dir)).sort(); } catch (error) { if (guarded(error)) throw error; dirs = []; }
    const extra = dirs.map((dir) => ({ dir, file: path.join(PROFILES_DIR(homeDir), dir, 'Cookies', 'Cookies.binarycookies') })).filter((entry) => isFile(entry.file));
    const names = extra.length ? profileNames(homeDir, openDb) : new Map();
    // With profiles, Safari calls the first one "Personal" (unverified, as the names are).
    if (main) out.push({ id: 'Default', name: extra.length ? 'Personal' : 'Safari', cookieFile: main });
    extra.forEach((entry, index) => out.push({ id: entry.dir, name: names.get(entry.dir.toUpperCase()) || `Profile ${index + 1}`, cookieFile: entry.file }));
    return out;
  } catch (error) {
    if (guarded(error)) throw Object.assign(new Error('Engelbart needs Full Disk Access to read Safari\'s sign-ins.'), { needsDiskAccess: true });
    throw error;
  }
}

/** A Safari cookie file read and parsed; a guarded read thrown as `needsDiskAccess`. */
function readSafariFile(file) {
  let data;
  try { data = fs.readFileSync(file); } catch (error) {
    if (guarded(error)) throw Object.assign(new Error('Engelbart needs Full Disk Access to read Safari\'s sign-ins.'), { needsDiskAccess: true });
    throw error;
  }
  return parseBinaryCookies(data);
}

/** Whether a parsed Safari cookie is live (`now` Unix seconds): one with no expiry on disk counts as live. */
const safariKept = (cookie, now) => !(cookie.expires > 0 && cookie.expires <= now);

module.exports = { parseBinaryCookies, macTimeToUnix, safariProfiles, readSafariFile, safariKept, defaultCookieFile, CONTAINER_FILE, OLD_FILE, PROFILES_DIR, TABS_DB, MAC_EPOCH_UNIX, FLAG_SECURE, FLAG_HTTP_ONLY };
