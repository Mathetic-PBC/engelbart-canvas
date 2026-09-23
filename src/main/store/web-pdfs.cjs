'use strict';

// Pdfs that were saved as links (2026-09-23, Hudson: "old saved pdfs should all be downloaded in the background and
// migrated to pdfs. a checker should run on opening engelbart to ensure that this has been done").
//
// Before the Stage kept a copy (spec §2 #87), + Save on a pdf from the web made a `website` row: the address only.
// Each launch (every time a library opens: store.context, not awaited) this checks every page row the library holds
// against a record of what was already settled, and in the background downloads the ones that turn out to be pdfs,
// turning each row into a `pdf` with its copy in <data root>/assets/pdfs/<id>.pdf. The row stays the same row — id,
// name, address, tags, summary — so workspaces, @mentions and ink (kept by id, or by the address) all follow it.
//
// Which page rows are pdfs: an address whose path ends in .pdf, an arXiv paper (its pdf is arxiv.org/pdf/<id>: the
// library already treats the abstract page's row as the paper, and ink drawn on the pdf is on that row), and anything
// else whose answer is a pdf — asked once, reading only the start of the answer. The record,
// <data root>/.migrations/web-pdfs.json, holds per row: `saved`, `page` (not a pdf, at that address), or `failed`
// (tried again on later launches, at most MAX_ATTEMPTS times, and again whenever the address changes). The checker is
// then a read of that file and of the library: nothing goes to the network for a row that is settled.

const fs = require('node:fs');
const path = require('node:path');
const library = require('./library.cjs');

const RECORD_VERSION = 1;
const MAX_ATTEMPTS = 5;
const PARALLEL = 2;
const ARXIV_ABS = /^https?:\/\/(?:www\.)?arxiv\.org\/abs\/([^?#]+?)\/?$/i;

const recordFile = (ctx) => path.join(ctx.dataRoot, '.migrations', 'web-pdfs.json');

function readRecord(ctx) {
  try {
    const value = JSON.parse(fs.readFileSync(recordFile(ctx), 'utf8'));
    if (value && value.version === RECORD_VERSION && value.rows && typeof value.rows === 'object') return value;
  } catch { /* none yet, or unreadable: start over */ }
  return { version: RECORD_VERSION, rows: {} };
}

function writeRecord(ctx, record) {
  const file = recordFile(ctx);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(record, null, 1), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

/** A page row that may be a pdf, and where its pdf would be fetched from; null for anything else. `sure`: by its address alone. */
function candidate(row) {
  if (!row || row.type !== 'website' || row.path || row.folder_path || !row.url) return null;
  const tags = Array.isArray(row.tags) ? row.tags : [];
  if (tags.includes('git') || tags.includes('note')) return null;
  let url;
  try { url = new URL(row.url); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const arxiv = row.url.match(ARXIV_ABS);
  if (arxiv) return { id: row.id, url: row.url, from: `https://arxiv.org/pdf/${arxiv[1]}`, sure: true };
  return { id: row.id, url: row.url, from: row.url, sure: /\.pdf$/i.test(url.pathname) };
}

/** What still has to be done: candidates never settled at their address, or failed fewer than MAX_ATTEMPTS times. */
function pending(rows, record) {
  return rows.map(candidate).filter(Boolean).filter((c) => {
    const seen = record.rows[c.id];
    if (!seen || seen.url !== c.url) return true;
    return seen.state === 'failed' && (seen.attempts || 0) < MAX_ATTEMPTS;
  });
}

/**
 * A fetch answer read as a pdf, or null when it is not one: it is dropped as soon as its type and first bytes say so,
 * so asking a page costs one chunk. Throws on an HTTP error and past `max` bytes.
 */
async function readPdfResponse(response, { max = library.MAX_PDF_BYTES } = {}) {
  if (!response.ok) throw new Error(`The address answered ${response.status}`);
  const typed = /^\s*application\/(?:x-)?pdf\b/i.test(response.headers.get('content-type') || '');
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0, decided = typed;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => {}); throw new Error('The pdf is larger than 200 MB'); }
    if (!decided && total >= 5) {
      const head = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).subarray(0, 1024);
      if (!head.toString('latin1').includes('%PDF-')) { await reader.cancel().catch(() => {}); return null; }
      decided = true;
    }
  }
  const bytes = new Uint8Array(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
  return library.isPdfBytes(bytes) ? bytes : null;
}

/** One row: download, keep the copy, turn the row into it. Answers the record entry. */
async function migrateOne(ctx, c, { fetchPdf, inspectPdf }) {
  const bytes = await fetchPdf(c.from);
  if (!bytes) return { state: 'page', url: c.url };
  const file = library.writePdfCopy(ctx, c.id, bytes);
  const row = await ctx.libraryDb.adoptPdf(c.id, file);
  if (!row) { fs.rmSync(file, { force: true }); return { state: 'page', url: c.url, note: 'changed meanwhile' }; }
  if (inspectPdf) {
    try { await ctx.libraryDb.setCategory(row.id, { type: 'pdf', tags: [...new Set([...(row.tags || []), ...(await inspectPdf(file))])] }, library.CATEGORY_RULES); } catch { /* recategorize tries again */ }
  }
  return { state: 'saved', url: c.url };
}

const running = new Map(); // data root → the run in progress (a library opened twice checks once)

/**
 * The checker: reads the record and the library, and when something is pending works through it in the background.
 * `fetchPdf(url)` answers the pdf's bytes, null for something that is not a pdf, or throws. `onChange()` is called
 * after each row that became a pdf. Answers { pending, saved, pages, failed } when the run is over.
 */
function checkWebPdfs(ctx, { fetchPdf, inspectPdf = null, onChange = () => {}, log = () => {} } = {}) {
  if (running.has(ctx.dataRoot)) return running.get(ctx.dataRoot);
  const run = (async () => {
    const record = readRecord(ctx);
    const todo = pending(await ctx.libraryDb.list(), record);
    const result = { pending: todo.length, saved: 0, pages: 0, failed: 0 };
    if (!todo.length) return result;
    // the sure ones first: they are the pdfs Hudson saved; the rest is asking pages whether they are one
    const queue = [...todo.filter((c) => c.sure), ...todo.filter((c) => !c.sure)];
    const worker = async () => {
      for (let c = queue.shift(); c; c = queue.shift()) {
        const before = record.rows[c.id];
        let entry;
        try {
          entry = await migrateOne(ctx, c, { fetchPdf, inspectPdf });
        } catch (error) {
          entry = { state: 'failed', url: c.url, attempts: (before && before.url === c.url && before.attempts ? before.attempts : 0) + 1, error: String((error && error.message) || error).slice(0, 300) };
          log(`web pdf ${c.url}: ${entry.error}`);
        }
        record.rows[c.id] = { ...entry, at: new Date().toISOString() };
        writeRecord(ctx, record);
        if (entry.state === 'saved') { result.saved += 1; try { onChange(); } catch { /* the screen will read it next time */ } }
        else if (entry.state === 'page') result.pages += 1;
        else result.failed += 1;
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, worker));
    return result;
  })().finally(() => running.delete(ctx.dataRoot));
  running.set(ctx.dataRoot, run);
  return run;
}

module.exports = { checkWebPdfs, candidate, pending, readPdfResponse, readRecord, recordFile, MAX_ATTEMPTS };
