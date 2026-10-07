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
// Build 3: while the app is open the library is synced every 10 minutes, and when a window comes back to the front if
// the last sync was over 2 minutes ago (scheduleSyncs; never two at once, autoSync). A later sync's first request sends
// If-Modified-Since-Version, so an unchanged library costs one 304. An item with no pdf of its own may have a free copy
// found for it (./oa.cjs, `openAccess`), when it is mentioned or opened, never here in a sync.
// Build 4: an item whose chip opened its page in the default browser has its pdf waited for in the Downloads folder
// (./downloads.cjs, `awaitDownload`), and a pdf dropped on its chip is made its pdf (`attach`). Each is copied into
// files/<itemKey>/ as a found copy is (./oa.cjs saveCopy); the person's own file is only ever read.
// Build 5: group libraries. Each sync asks which groups the person is in (/users/<id>/groups), then mirrors each as My
// Library is, in groups/<groupID>/ with the same files (its state.json also names the group), from /groups/<id>/…: only
// what changed, If-Modified-Since-Version, the same clock. One after another, My Library first. A group that fails is
// said (status().problems) and the others still sync; a group no longer listed, or that answers 403 or 404 (left, or
// access lost), has its mirror deleted. When the list itself cannot be had, the groups' mirrors are left as they are.
// An item of a group is `g<groupID>:<key>` wherever a ref is taken (./mirror.cjs parseRef): its chip's free copy,
// download wait and dropped pdf go to its group's folder. Nothing is ever written back to Zotero: every request is a GET.

const fs = require('node:fs');
const path = require('node:path');
const { API } = require('./connection.cjs');
const { createOpenAccess, saveCopy, readPdfFile, OPENALEX, SEMANTIC_SCHOLAR, ARXIV_API, ARXIV } = require('./oa.cjs');
const { createDownloadWatch, paperLike, WAIT_MS, POLL_MS } = require('./downloads.cjs');
const { itemOf, parseRef, refOf, libraryRoot, groupDir, groupIds, libraryName, GROUP_RE } = require('./mirror.cjs');

const PAGE = 100;
const KEY_BATCH = 50; // itemKey= takes at most 50 keys
const TIMEOUT_MS = 60_000;
const MAX_TRIES = 5;
const MAX_WAIT_MS = 10 * 60_000;
const VERSION = 1;
const KEY_RE = /^[A-Za-z0-9]{1,32}$/;
const EVERY_MS = 10 * 60_000; // a sync this often while the app is open
const STALE_MS = 2 * 60_000; // a window brought to the front syncs when the last sync is older than this

class ZoteroSyncError extends Error {
  constructor(message, code = 'zotero-sync', status = 0) { super(message); this.code = code; this.status = status; }
}
// A failure of My Library that ends the whole sync: the groups would fail the same way (or be asked too much).
const ENDS_ALL = new Set(['signed-out', 'no-root', 'forbidden', 'busy', 'network', 'aborted']);
// A group's that ends the rest: Zotero asked to slow down, or there is no data folder.
const ENDS_GROUPS = new Set(['signed-out', 'no-root', 'busy', 'aborted']);
// A group's answer that means it is no longer the person's: its mirror goes.
const lostGroup = (error) => error instanceof ZoteroSyncError && (error.code === 'forbidden' || (error.code === 'http' && error.status === 404));

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
 * this Mac, when not ~/Zotero/storage (./mirror.cjs). `openAlex`, `semanticScholar`, `arxivApi`, `arxiv`: the free
 * sources' addresses (fake ones in the tests), and `onFinding(itemKey, busy)` told as a free copy is looked for
 * (./oa.cjs). Build 4: `downloadsDir()` the Downloads folder watched after a chip opened a paper in the browser,
 * `onWaiting(itemKey, on)` as a wait starts and ends, `onDownloaded(itemKey, copy)` when a download was the paper and is
 * kept (./downloads.cjs; `readPdfText`, `downloadWaitMs` and `downloadPollMs` for the tests). → { sync, autoSync,
 * lastSyncAt, status, clear, download, openAccess, awaitDownload, attach, library, waitingFor, stopWatching, root, storageDir }
 */
function createZoteroSync({ fetch = globalThis.fetch, api = API, root, account, sleep = defaultSleep, onChange = () => {}, now = () => Date.now(), storageDir = undefined, openAlex = OPENALEX, semanticScholar = SEMANTIC_SCHOLAR, arxivApi = ARXIV_API, arxiv = ARXIV, openAccessTimeoutMs = undefined, onFinding = () => {}, downloadsDir = null, onWaiting = () => {}, onDownloaded = () => {}, readPdfText = undefined, downloadWaitMs = WAIT_MS, downloadPollMs = POLL_MS } = {}) {
  let running = null; // the sync under way
  let finishedAt = 0; // when the last sync ended, ms (0: none since launch; state.json's syncedAt then)
  let again = false; // asked for while one ran: one more after it
  let generation = 0; // a clear() stops whatever ran before it from writing
  let controller = null;
  let notBefore = 0; // a Backoff header holds every request until then
  let state = { state: 'idle', error: '', problems: [] };

  const rootNow = () => (typeof root === 'function' ? root() : root);
  const changed = () => { try { onChange(status()); } catch { /* a listener never breaks a sync */ } };

  /**
   * { state: 'idle' | 'syncing' | 'synced' | 'error', items, syncedAt, error, groups, problems }: what the Zotero row says.
   * `items` counts every library's, `groups` the groups mirrored, `problems` [{ name, error }] the groups the last sync
   * could not (My Library's own failure is `error`).
   */
  function status() {
    const at = rootNow();
    const kept = at ? readJson(path.join(at, 'state.json')) : null;
    const groups = at ? groupIds(at) : [];
    let items = kept && Number.isFinite(kept.items) ? kept.items : 0;
    for (const group of groups) { const held = readJson(path.join(groupDir(at, group), 'state.json')); if (held && Number.isFinite(held.items)) items += held.items; }
    const syncedAt = kept ? kept.syncedAt || '' : '';
    const shown = state.state === 'idle' && (kept || groups.length) ? 'synced' : state.state;
    return { state: shown, items, syncedAt, error: state.error || '', groups: groups.length, problems: state.problems || [] };
  }

  /* ---------------------------------------------------------------- requests */

  // One request to a library (`route` from /users/<id>, or /groups/<group> for a group's), JSON unless `as` says
  // otherwise. Waits out a Backoff, and a 429 or 503's Retry-After (else a little longer each time) before trying again.
  async function request(route, params = {}, { signal, as = 'json', redirect = 'error', headers = {}, group = '' } = {}) {
    const who = account();
    if (!who || !who.key || !who.userID) throw new ZoteroSyncError('Zotero is not connected.', 'signed-out');
    if (group && !GROUP_RE.test(String(group))) throw new ZoteroSyncError('That is not a Zotero group.', 'key');
    const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)])).toString();
    const prefix = group ? `/groups/${group}` : `/users/${encodeURIComponent(who.userID)}`;
    const url = `${api}${prefix}${route}${query ? `?${query}` : ''}`;
    for (let tries = 1; ; tries++) {
      const wait = notBefore - now();
      if (wait > 0) await sleep(Math.min(wait, MAX_WAIT_MS), signal);
      let response;
      try {
        response = await fetch(url, {
          headers: { ...headers, 'zotero-api-key': who.key, 'zotero-api-version': '3', accept: as === 'json' ? 'application/json' : '*/*' },
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
        if (tries >= MAX_TRIES) throw response.status === 429 ? new ZoteroSyncError('Zotero asked to slow down. Try again in a few minutes.', 'busy', 429) : new ZoteroSyncError('Zotero is not answering right now. Try again later.', 'unavailable', response.status);
        const after = Number(response.headers.get('retry-after'));
        await sleep(Math.min(Number.isFinite(after) && after >= 0 ? after * 1000 : 1000 * 2 ** (tries - 1), MAX_WAIT_MS), signal);
        continue;
      }
      if (response.status === 403) throw new ZoteroSyncError(group ? 'Zotero refused access to this group.' : 'Zotero refused the key. Disconnect and connect Zotero again.', 'forbidden', 403);
      return response;
    }
  }

  async function json(route, params, options) {
    const response = await request(route, params, options);
    if (response.status === 304) return { notModified: true, body: null, version: 0, total: 0 };
    if (!response.ok) throw new ZoteroSyncError(`Zotero answered ${response.status} for ${route.split('?')[0]}.`, 'http', response.status);
    return { body: await response.json(), version: Number(response.headers.get('last-modified-version')) || 0, total: Number(response.headers.get('total-results')) };
  }

  /**
   * Every page of a list (limit=100&start=…) → { list, version }, `version` the library's at the first page. `unless`:
   * the library version kept, sent with the first page as If-Modified-Since-Version → { notModified: true } on a 304.
   */
  async function paged(route, params, options, unless = 0) {
    const list = [];
    let version = 0;
    for (let start = 0; ;) {
      const page = await json(route, { ...params, limit: PAGE, start }, start === 0 && unless ? { ...options, headers: { 'if-modified-since-version': String(unless) } } : options);
      if (page.notModified) return { notModified: true, list: [], version: 0 };
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

  /** A sync from the clock or a window brought forward: none when one is under way already (never two at once, and no
   * second one queued behind it). → status() */
  function autoSync() {
    if (running) return running;
    return sync();
  }

  /** When the last sync ended (ms): this run's, else the mirror's syncedAt, else 0. */
  function lastSyncAt() {
    if (finishedAt) return finishedAt;
    const at = rootNow();
    const kept = at ? readJson(path.join(at, 'state.json')) : null;
    const t = kept ? Date.parse(kept.syncedAt) : NaN;
    return Number.isFinite(t) ? t : 0;
  }

  async function once() {
    const run = generation;
    controller = new AbortController();
    const { signal } = controller;
    state = { state: 'syncing', error: '', problems: [] }; changed();
    try {
      const problems = await pullAll(run, signal);
      if (run !== generation) return;
      state = problems.mine ? { state: 'error', error: problems.mine, problems: problems.groups } : { state: 'idle', error: '', problems: problems.groups };
    } catch (error) {
      if (run !== generation) return;
      state = { state: 'error', error: error instanceof ZoteroSyncError ? error.message : 'The Zotero library could not be synced.', problems: [] };
    } finally {
      finishedAt = now();
      if (run === generation) changed();
    }
  }

  const words = (error) => (error instanceof ZoteroSyncError ? error.message : 'It could not be synced.');

  /**
   * My Library, then the groups (build 5), one after another. A failure that would fail every library ends the sync
   * (thrown); else My Library's is `mine` and each group's is one of `groups` [{ name, error }].
   */
  async function pullAll(run, signal) {
    const who = account();
    if (!who) throw new ZoteroSyncError('Zotero is not connected.', 'signed-out');
    const at = rootNow();
    if (!at) throw new ZoteroSyncError('There is no data folder to keep the library in.', 'no-root');
    const out = { mine: '', groups: [] };
    try { await pull({ group: '', root: at }, run, signal); } catch (error) {
      if (error instanceof ZoteroSyncError && ENDS_ALL.has(error.code)) throw error;
      out.mine = words(error);
    }
    if (run !== generation) return out;
    let listed = null;
    try { listed = await listGroups(signal); } catch (error) {
      if (error instanceof ZoteroSyncError && ENDS_GROUPS.has(error.code)) throw error;
      out.groups.push({ name: 'Your groups', error: `The list of your groups could not be had: ${words(error)}` });
    }
    if (run !== generation || !listed) return out;
    const ids = new Set(listed.map((group) => group.id));
    for (const group of groupIds(at)) if (!ids.has(group)) dropGroup(at, group); // left, or no longer readable
    for (const group of listed) {
      if (run !== generation) return out;
      try { await pull({ group: group.id, name: group.name, root: groupDir(at, group.id) }, run, signal); } catch (error) {
        if (error instanceof ZoteroSyncError && ENDS_GROUPS.has(error.code)) throw error;
        if (lostGroup(error)) { if (run === generation) dropGroup(at, group.id); continue; }
        out.groups.push({ name: group.name, error: words(error) });
      }
    }
    return out;
  }

  /** The groups the person is in (/users/<id>/groups, every page) → [{ id, name }]. */
  async function listGroups(signal) {
    const { list } = await paged('/groups', { format: 'json' }, { signal });
    const out = [], seen = new Set();
    for (const entry of list) {
      const id = String((entry && (entry.id ?? (entry.data && entry.data.id))) ?? '');
      if (!GROUP_RE.test(id) || seen.has(id)) continue;
      seen.add(id);
      const name = String((entry.data && entry.data.name) || '').trim() || `Group ${id}`;
      out.push({ id, name });
    }
    return out;
  }

  /** Deletes a group's mirror (the person left it, or lost access), and stops waiting for its downloads. */
  function dropGroup(at, group) {
    if (downloads) for (const ref of downloads.waiting()) { const parsed = parseRef(ref); if (parsed && parsed.group === group) downloads.stop(ref); }
    try { fs.rmSync(groupDir(at, group), { recursive: true, force: true }); } catch { /* already gone */ }
  }

  /**
   * One library brought up to Zotero's: `lib` { group: '' (My Library) | groupID, name, root }. Its state.json says
   * whose (the user, and the group) and at which version; another's, or an older layout's, is started over.
   */
  async function pull(lib, run, signal) {
    const who = account();
    if (!who) throw new ZoteroSyncError('Zotero is not connected.', 'signed-out');
    const at = lib.root;
    const { group } = lib;
    const kept = readJson(path.join(at, 'state.json'));
    const ours = kept && kept.v === VERSION && kept.userID === String(who.userID) && String(kept.groupID || '') === group;
    let raw = ours ? readJson(path.join(at, 'raw.json')) : null;
    let since = 0;
    if (raw && raw.items && raw.collections) since = Number(kept.version) || 0;
    else {
      // None yet, another account's, or one from an older layout: from the start. My Library's folder holds the groups'
      // too: they stay, unless the mirror was another account's.
      const other = !group && kept && kept.userID && kept.userID !== String(who.userID);
      if (group || other) fs.rmSync(at, { recursive: true, force: true });
      else { let names = []; try { names = fs.readdirSync(at); } catch { /* none yet */ } for (const name of names) if (name !== 'groups') fs.rmSync(path.join(at, name), { recursive: true, force: true }); }
      raw = { collections: {}, items: {}, bib: {} };
    }
    raw.bib = raw.bib || {};
    const whose = group ? { userID: String(who.userID), groupID: group, name: lib.name || `Group ${group}` } : { userID: String(who.userID) };
    const options = { signal, group };

    const collections = await paged('/collections', { since, format: 'json' }, options, since);
    if (collections.notModified) { // nothing changed since: only when it was checked
      if (run === generation) writeJson(path.join(at, 'state.json'), { ...kept, ...whose, syncedAt: new Date(now()).toISOString() });
      return;
    }
    const items = await paged('/items', { since, format: 'json', includeTrashed: 1 }, options);
    const version = collections.version || items.version;
    const deleted = since ? (await json('/deleted', { since }, options)).body || {} : {};
    const texts = (await json('/fulltext', { since }, options)).body || {};

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
      const answer = await json('/items', { itemKey: batch.join(','), format: 'json', include: 'bibtex' }, options);
      for (const entry of Array.isArray(answer.body) ? answer.body : []) {
        if (entry && entry.key && typeof entry.bibtex === 'string' && entry.bibtex.trim()) raw.bib[entry.key] = entry.bibtex;
      }
    }

    // What Zotero indexed of the attachments whose text changed, each by itself.
    const fulltext = {};
    for (const key of Object.keys(texts)) {
      if (!KEY_RE.test(key) || !raw.items[key]) continue;
      const response = await request(`/items/${key}/fulltext`, {}, options);
      if (response.status === 404) continue;
      if (!response.ok) throw new ZoteroSyncError(`Zotero answered ${response.status} for an attachment's text.`, 'http', response.status);
      const body = await response.json();
      if (body && typeof body.content === 'string') fulltext[key] = body.content;
    }

    if (run !== generation) return;
    fs.mkdirSync(at, { recursive: true });
    writeJson(path.join(at, 'raw.json'), raw);
    const count = writeViews(at, raw, fulltext);
    writeJson(path.join(at, 'state.json'), { v: VERSION, ...whose, version: version || Number(kept && kept.version) || 0, syncedAt: new Date(now()).toISOString(), items: count });
  }

  /* -------------------------------------------------------------- attachments */

  /**
   * An attachment's file from Zotero's storage (/items/<key>/file, of /groups/<group> for a group's) → its path under
   * its library's files/<key>/. The redirect to where the file is kept is followed here, without the key. Throws when
   * there is none to download.
   */
  async function download(attachmentKey, filename, group = '') {
    if (!KEY_RE.test(String(attachmentKey))) throw new ZoteroSyncError('That is not a Zotero attachment.', 'key');
    const base = rootNow(); if (!base) throw new ZoteroSyncError('There is no data folder to keep the file in.', 'no-root');
    const at = libraryRoot(base, group);
    const name = path.basename(String(filename || '')).replace(/[\0/\\]/g, '') || `${attachmentKey}.pdf`;
    const target = path.join(at, 'files', attachmentKey, name);
    if (fs.existsSync(target)) return target;
    let response = await request(`/items/${attachmentKey}/file`, {}, { as: 'file', redirect: 'manual', group });
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
    finishedAt = 0;
    state = { state: 'idle', error: '', problems: [] };
    if (downloads) downloads.stopAll();
    const at = rootNow();
    if (at) { try { fs.rmSync(at, { recursive: true, force: true }); } catch { /* already gone */ } }
    changed();
  }

  // A free copy of an item with no pdf of its own (./oa.cjs): OpenAlex, Semantic Scholar, arXiv, never Zotero, and
  // never the key. One finder a library (build 5), kept in its own folder; the chip is told by the item's ref.
  const finders = new Map();
  function finder(group = '') {
    if (!finders.has(group)) {
      finders.set(group, createOpenAccess({
        fetch, api: openAlex, semanticScholar, arxivApi, arxiv, now, ...(openAccessTimeoutMs ? { timeoutMs: openAccessTimeoutMs } : {}),
        root: () => { const base = rootNow(); return base ? libraryRoot(base, group) : null; },
        onFinding: (key, busy) => onFinding(refOf(group, key), busy),
      }));
    }
    return finders.get(group);
  }

  // Build 4: the pdf the person downloads in their browser, copied in when it is the paper (./downloads.cjs). Waited for
  // by the item's ref (build 5), so the same key in two libraries is two waits.
  const downloads = downloadsDir ? createDownloadWatch({
    dir: downloadsDir, onWaiting, waitMs: downloadWaitMs, pollMs: downloadPollMs, ...(readPdfText ? { readText: readPdfText } : {}),
    onMatch: (waited, file) => {
      const base = rootNow();
      const parsed = parseRef(waited.key);
      if (!base || !parsed) return false;
      const copy = saveCopy(libraryRoot(base, parsed.group), { ...waited, key: parsed.key }, readPdfFile(file), { source: 'downloaded in browser', from: file, at: now() });
      if (copy) { try { onDownloaded(waited.key, copy); } catch { /* a listener never undoes a copy */ } }
      return !!copy;
    },
  }) : null;

  /** The item a ref names, in its library's mirror → { item, root, group } or null. */
  function itemFor(ref) {
    const base = rootNow();
    const parsed = parseRef(ref);
    if (!base || !parsed) return null;
    const root = libraryRoot(base, parsed.group);
    const item = itemOf(root, parsed.key);
    return item ? { item, root, group: parsed.group } : null;
  }

  /** Waits for item `ref`'s pdf in the Downloads folder (its chip opened its page in the browser) → whether it does. */
  function awaitDownload(ref) {
    const found = downloads ? itemFor(ref) : null;
    return !!found && paperLike(found.item) && downloads.wait({ ...found.item, key: refOf(found.group, found.item.key) });
  }

  /**
   * Makes `file` (a pdf the person dropped on the item's chip) item `ref`'s pdf: copied in, never moved, as 'added by
   * hand'. No title check: they chose it. → oa.cjs keptCopy's answer; throws with words when it is not a pdf.
   */
  function attach(ref, file) {
    const found = itemFor(ref);
    if (!found) throw new ZoteroSyncError(parseRef(ref) && parseRef(ref).group ? 'This item is no longer in that Zotero group.' : 'This item is no longer in your Zotero library.', 'missing');
    const copy = saveCopy(found.root, found.item, readPdfFile(file), { source: 'added by hand', from: file, at: now() });
    if (downloads) downloads.stop(refOf(found.group, found.item.key));
    return copy;
  }

  /**
   * Library `group` ('' My Library) as ./mirror.cjs reads it (build 5) → { group, name, root, download(key, filename),
   * openAccess(item), storageDir }, or null with no data folder.
   */
  function library(group = '') {
    const base = rootNow();
    if (!base || (group && !GROUP_RE.test(String(group)))) return null;
    const oa = finder(group);
    return { group, name: libraryName(base, group), root: libraryRoot(base, group), download: (key, filename) => download(key, filename, group), openAccess: oa.find, storageDir };
  }

  return {
    sync, autoSync, lastSyncAt, status, clear, download, openAccess: (item) => finder('').find(item), awaitDownload, attach, library,
    waitingFor: () => (downloads ? downloads.waiting() : []), stopWatching: () => { if (downloads) downloads.stopAll(); },
    root: rootNow, storageDir,
  };
}

/**
 * Syncs `library` (createZoteroSync's) while the app is open, when `connected()`: every `every` ms, and on focus() (a
 * window come back to the front) when the last sync ended over `stale` ms ago. Each goes through autoSync, so one under
 * way is never doubled. → { focus, stop }
 */
function scheduleSyncs(library, { connected, every = EVERY_MS, stale = STALE_MS, now = () => Date.now(), setInterval: startClock = setInterval, clearInterval: stopClock = clearInterval } = {}) {
  const ok = () => { try { return !!connected(); } catch { return false; } };
  const run = () => { if (ok()) void library.autoSync().catch(() => {}); };
  const clock = startClock(run, every);
  if (clock && typeof clock.unref === 'function') clock.unref();
  return {
    focus() { if (ok() && now() - library.lastSyncAt() > stale) run(); },
    stop() { stopClock(clock); },
  };
}

module.exports = { createZoteroSync, scheduleSyncs, ZoteroSyncError, writeViews, citeKeys, betterBibtexKey, madeKey, rekeyed, noteText, PAGE, EVERY_MS, STALE_MS };
