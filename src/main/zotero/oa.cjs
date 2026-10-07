'use strict';

// A free copy of a Zotero item that has no pdf of its own (MATH-65 build 3). For an item with a DOI, OpenAlex is asked
// (GET <api>/works/doi:<doi>, no key) for the pdf addresses it knows: best_oa_location.pdf_url first, then each
// locations[].pdf_url. They are tried in that order and the first that really is a pdf (Content-Type application/pdf and
// a body that starts with %PDF) is kept; a publisher's link that answers with a page (a sign-in, a bot check) is passed
// over for the next. Build 4: when none of OpenAlex's is, Semantic Scholar is asked (GET <api>/graph/v1/paper/DOI:<doi>
// ?fields=openAccessPdf,externalIds; its openAccessPdf is passed over when it is only the doi.org link), then arXiv: the
// ArXiv id Semantic Scholar names, else an arXiv title search (<api>/api/query, ti:"…") whose entry's title closely matches the
// item's (closeTitle), downloaded from <arxiv>/pdf/<id>. The copy goes to
// <mirror>/files/<itemKey>/<first author year short title>.pdf, and where it came from to
// <mirror>/items/<itemKey>/open-access.json:
//   { v, found: true, source: 'OpenAlex' | 'Semantic Scholar' | 'arXiv', url, file, checkedAt }   a copy found
//   { v, found: true, source: 'downloaded in browser' | 'added by hand', from, file, checkedAt }   build 4: one the person
//                                                                  downloaded (./downloads.cjs) or dropped on the chip
//   { v, found: false, sources, checkedAt, until }   none to be had from `sources`: not asked again until `until` (7 days)
// Asked only when the item is mentioned to Bart or its chip is clicked (./mirror.cjs resolvePdf), never during a sync.
// Each request has ~15 s; when a source cannot be reached (or answers 429), or a pdf address times out, and no copy is
// found, nothing is written and the item is left alone for an hour, in memory only, so going offline costs no week. A
// miss written before a source was added (build 3's, OpenAlex only) is asked again. Nothing here throws, logs, or
// writes back to Zotero: a failure is "no pdf".

const fs = require('node:fs');
const path = require('node:path');

const OPENALEX = 'https://api.openalex.org';
const SEMANTIC_SCHOLAR = 'https://api.semanticscholar.org';
const ARXIV_API = 'https://export.arxiv.org';
const ARXIV = 'https://arxiv.org';
const SOURCES = ['OpenAlex', 'Semantic Scholar', 'arXiv'];
// Where a kept copy came from → its kind, for the chip and Bart (./mirror.cjs): found by one of SOURCES is 'open access'.
const KINDS = new Set(['downloaded in browser', 'added by hand']);
const TIMEOUT_MS = 15_000;
const BODY_TIMEOUT_MS = 90_000; // a pdf's headers within TIMEOUT_MS, the rest of it within this
const MAX_BYTES = 200 * 1024 * 1024;
const MISS_MS = 7 * 24 * 60 * 60_000;
const UNREACHED_MS = 60 * 60_000;
const MAX_CANDIDATES = 8;
const VERSION = 1;
const KEY_RE = /^[A-Za-z0-9]{1,32}$/;
const ARXIV_ID_RE = /^(\d{4}\.\d{4,5}|[a-z-]+(\.[A-Z]{2})?\/\d{7})(v\d+)?$/i;
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

/** Semantic Scholar's pdf address for a paper, or none: a doi.org link is only the publisher's page again. */
function scholarCandidates(paper) {
  const url = paper && paper.openAccessPdf && typeof paper.openAccessPdf.url === 'string' ? paper.openAccessPdf.url.trim() : '';
  if (!/^https?:\/\//i.test(url) || /^https?:\/\/(dx\.)?doi\.org\//i.test(url)) return [];
  return [url];
}

/** An arXiv id ("2101.00001", "cs/0112017") from "arXiv:2101.00001v2", an abs or pdf address, or itself; '' when none. */
function arxivId(value) {
  const id = String(value || '').trim().replace(/^arxiv:\s*/i, '').replace(/^https?:\/\/(export\.)?arxiv\.org\/(abs|pdf)\//i, '').replace(/\.pdf$/i, '');
  return ARXIV_ID_RE.test(id) ? id.replace(/v\d+$/i, '') : '';
}

/** A title's words, for comparing two titles: case, accents' forms, punctuation and spacing put aside. */
const titleWords = (title) => String(title || '').normalize('NFKC').toLowerCase().replace(/<[^>]+>/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);

/**
 * Whether two titles name the same paper: the same words, or (four words or more) nearly so, a Dice coefficient of
 * their words of 0.9 or more (one word in ten differing).
 */
function closeTitle(a, b) {
  const x = titleWords(a), y = titleWords(b);
  if (!x.length || !y.length) return false;
  if (x.join(' ') === y.join(' ')) return true;
  if (Math.min(x.length, y.length) < 4) return false;
  const left = new Map();
  for (const word of x) left.set(word, (left.get(word) || 0) + 1);
  let shared = 0;
  for (const word of y) { const n = left.get(word) || 0; if (n) { shared += 1; left.set(word, n - 1); } }
  return (2 * shared) / (x.length + y.length) >= 0.9;
}

const unxml = (text) => String(text || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');

/** The entries of an arXiv API answer (Atom) → [{ id, title }]. */
function arxivEntries(xml) {
  const out = [];
  for (const [, entry] of String(xml || '').matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const id = arxivId(unxml((/<id>([\s\S]*?)<\/id>/.exec(entry) || [])[1]));
    const title = unxml((/<title>([\s\S]*?)<\/title>/.exec(entry) || [])[1]).replace(/\s+/g, ' ').trim();
    if (id) out.push({ id, title });
  }
  return out;
}

/**
 * The copy kept for an item → { path, url, foundAt, source, via, from? }, or null (none, or its file is gone). `source`
 * is 'open access' for one found through `via` (OpenAlex, Semantic Scholar, arXiv), else 'downloaded in browser' or
 * 'added by hand' (`from`: the file it was copied from).
 */
function keptCopy(root, key) {
  if (!root || !KEY_RE.test(String(key || ''))) return null;
  const record = readJson(path.join(root, 'items', key, RECORD));
  if (!record || !record.found || typeof record.file !== 'string' || !exists(record.file)) return null;
  const via = String(record.source || 'OpenAlex');
  const kind = KINDS.has(via) ? via : 'open access';
  return { path: record.file, url: String(record.url || ''), foundAt: String(record.checkedAt || ''), source: kind, via, ...(kind !== 'open access' ? { from: String(record.from || '') } : {}) };
}

/**
 * Keeps `bytes` (a pdf) as `item`'s copy: files/<itemKey>/<pdfName>, and the record saying where it came from (`source`
 * one of SOURCES with its `url`, or one of KINDS with the file it was copied `from`). → keptCopy's answer; throws when the
 * mirror cannot be written.
 */
function saveCopy(root, item, bytes, { source, url = '', from = '', at = Date.now() }) {
  const file = path.join(root, 'files', item.key, pdfName(item));
  writeAtomic(file, bytes);
  const checkedAt = new Date(at).toISOString();
  const record = KINDS.has(source) ? { found: true, from, file, checkedAt } : { found: true, url, file, checkedAt };
  writeAtomic(path.join(root, 'items', item.key, RECORD), `${JSON.stringify({ v: VERSION, source, ...record }, null, 1)}\n`);
  return keptCopy(root, item.key);
}

/** The bytes of `file` when it is a pdf (starts with %PDF) → Buffer; throws with words to show otherwise. */
function readPdfFile(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { throw new Error('That file could not be read.'); }
  if (!stat.isFile()) throw new Error('That is not a file.');
  if (stat.size > MAX_BYTES) throw new Error('That PDF is too large.');
  const bytes = fs.readFileSync(file);
  if (bytes.subarray(0, 4).toString('latin1') !== '%PDF') throw new Error('That file is not a PDF.');
  return bytes;
}

/**
 * `root()`: the mirror's folder (<dataRoot>/.zotero). `onFinding(itemKey, busy)`: told as a lookup starts and ends (the
 * chip says "Finding a free copy…"). `api`, `semanticScholar`, `arxivApi`, `arxiv`: the sources' addresses (fake ones in
 * the tests). → { find(item) → Promise<keptCopy's answer | null>, kept(key) }
 */
function createOpenAccess({ fetch = globalThis.fetch, api = OPENALEX, semanticScholar = SEMANTIC_SCHOLAR, arxivApi = ARXIV_API, arxiv = ARXIV, root, now = () => Date.now(), timeoutMs = TIMEOUT_MS, bodyTimeoutMs = BODY_TIMEOUT_MS, onFinding = () => {} } = {}) {
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

  /** What a source answers at `url` → its body (JSON, or text), null (it has none: 404, 400), or throws (not reached). */
  async function ask(url, as = 'json') {
    const { response, done } = await get(url, as === 'json' ? 'application/json' : 'application/atom+xml');
    try {
      if (response.status === 404 || response.status === 400) return null;
      if (!response.ok) throw new Error(`answered ${response.status}`);
      return as === 'json' ? await response.json() : await response.text();
    } finally { done(); }
  }
  const doiPath = (doi) => doi.split('/').map(encodeURIComponent).join('/');
  /** OpenAlex's work for `doi`. */
  const work = (doi) => ask(`${api}/works/doi:${doiPath(doi)}`);
  /** Semantic Scholar's paper for `doi`: its openAccessPdf and externalIds (ArXiv). */
  const scholarPaper = (doi) => ask(`${semanticScholar}/graph/v1/paper/DOI:${doiPath(doi)}?fields=openAccessPdf,externalIds`);
  /**
   * The arXiv id of the paper titled `title`, from a title search: the first entry whose title closely matches; '' none.
   * A phrase (ti:"…"): arXiv drops stop words, so "is" or "you" in an AND of words finds nothing. The title up to its
   * colon when that is three words or more, so a subtitle Zotero has and arXiv has not still finds it.
   */
  async function arxivByTitle(title) {
    const main = titleWords(String(title).split(/:\s/)[0]);
    const words = (main.length >= 3 ? main : titleWords(title)).slice(0, 20);
    if (!words.length) return '';
    const query = new URLSearchParams({ search_query: `ti:"${words.join(' ')}"`, start: '0', max_results: '10' }).toString();
    const entries = arxivEntries(await ask(`${arxivApi}/api/query?${query}`, 'text'));
    const match = entries.find((entry) => closeTitle(entry.title, title));
    return match ? match.id : '';
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
    const tried = new Set();
    let missed = false; // a source or an address could not be reached: no miss is written
    const reach = async (step) => { try { return await step(); } catch { missed = true; return null; } };
    /** The first of `urls` that is a pdf, kept as found through `source` → keptCopy's answer | null; false: not kept. */
    async function first(urls, source) {
      for (const url of urls) {
        if (tried.has(url)) continue;
        tried.add(url);
        const bytes = await pdfAt(url);
        if (bytes === 'unreached') { missed = true; continue; }
        if (bytes === 'not-pdf') continue;
        try { return saveCopy(at, item, bytes, { source, url, at: now() }); } catch { return false; } // the mirror went
      }
      return null;
    }
    let copy = await first(candidates(await reach(() => work(doi))), 'OpenAlex');
    if (copy !== null) return copy || null;
    const paper = await reach(() => scholarPaper(doi));
    copy = await first(scholarCandidates(paper), 'Semantic Scholar');
    if (copy !== null) return copy || null;
    const id = arxivId(paper && paper.externalIds && paper.externalIds.ArXiv) || (item.title ? await reach(() => arxivByTitle(item.title)) : '');
    copy = id ? await first([`${arxiv}/pdf/${id}`], 'arXiv') : null;
    if (copy !== null) return copy || null;
    if (missed) { unreached.set(item.key, now() + UNREACHED_MS); return null; }
    try {
      writeAtomic(path.join(at, 'items', item.key, RECORD), `${JSON.stringify({ v: VERSION, found: false, sources: SOURCES, checkedAt: new Date(now()).toISOString(), until: new Date(now() + MISS_MS).toISOString() }, null, 1)}\n`);
    } catch { /* the mirror went: nothing kept */ }
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
    const asked = missed && Array.isArray(missed.sources) && SOURCES.every((source) => missed.sources.includes(source));
    if (missed && missed.found === false && asked && Date.parse(missed.until) > now()) return Promise.resolve(null);
    if (running.has(item.key)) return running.get(item.key);
    tell(item.key, true);
    const under = lookup(at, item, doi).catch(() => null).finally(() => { running.delete(item.key); tell(item.key, false); });
    running.set(item.key, under);
    return under;
  }

  return { find, kept: (key) => keptCopy(rootNow(), key) };
}

module.exports = { createOpenAccess, keptCopy, saveCopy, readPdfFile, cleanDoi, pdfName, candidates, scholarCandidates, arxivId, arxivEntries, closeTitle, titleWords, OPENALEX, SEMANTIC_SCHOLAR, ARXIV_API, ARXIV, SOURCES, MISS_MS, UNREACHED_MS, TIMEOUT_MS, MAX_BYTES };
