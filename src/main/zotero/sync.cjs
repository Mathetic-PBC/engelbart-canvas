'use strict';

// The connected Zotero library, mirrored on disk (MATH-65 build 2) so Bart can read it and the @ menu can list it. One
// account's user library goes to <dataRoot>/.zotero/ (./mirror.cjs mirrorDir) through the Web API (Zotero-API-Version: 3), with the key from
// ./connection.cjs key(), sent only as a header to api.zotero.org:
//   state.json        { v, userID, version, syncedAt, items }: the library version the mirror is at (never the key)
//   raw.json          the API's own `data` of every collection and item kept, and each top-level item's BibTeX as Zotero
//                     exported it: what an incremental sync applies its changes to
//   collections.json  [{ key, name, parent, path }]
//   items.json        the top-level items: title, creators, year, publication, DOI, URL, abstract, tags, collections, the
//                     citation key, and their attachments (./mirror.cjs reads these)
//   library.bib       every item's BibTeX, one after another
//   items/<key>/      item.bib (its BibTeX under its citation key), children.json (its notes and annotations, as text),
//                     fulltext-<attachmentKey>.txt (what Zotero indexed of each attachment)
//   files/<key>/      attachments downloaded when mentioned or opened (./mirror.cjs resolveAttachment), never up front
// The first sync asks for everything; each later one only for what changed since the version kept (?since=), and for
// what was deleted (/deleted?since=). Items in the trash (deleted: 1) are left out, and taken out when they go there.
// Pages of 100 (limit=100&start=). A Backoff header holds every request after it for that many seconds; a 429 or 503
// waits its Retry-After and tries again. A citation key is Better BibTeX's when the item has one (its citationKey field,
// or a "Citation Key:" line in Extra), else made from the first author, the year and the first word of the title, and
// the same for as long as the item is (keys are given out in the order items were added). Signing out deletes the
// mirror (clear). Nothing here logs; an error says what went wrong in words, never with the key.

const fs = require('node:fs');
const path = require('node:path');
const { API } = require('./connection.cjs');

const PAGE = 100;
const KEY_BATCH = 50; // itemKey= takes at most 50 keys
const TIMEOUT_MS = 60_000;
const MAX_TRIES = 5;
const MAX_WAIT_MS = 10 * 60_000;
const VERSION = 1;
const KEY_RE = /^[A-Za-z0-9]{1,32}$/;

class ZoteroSyncError extends Error {
  constructor(message, code = 'zotero-sync') { super(message); this.code = code; }
}

/* --------------------------------------------------------------------------------------------------- small helpers */

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

/** `text` into `file` through a temporary file, so a reader never sees half of it; nothing when it already holds that. */
function writeFile(file, text) {
  try { if (fs.readFileSync(file, 'utf8') === text) return; } catch { /* not there yet */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text);
  fs.renameSync(temporary, file);
}
const writeJson = (file, value) => writeFile(file, `${JSON.stringify(value, null, 1)}\n`);

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** A Zotero note's HTML as plain text: paragraphs and line breaks kept, tags dropped, entities read. */
function noteText(html) {
  return String(html || '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|h[1-6]|li|blockquote|pre|tr)\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '- ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, code) => {
      if (code[0] === '#') { const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1)); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : all; }
      return ENTITIES[code.toLowerCase()] ?? all;
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ------------------------------------------------------------------------------------------------ citation keys */

/** Better BibTeX's key for an item, when it has one: the citationKey field, else a "Citation Key:" line in Extra. */
function betterBibtexKey(data) {
  const field = typeof data.citationKey === 'string' ? data.citationKey.trim() : '';
  if (field && !/\s/.test(field)) return field;
  const line = /^\s*citation key\s*:\s*(\S+)\s*$/im.exec(String(data.extra || ''));
  return line ? line[1] : '';
}

const FUNCTION_WORDS = new Set(['a', 'an', 'the', 'on', 'of', 'in', 'for', 'to', 'and', 'or', 'with', 'at', 'by', 'from', 'is', 'are']);
const plain = (text) => String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const yearOf = (data) => { const m = /\b(\d{4})\b/.exec(String(data.date || '')); return m ? m[1] : ''; };
const firstAuthor = (data) => {
  const creators = Array.isArray(data.creators) ? data.creators : [];
  return creators.find((c) => c && c.creatorType === 'author') || creators[0] || null;
};

/** The key made for an item without Better BibTeX's: first author's last name, year, first word of the title (lowercase). */
function madeKey(data) {
  const who = firstAuthor(data);
  const last = who ? (who.lastName || String(who.name || '').trim().split(/\s+/).pop() || '') : '';
  const words = String(data.title || '').split(/[\s\-–—:;,.!?/()[\]"'“”‘’]+/).map(plain).filter(Boolean);
  const word = words.find((w) => !FUNCTION_WORDS.has(w)) || words[0] || '';
  return `${plain(last) || 'anon'}${yearOf(data) || 'nd'}${word}`;
}

/**
 * Each top-level item's citation key → Map(key → citeKey). Better BibTeX's are kept as they are; made ones that clash
 * get a, b, c… in the order the items were added (then by key), so an item added later never changes an earlier one's.
 */
function citeKeys(items) {
  const out = new Map(), taken = new Set();
  for (const data of items) { const bbt = betterBibtexKey(data); if (bbt) { out.set(data.key, bbt); taken.add(bbt); } }
  const rest = items.filter((data) => !out.has(data.key))
    .sort((a, b) => String(a.dateAdded || '').localeCompare(String(b.dateAdded || '')) || String(a.key).localeCompare(String(b.key)));
  for (const data of rest) {
    const base = madeKey(data);
    let key = base;
    for (let n = 0; taken.has(key); n++) key = base + suffix(n);
    taken.add(key); out.set(data.key, key);
  }
  return out;
}
const suffix = (n) => { let s = ''; n += 1; while (n > 0) { n -= 1; s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26); } return s; };

/** An entry Zotero exported, under `citeKey` in place of the key Zotero gave it. */
const rekeyed = (bib, citeKey) => String(bib || '').trim().replace(/^(\s*@\w+\s*\{)[^,\s]*,/, `$1${citeKey},`);

/* ---------------------------------------------------------------------------------------------- the mirror's views */

const PUBLICATION_FIELDS = ['publicationTitle', 'proceedingsTitle', 'bookTitle', 'conferenceName', 'websiteTitle', 'blogTitle', 'forumTitle', 'programTitle', 'university', 'institution', 'publisher', 'repository'];
const SKIP_TOP = new Set(['note', 'annotation']);
const isTop = (data) => !!data && !data.parentItem && !SKIP_TOP.has(data.itemType);

function creatorOf(c) {
  const name = c.name ? String(c.name) : [c.firstName, c.lastName].filter(Boolean).join(' ');
  return { type: c.creatorType || 'author', name: name.trim(), ...(c.lastName ? { last: c.lastName } : {}) };
}
function doiOf(data) {
  if (data.DOI) return String(data.DOI).trim();
  const line = /^\s*doi\s*:\s*(\S+)\s*$/im.exec(String(data.extra || ''));
  return line ? line[1] : '';
}
function attachmentOf(data) {
  return {
    key: data.key,
    title: data.title || '',
    contentType: data.contentType || '',
    filename: data.filename || '',
    linkMode: data.linkMode || '',
    ...(data.linkMode === 'linked_file' && data.path ? { path: data.path } : {}),
    ...(data.url ? { url: data.url } : {}),
  };
}
function annotationOf(data, attachment) {
  return {
    key: data.key,
    type: data.annotationType || 'highlight',
    text: String(data.annotationText || ''),
    comment: String(data.annotationComment || ''),
    page: String(data.annotationPageLabel || ''),
    ...(data.annotationColor ? { color: data.annotationColor } : {}),
    attachment,
  };
}

/** collections.json from the raw collections: each with the path of names down to it. */
function collectionsView(raw) {
  const all = raw.collections;
  const pathOf = (key, guard = new Set()) => {
    const c = all[key]; if (!c || guard.has(key)) return [];
    guard.add(key);
    return [...(c.parentCollection ? pathOf(c.parentCollection, guard) : []), c.name || 'Untitled'];
  };
  return Object.values(all).map((c) => ({ key: c.key, name: c.name || 'Untitled', parent: c.parentCollection || null, path: pathOf(c.key).join(' / ') }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** The children of each top-level item: { [topKey]: { attachments, notes, annotations } }. */
function childrenView(raw) {
  const out = {};
  const of = (key) => (out[key] = out[key] || { attachments: [], notes: [], annotations: [] });
  const items = raw.items;
  for (const data of Object.values(items)) {
    if (data.itemType === 'attachment') {
      const top = data.parentItem || data.key; // a standalone attachment is its own item
      if (isTop(items[top])) of(top).attachments.push(attachmentOf(data));
    } else if (data.itemType === 'note' && data.parentItem && isTop(items[data.parentItem])) {
      of(data.parentItem).notes.push({ key: data.key, text: noteText(data.note) });
    }
  }
  for (const data of Object.values(items)) {
    if (data.itemType !== 'annotation' || !data.parentItem) continue;
    const attachment = items[data.parentItem];
    const top = attachment && (attachment.parentItem || attachment.key);
    if (top && isTop(items[top])) of(top).annotations.push(annotationOf(data, attachment.key));
  }
  for (const kids of Object.values(out)) {
    kids.attachments.sort((a, b) => a.key.localeCompare(b.key));
    kids.notes.sort((a, b) => a.key.localeCompare(b.key));
    kids.annotations.sort((a, b) => (Number(a.page) || 0) - (Number(b.page) || 0) || a.key.localeCompare(b.key));
  }
  return out;
}

/** items.json's entry for a top-level item. */
function itemView(data, citeKey, kids) {
  return {
    key: data.key,
    citeKey,
    itemType: data.itemType,
    title: data.title || data.filename || 'Untitled',
    creators: (Array.isArray(data.creators) ? data.creators : []).map(creatorOf),
    year: yearOf(data),
    date: data.date || '',
    publication: PUBLICATION_FIELDS.map((field) => data[field]).find(Boolean) || '',
    doi: doiOf(data),
    url: data.url || '',
    abstractNote: data.abstractNote || '',
    tags: (Array.isArray(data.tags) ? data.tags : []).map((t) => t && t.tag).filter(Boolean),
    collections: Array.isArray(data.collections) ? data.collections : [],
    attachments: kids.attachments,
    notes: kids.notes.length,
    annotations: kids.annotations.length,
    dateAdded: data.dateAdded || '',
    dateModified: data.dateModified || '',
  };
}

/**
 * The mirror's files from raw.json (`raw`): collections.json, items.json, library.bib, and each item's folder. A folder
 * whose item is gone goes, and so does the text of an attachment the item no longer has. `fulltext` { [attachmentKey]:
 * text }: what this sync fetched. → the number of items
 */
function writeViews(root, raw, fulltext = {}) {
  const tops = Object.values(raw.items).filter(isTop);
  const keys = citeKeys(tops);
  const kids = childrenView(raw);
  const none = { attachments: [], notes: [], annotations: [] };
  const items = tops.map((data) => itemView(data, keys.get(data.key), kids[data.key] || none))
    .sort((a, b) => a.title.localeCompare(b.title) || a.key.localeCompare(b.key));
  const dir = path.join(root, 'items');
  fs.mkdirSync(dir, { recursive: true });
  const bibs = [];
  for (const item of items) {
    const at = path.join(dir, item.key);
    const bib = raw.bib[item.key] ? `${rekeyed(raw.bib[item.key], item.citeKey)}\n` : '';
    if (bib) { writeFile(path.join(at, 'item.bib'), bib); bibs.push(bib); } else fs.rmSync(path.join(at, 'item.bib'), { force: true });
    const { notes, annotations } = kids[item.key] || none;
    writeJson(path.join(at, 'children.json'), { notes, annotations });
    const own = new Set(item.attachments.map((a) => `fulltext-${a.key}.txt`));
    for (const a of item.attachments) if (typeof fulltext[a.key] === 'string') writeFile(path.join(at, `fulltext-${a.key}.txt`), fulltext[a.key]);
    for (const name of fs.readdirSync(at)) if (/^fulltext-.+\.txt$/.test(name) && !own.has(name)) fs.rmSync(path.join(at, name), { force: true });
  }
  const kept = new Set(items.map((item) => item.key));
  for (const name of fs.readdirSync(dir)) if (!kept.has(name)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  writeJson(path.join(root, 'collections.json'), collectionsView(raw));
  writeJson(path.join(root, 'items.json'), items);
  writeFile(path.join(root, 'library.bib'), bibs.join('\n'));
  return items.length;
}

/* ------------------------------------------------------------------------------------------------------- the sync */

const defaultSleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal && signal.aborted) { reject(new ZoteroSyncError('Stopped', 'aborted')); return; }
  const timer = setTimeout(() => { if (signal) signal.removeEventListener('abort', stop); resolve(); }, ms);
  const stop = () => { clearTimeout(timer); reject(new ZoteroSyncError('Stopped', 'aborted')); };
  if (signal) signal.addEventListener('abort', stop, { once: true });
});

/**
 * `root()`: the mirror's folder (<dataRoot>/.zotero), followed as the data root changes. `account()`: { userID, key } of
 * whoever is signed in, or null (connection.cjs status().userID and key()). `sleep(ms, signal)`: how waits are made
 * (the tests' records them). `onChange(status)`: after each change of status(). `storageDir`: Zotero's storage folder on
 * this Mac, when not ~/Zotero/storage (./mirror.cjs). → { sync, status, clear, download, root, storageDir }
 */
function createZoteroSync({ fetch = globalThis.fetch, api = API, root, account, sleep = defaultSleep, onChange = () => {}, now = () => Date.now(), storageDir = undefined } = {}) {
  let running = null; // the sync under way
  let again = false; // asked for while one ran: one more after it
  let generation = 0; // a clear() stops whatever ran before it from writing
  let controller = null;
  let notBefore = 0; // a Backoff header holds every request until then
  let state = { state: 'idle', error: '' };

  const rootNow = () => (typeof root === 'function' ? root() : root);
  const changed = () => { try { onChange(status()); } catch { /* a listener never breaks a sync */ } };

  /** { state: 'idle' | 'syncing' | 'synced' | 'error', items, syncedAt, error }: what the Zotero row says. */
  function status() {
    const at = rootNow();
    const kept = at ? readJson(path.join(at, 'state.json')) : null;
    const items = kept && Number.isFinite(kept.items) ? kept.items : 0;
    const syncedAt = kept ? kept.syncedAt || '' : '';
    const shown = state.state === 'idle' && kept ? 'synced' : state.state;
    return { state: shown, items, syncedAt, error: state.error || '' };
  }

  /* ---------------------------------------------------------------- requests */

  // One request to the library (`route` from /users/<id>), JSON unless `as` says otherwise. Waits out a Backoff, and a
  // 429 or 503's Retry-After (else a little longer each time) before trying again.
  async function request(route, params = {}, { signal, as = 'json', redirect = 'error' } = {}) {
    const who = account();
    if (!who || !who.key || !who.userID) throw new ZoteroSyncError('Zotero is not connected.', 'signed-out');
    const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)])).toString();
    const url = `${api}/users/${encodeURIComponent(who.userID)}${route}${query ? `?${query}` : ''}`;
    for (let tries = 1; ; tries++) {
      const wait = notBefore - now();
      if (wait > 0) await sleep(Math.min(wait, MAX_WAIT_MS), signal);
      let response;
      try {
        response = await fetch(url, {
          headers: { 'zotero-api-key': who.key, 'zotero-api-version': '3', accept: as === 'json' ? 'application/json' : '*/*' },
          redirect, credentials: 'omit', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        if (signal && signal.aborted) throw new ZoteroSyncError('Stopped', 'aborted');
        if (tries < MAX_TRIES) { await sleep(1000 * tries, signal); continue; }
        throw new ZoteroSyncError('Could not reach Zotero. Check your connection and try again.', 'network');
      }
      const backoff = Number(response.headers.get('backoff'));
      if (Number.isFinite(backoff) && backoff > 0) notBefore = Math.max(notBefore, now() + backoff * 1000);
      if (response.status === 429 || response.status === 503 || (response.status >= 500 && response.status !== 501)) {
        if (tries >= MAX_TRIES) throw new ZoteroSyncError(response.status === 429 ? 'Zotero asked to slow down. Try again in a few minutes.' : 'Zotero is not answering right now. Try again later.', 'busy');
        const after = Number(response.headers.get('retry-after'));
        await sleep(Math.min(Number.isFinite(after) && after >= 0 ? after * 1000 : 1000 * 2 ** (tries - 1), MAX_WAIT_MS), signal);
        continue;
      }
      if (response.status === 403) throw new ZoteroSyncError('Zotero refused the key. Disconnect and connect Zotero again.', 'forbidden');
      return response;
    }
  }

  async function json(route, params, options) {
    const response = await request(route, params, options);
    if (!response.ok) throw new ZoteroSyncError(`Zotero answered ${response.status} for ${route.split('?')[0]}.`, 'http');
    return { body: await response.json(), version: Number(response.headers.get('last-modified-version')) || 0, total: Number(response.headers.get('total-results')) };
  }

  /** Every page of a list (limit=100&start=…) → { list, version }, `version` the library's at the first page. */
  async function paged(route, params, options) {
    const list = [];
    let version = 0;
    for (let start = 0; ;) {
      const page = await json(route, { ...params, limit: PAGE, start }, options);
      if (!version) version = page.version;
      const got = Array.isArray(page.body) ? page.body : [];
      list.push(...got);
      start += got.length;
      if (got.length < PAGE || (Number.isFinite(page.total) && start >= page.total)) break;
    }
    return { list, version };
  }

  /* -------------------------------------------------------------------- sync */

  /** Brings the mirror up to the library. One at a time: asked again while one runs, one more runs after it. → status() */
  function sync() {
    if (running) { again = true; return running; }
    running = (async () => {
      try {
        do { again = false; await once(); } while (again);
      } finally { running = null; }
      return status();
    })();
    return running;
  }

  async function once() {
    const run = generation;
    controller = new AbortController();
    const { signal } = controller;
    state = { state: 'syncing', error: '' }; changed();
    try {
      await pull(run, signal);
      if (run !== generation) return;
      state = { state: 'idle', error: '' };
    } catch (error) {
      if (run !== generation) return;
      state = { state: 'error', error: error instanceof ZoteroSyncError ? error.message : 'The Zotero library could not be synced.' };
    } finally {
      if (run === generation) changed();
    }
  }

  async function pull(run, signal) {
    const who = account();
    if (!who) throw new ZoteroSyncError('Zotero is not connected.', 'signed-out');
    const at = rootNow();
    if (!at) throw new ZoteroSyncError('There is no data folder to keep the library in.', 'no-root');
    const kept = readJson(path.join(at, 'state.json'));
    let raw = kept && kept.v === VERSION && kept.userID === String(who.userID) ? readJson(path.join(at, 'raw.json')) : null;
    let since = 0;
    if (raw && raw.items && raw.collections) since = Number(kept.version) || 0;
    else {
      fs.rmSync(at, { recursive: true, force: true }); // none yet, another account's, or one from an older layout: from the start
      raw = { collections: {}, items: {}, bib: {} };
    }
    raw.bib = raw.bib || {};

    const collections = await paged('/collections', { since, format: 'json' }, { signal });
    const items = await paged('/items', { since, format: 'json', includeTrashed: 1 }, { signal });
    const version = collections.version || items.version;
    const deleted = since ? (await json('/deleted', { since }, { signal })).body || {} : {};
    const texts = (await json('/fulltext', { since }, { signal })).body || {};

    for (const entry of collections.list) {
      const data = entry && entry.data; if (!data || !data.key) continue;
      if (data.deleted) delete raw.collections[data.key];
      else raw.collections[data.key] = { key: data.key, name: data.name || '', parentCollection: data.parentCollection || null };
    }
    const fresh = [];
    for (const entry of items.list) {
      const data = entry && entry.data; if (!data || !data.key) continue;
      if (data.deleted) { delete raw.items[data.key]; delete raw.bib[data.key]; continue; }
      raw.items[data.key] = data;
      if (isTop(data)) fresh.push(data.key);
    }
    for (const key of deleted.collections || []) delete raw.collections[key];
    for (const key of deleted.items || []) { delete raw.items[key]; delete raw.bib[key]; }

    // BibTeX for what is new or changed, in batches (include=bibtex gives each item's own entry, by key).
    for (let i = 0; i < fresh.length; i += KEY_BATCH) {
      const batch = fresh.slice(i, i + KEY_BATCH);
      const answer = await json('/items', { itemKey: batch.join(','), format: 'json', include: 'bibtex' }, { signal });
      for (const entry of Array.isArray(answer.body) ? answer.body : []) {
        if (entry && entry.key && typeof entry.bibtex === 'string' && entry.bibtex.trim()) raw.bib[entry.key] = entry.bibtex;
      }
    }

    // What Zotero indexed of the attachments whose text changed, each by itself.
    const fulltext = {};
    for (const key of Object.keys(texts)) {
      if (!KEY_RE.test(key) || !raw.items[key]) continue;
      const response = await request(`/items/${key}/fulltext`, {}, { signal });
      if (response.status === 404) continue;
      if (!response.ok) throw new ZoteroSyncError(`Zotero answered ${response.status} for an attachment's text.`, 'http');
      const body = await response.json();
      if (body && typeof body.content === 'string') fulltext[key] = body.content;
    }

    if (run !== generation) return;
    fs.mkdirSync(at, { recursive: true });
    writeJson(path.join(at, 'raw.json'), raw);
    const count = writeViews(at, raw, fulltext);
    writeJson(path.join(at, 'state.json'), { v: VERSION, userID: String(who.userID), version: version || Number(kept && kept.version) || 0, syncedAt: new Date(now()).toISOString(), items: count });
  }

  /* -------------------------------------------------------------- attachments */

  /**
   * An attachment's file from Zotero's storage (/items/<key>/file) → its path under files/<key>/. The redirect to where
   * the file is kept is followed here, without the key. Throws when there is none to download.
   */
  async function download(attachmentKey, filename) {
    if (!KEY_RE.test(String(attachmentKey))) throw new ZoteroSyncError('That is not a Zotero attachment.', 'key');
    const at = rootNow(); if (!at) throw new ZoteroSyncError('There is no data folder to keep the file in.', 'no-root');
    const name = path.basename(String(filename || '')).replace(/[\0/\\]/g, '') || `${attachmentKey}.pdf`;
    const target = path.join(at, 'files', attachmentKey, name);
    if (fs.existsSync(target)) return target;
    let response = await request(`/items/${attachmentKey}/file`, {}, { as: 'file', redirect: 'manual' });
    for (let hops = 0; response.status >= 300 && response.status < 400 && hops < 5; hops++) {
      const location = response.headers.get('location');
      if (!location) break;
      const next = new URL(location, `${api}/`);
      if (!/^https?:$/.test(next.protocol)) break;
      // Where the file is kept: never sent the key.
      response = await fetch(next.href, { redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(TIMEOUT_MS * 5) });
    }
    if (response.status === 404) throw new ZoteroSyncError('Zotero has no copy of this file. Open it in Zotero on the computer that holds it.', 'no-file');
    if (!response.ok) throw new ZoteroSyncError(`Zotero answered ${response.status} for the file.`, 'http');
    const bytes = Buffer.from(await response.arrayBuffer());
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, bytes);
    fs.renameSync(temporary, target);
    return target;
  }

  /* ------------------------------------------------------------------- clear */

  /** Stops a sync under way and deletes the mirror (signing out). */
  function clear() {
    generation += 1;
    if (controller) controller.abort();
    again = false;
    state = { state: 'idle', error: '' };
    const at = rootNow();
    if (at) { try { fs.rmSync(at, { recursive: true, force: true }); } catch { /* already gone */ } }
    changed();
  }

  return { sync, status, clear, download, root: rootNow, storageDir };
}

module.exports = { createZoteroSync, ZoteroSyncError, writeViews, citeKeys, betterBibtexKey, madeKey, rekeyed, noteText, PAGE };
