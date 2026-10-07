'use strict';

// A free copy of a Zotero item that has no pdf of its own (MATH-65 build 3). For an item with a DOI, OpenAlex is asked
// (GET <api>/works/doi:<doi>, no key) for the pdf addresses it knows: best_oa_location.pdf_url first, then each
// locations[].pdf_url. They are tried in that order and the first that really is a pdf (Content-Type application/pdf and
// a body that starts with %PDF) is kept; a publisher's link that answers with a page (a sign-in, a bot check) is passed
// over for the next. The copy goes to <mirror>/files/<itemKey>/<first author year short title>.pdf, and where it came
// from to <mirror>/items/<itemKey>/open-access.json:
//   { v, found: true, source: 'OpenAlex', url, file, checkedAt }   a copy kept
//   { v, found: false, source: 'OpenAlex', checkedAt, until }     none to be had: not asked again until `until` (7 days)
// Asked only when the item is mentioned to Bart or its chip is clicked (./mirror.cjs resolvePdf), never during a sync.
// Each request has ~15 s; when OpenAlex cannot be reached, or a pdf address times out, nothing is written and the item
// is left alone for an hour, in memory only, so going offline costs no week. Nothing here throws, logs, or writes back
// to Zotero: a failure is "no pdf".

const fs = require('node:fs');
const path = require('node:path');

const OPENALEX = 'https://api.openalex.org';
const TIMEOUT_MS = 15_000;
const BODY_TIMEOUT_MS = 90_000; // a pdf's headers within TIMEOUT_MS, the rest of it within this
const MAX_BYTES = 200 * 1024 * 1024;
const MISS_MS = 7 * 24 * 60 * 60_000;
const UNREACHED_MS = 60 * 60_000;
const MAX_CANDIDATES = 8;
const VERSION = 1;
const KEY_RE = /^[A-Za-z0-9]{1,32}$/;
const RECORD = 'open-access.json';

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const exists = (file) => { try { return fs.statSync(file).isFile(); } catch { return false; } };

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, data);
  fs.renameSync(temporary, file);
}

/** An item's DOI as OpenAlex takes it ("10.…"), from "https://doi.org/10.…", "doi:10.…" or itself; '' when it is none. */
function cleanDoi(value) {
  const doi = String(value || '').trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '');
  return /^10\.\d+(\.\d+)*\/\S+$/.test(doi) ? doi : '';
}

/** "Smith 2020 Learning to Learn.pdf": the first author's last name, the year, the title up to its colon (8 words at most). */
function pdfName(item) {
  const creators = (item && item.creators) || [];
  const first = creators.find((c) => c.type === 'author') || creators[0];
  const last = first ? first.last || String(first.name || '').trim().split(/\s+/).pop() || '' : '';
  const title = String((item && item.title) || '').split(/[:?!.]\s/)[0].split(/\s+/).filter(Boolean).slice(0, 8).join(' ');
  const name = [last, item && item.year, title].filter(Boolean).join(' ')
    .replace(/[\0-\x1f\x7f/\\:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80).trim();
  return `${name || (item && item.key) || 'paper'}.pdf`;
}

/** The pdf addresses an OpenAlex work names, best first, each once. */
function candidates(work) {
  const out = [];
  const add = (location) => {
    const url = location && typeof location.pdf_url === 'string' ? location.pdf_url.trim() : '';
    if (/^https?:\/\//i.test(url) && !out.includes(url)) out.push(url);
  };
  if (work) { add(work.best_oa_location); for (const location of Array.isArray(work.locations) ? work.locations : []) add(location); }
  return out.slice(0, MAX_CANDIDATES);
}

/** The copy kept for an item → { path, url, foundAt, source: 'open access' }, or null (none, or its file is gone). */
function keptCopy(root, key) {
  if (!root || !KEY_RE.test(String(key || ''))) return null;
  const record = readJson(path.join(root, 'items', key, RECORD));
  if (!record || !record.found || typeof record.file !== 'string' || !exists(record.file)) return null;
  return { path: record.file, url: String(record.url || ''), foundAt: String(record.checkedAt || ''), source: 'open access' };
}

/**
 * `root()`: the mirror's folder (<dataRoot>/.zotero). `onFinding(itemKey, busy)`: told as a lookup starts and ends (the
 * chip says "Finding a free copy…"). → { find(item) → Promise<keptCopy's answer | null>, kept(key) }
 */
function createOpenAccess({ fetch = globalThis.fetch, api = OPENALEX, root, now = () => Date.now(), timeoutMs = TIMEOUT_MS, bodyTimeoutMs = BODY_TIMEOUT_MS, onFinding = () => {} } = {}) {
  const rootNow = () => (typeof root === 'function' ? root() : root);
  const running = new Map(); // item key → its lookup under way
  const unreached = new Map(); // item key → not before (ms): OpenAlex or a pdf address could not be reached

  const tell = (key, busy) => { try { onFinding(key, busy); } catch { /* a listener never breaks a lookup */ } };

  /** fetch with `timeoutMs` for the headers; the body is read within `bodyTimeoutMs` from the start. → { response, done } */
  async function get(url, accept) {
    const controller = new AbortController();
    const headers = setTimeout(() => controller.abort(), timeoutMs);
    const body = setTimeout(() => controller.abort(), Math.max(timeoutMs, bodyTimeoutMs));
    const done = () => { clearTimeout(headers); clearTimeout(body); };
    try {
      const response = await fetch(url, { headers: { accept, 'user-agent': 'Engelbart' }, redirect: 'follow', credentials: 'omit', signal: controller.signal });
      clearTimeout(headers);
      return { response, done, controller };
    } catch (error) { done(); throw error; }
  }

  /** OpenAlex's work for `doi` → the work, null (OpenAlex has none), or throws (not reached). */
  async function work(doi) {
    const { response, done } = await get(`${api}/works/doi:${doi.split('/').map(encodeURIComponent).join('/')}`, 'application/json');
    try {
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`OpenAlex answered ${response.status}`);
      return await response.json();
    } finally { done(); }
  }

  /** The bytes at `url` when they are a pdf → Buffer | 'not-pdf' | 'unreached'. */
  async function pdfAt(url) {
    let got;
    try { got = await get(url, 'application/pdf'); } catch { return 'unreached'; }
    const { response, done, controller } = got;
    try {
      const type = String(response.headers.get('content-type') || '').toLowerCase();
      if (!response.ok || !type.startsWith('application/pdf')) { controller.abort(); return response.status >= 500 || response.status === 429 ? 'unreached' : 'not-pdf'; }
      if (Number(response.headers.get('content-length')) > MAX_BYTES) { controller.abort(); return 'not-pdf'; }
      const bytes = Buffer.from(await response.arrayBuffer());
      return bytes.length <= MAX_BYTES && bytes.subarray(0, 4).toString('latin1') === '%PDF' ? bytes : 'not-pdf';
    } catch { return 'unreached'; } finally { done(); }
  }

  async function lookup(at, item, doi) {
    const dir = path.join(at, 'items', item.key);
    const record = (value) => { try { writeAtomic(path.join(dir, RECORD), `${JSON.stringify({ v: VERSION, source: 'OpenAlex', ...value }, null, 1)}\n`); } catch { /* the mirror went: nothing kept */ } };
    let found;
    try { found = await work(doi); } catch { unreached.set(item.key, now() + UNREACHED_MS); return null; }
    let missed = false;
    for (const url of candidates(found)) {
      const bytes = await pdfAt(url);
      if (bytes === 'unreached') { missed = true; continue; }
      if (bytes === 'not-pdf') continue;
      const file = path.join(at, 'files', item.key, pdfName(item));
      try { writeAtomic(file, bytes); } catch { return null; }
      const checkedAt = new Date(now()).toISOString();
      record({ found: true, url, file, checkedAt });
      return { path: file, url, foundAt: checkedAt, source: 'open access' };
    }
    if (missed) { unreached.set(item.key, now() + UNREACHED_MS); return null; }
    record({ found: false, checkedAt: new Date(now()).toISOString(), until: new Date(now() + MISS_MS).toISOString() });
    return null;
  }

  /** A free copy of `item` (an items.json entry): the one kept, else found now. Null when there is none, never throws. */
  function find(item) {
    const at = rootNow();
    if (!at || !item || !KEY_RE.test(String(item.key || ''))) return Promise.resolve(null);
    const kept = keptCopy(at, item.key);
    if (kept) return Promise.resolve(kept);
    const doi = cleanDoi(item.doi);
    if (!doi) return Promise.resolve(null);
    if ((unreached.get(item.key) || 0) > now()) return Promise.resolve(null);
    const missed = readJson(path.join(at, 'items', item.key, RECORD));
    if (missed && missed.found === false && Date.parse(missed.until) > now()) return Promise.resolve(null);
    if (running.has(item.key)) return running.get(item.key);
    tell(item.key, true);
    const under = lookup(at, item, doi).catch(() => null).finally(() => { running.delete(item.key); tell(item.key, false); });
    running.set(item.key, under);
    return under;
  }

  return { find, kept: (key) => keptCopy(rootNow(), key) };
}

module.exports = { createOpenAccess, keptCopy, cleanDoi, pdfName, candidates, OPENALEX, MISS_MS, UNREACHED_MS, TIMEOUT_MS };
