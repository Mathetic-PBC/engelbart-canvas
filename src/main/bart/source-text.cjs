'use strict';

// What Chat reads of a source it cannot open as it is (2026-10-22). A PDF: its text, as the sweep keeps it for search
// (library_text, ../context/sweeper.cjs), written to <data root>/assets/text/<id>-<mtime>.txt and named in Context.json
// as the item's `text`, since an agent's Read tool cannot open a PDF without poppler. A page in the library by its
// address alone: its text once Chat has read it (keepPageTexts), kept the same way, so the next answer reads and quotes
// the page as the app checks it, and a citation of it can be checked (./cite.cjs readRowText). And what Chat read while
// it answered (openedBy), which a citation of a whole source must be among.
// An item's highlights and the person's notes on them (noteTexts, 2026-10-23): the ink of every paper and page that has
// any, written to <data root>/assets/notes/<id>-<mtime>.txt as <highlights> shows a mentioned one (./highlights.cjs) and
// named as the item's `notes`, so Chat finds what the person marked on any item, not only the ones in front or mentioned.

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { addressKey } = require('../../shared/address-key.cjs');
const { toolCallsOf } = require('./runlog.cjs');
const { attrOf, marksOf, webMarksOf, highlightXml } = require('./highlights.cjs');
const { inkFileOf } = require('../store/library.cjs');

const MAX_TEXT_CHARS = 4_000_000;
const PAGE_TIMEOUT_MS = 8000;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;

const textDir = (dataRoot) => path.join(dataRoot, 'assets', 'text');
const notesDir = (dataRoot) => path.join(dataRoot, 'assets', 'notes');
/** Whether a library row is read from its kept text: a pdf on disk, or a page known by its address alone. */
const keepsText = (row) => !!row && ((row.type === 'pdf' && !!row.path) || (row.type === 'website' && !row.path && !!row.url));
/** How what was read is matched with what is cited: a web address as addressKey spells it, a path resolved. */
const openedKey = (where) => (/^https?:\/\//i.test(String(where || '')) ? `url:${addressKey(where)}` : `file:${path.resolve(String(where))}`);

/**
 * The text files of `rows` that have kept text → Map row id → absolute path. A file is written when its text is newer
 * than the one there (its name carries the time it was read at), and older ones of the row go. One that holds no text
 * (a scan) has none. Best effort: a failure leaves the row without a `text`.
 */
async function sourceTexts(ctx, rows) {
  const out = new Map();
  const db = ctx && ctx.libraryDb;
  if (!ctx.dataRoot || !db || typeof db.textStamps !== 'function' || typeof db.textsFor !== 'function') return out;
  try {
    const stamps = await db.textStamps();
    const dir = textDir(ctx.dataRoot);
    const wanted = (rows || []).filter((row) => keepsText(row) && stamps.has(row.id));
    if (!wanted.length) return out;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const present = new Set(fs.readdirSync(dir));
    const fileOf = (row) => `${row.id}-${Math.round(Number(stamps.get(row.id)) || 0)}.txt`;
    const missing = wanted.filter((row) => !present.has(fileOf(row)));
    const texts = missing.length ? await db.textsFor(missing.map((row) => row.id), MAX_TEXT_CHARS) : new Map();
    for (const row of wanted) {
      const name = fileOf(row);
      if (!present.has(name)) {
        const text = texts.get(row.id);
        if (!text) continue; // nothing in it
        fs.writeFileSync(path.join(dir, name), text, { mode: 0o600 });
        for (const old of present) if (old.startsWith(`${row.id}-`) && old !== name) fs.rmSync(path.join(dir, old), { force: true });
      }
      out.set(row.id, path.join(dir, name));
    }
  } catch { /* the rows go without their text */ }
  return out;
}

/**
 * An item's ink as its notes file holds it: a <paper> (or a web <page>) with each highlight as <highlights> shows one
 * (./highlights.cjs highlightXml), in page order, the person's notes word for word; '' when it has none. `inkRoot`, the
 * annotations folder, is where a box's picture is found from.
 */
function inkText(row, ink, inkRoot = '') {
  const list = [...marksOf(ink, inkRoot), ...webMarksOf(ink, inkRoot)];
  if (!list.length) return '';
  const head = row.type === 'pdf' || !row.url
    ? `<paper name="${attrOf(row.name, 200)}" path="${attrOf(row.path, 4096)}">`
    : `<page source="web" title="${attrOf(row.name, 200)}" address="${attrOf(row.url, 4096)}"${row.path ? ` path="${attrOf(row.path, 4096)}"` : ''}>`;
  return `${head}\n${list.map(highlightXml).join('')}${head.startsWith('<paper') ? '</paper>' : '</page>'}\n`;
}

// A file's contents as a hash, by its path, size and time: a pdf added twice is found once per change.
const hashes = new Map();
function contentHash(file) {
  const stat = fs.statSync(file);
  const key = `${file}\0${stat.size}\0${stat.mtimeMs}`;
  if (!hashes.has(key)) hashes.set(key, createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
  return hashes.get(key);
}

/**
 * Where each of `rows` has its ink → Map row id → { file, row }, `row` the one the ink was drawn on: its own
 * (store/library.cjs inkFileOf), else, for a pdf, that of another of `rows` that is the same file at another path (a
 * paper added twice, 2026-10-23): the person's highlights are on the paper, whichever copy they drew them on. A row with
 * neither is not in it.
 */
function inkFiles(ctx, rows) {
  const out = new Map();
  if (!ctx || !ctx.dataRoot) return out;
  const pdfs = [];
  for (const row of rows || []) {
    let file = null;
    try { file = inkFileOf(ctx, row); } catch { /* none */ }
    if (file) out.set(row.id, { file, row });
    if (row && row.type === 'pdf' && row.path) pdfs.push(row);
  }
  const sizeOf = (row) => { try { return fs.statSync(row.path).size; } catch { return -1; } };
  const inked = pdfs.filter((row) => out.has(row.id)).map((row) => ({ row, size: sizeOf(row) })).filter((one) => one.size > 0);
  if (!inked.length) return out;
  for (const row of pdfs) {
    if (out.has(row.id)) continue;
    const size = sizeOf(row);
    if (size <= 0) continue;
    try {
      const twin = inked.find((one) => one.size === size && path.resolve(one.row.path) !== path.resolve(row.path) && contentHash(one.row.path) === contentHash(row.path));
      if (twin) out.set(row.id, out.get(twin.row.id));
    } catch { /* unreadable: none */ }
  }
  return out;
}

/** `row`'s ink as inkFiles finds it (`files`, its map), or null. */
function readInkOf(files, row) {
  const held = row && files.get(row.id);
  if (!held) return null;
  try { return JSON.parse(fs.readFileSync(held.file, 'utf8')); } catch { return null; }
}

/**
 * The notes files of `rows` that have ink (inkFiles: a paper added twice has its copy's) → Map row id → absolute path,
 * each naming the copy the highlights are on, the one a note is cited by: there they are drawn when it is opened. A file is written when the ink is newer than the one there (its name carries the ink file's time), and older ones of the row go, as sourceTexts does. Best effort:
 * a row whose ink cannot be read goes without its `notes`.
 */
async function noteTexts(ctx, rows) {
  const out = new Map();
  if (!ctx || !ctx.dataRoot) return out;
  const dir = notesDir(ctx.dataRoot), inkRoot = path.join(ctx.dataRoot, 'annotations');
  const files = inkFiles(ctx, rows);
  let present = null;
  for (const row of rows || []) {
    try {
      const held = files.get(row && row.id);
      if (!held) continue;
      const { file } = held;
      const name = `${row.id}-${Math.round(fs.statSync(file).mtimeMs)}.txt`;
      if (!present) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); present = new Set(fs.readdirSync(dir)); }
      if (!present.has(name)) {
        for (const old of present) if (old.startsWith(`${row.id}-`)) { fs.rmSync(path.join(dir, old), { force: true }); present.delete(old); }
        const text = inkText(held.row, JSON.parse(fs.readFileSync(file, 'utf8')), inkRoot);
        if (!text) continue; // ink with no highlight left
        fs.writeFileSync(path.join(dir, name), text, { mode: 0o600 });
        present.add(name);
      }
      out.set(row.id, path.join(dir, name));
    } catch { /* this row goes without its notes */ }
  }
  return out;
}

/**
 * What one answer's raw events say Chat read → Set of openedKey. Claude Code: Read's file, Grep's when it is a file, and
 * WebFetch's address. Codex: a command that names a file among `known` (paths, each as it is or with its spaces
 * escaped). A kept text file counts as its source (`texts`: text path → the source's path or address). `full`: what the
 * context already held whole (the notes the documents mention).
 */
function openedBy(events, { known = [], texts = new Map(), full = [] } = {}) {
  const out = new Set(full.filter(Boolean).map(openedKey));
  const add = (where) => {
    if (!where) return;
    const resolved = /^https?:\/\//i.test(where) ? where : path.resolve(String(where));
    out.add(openedKey(texts.get(resolved) || resolved));
  };
  for (const event of events || []) {
    for (const call of toolCallsOf(event)) {
      const input = call.input && typeof call.input === 'object' ? call.input : null;
      if (!input) continue;
      if (call.name === 'Read' && typeof input.file_path === 'string') add(input.file_path);
      else if (call.name === 'Grep' && typeof input.path === 'string' && /\.\w{1,8}$/.test(input.path)) add(input.path);
      else if (call.name === 'WebFetch' && typeof input.url === 'string') add(input.url);
      else if (call.name === 'command' && typeof input.command === 'string') {
        for (const file of [...known, ...texts.keys()]) {
          if (file && (input.command.includes(file) || input.command.includes(file.replace(/([ '"()&])/g, '\\$1')))) add(file);
        }
      }
    }
  }
  return out;
}

/** A page's readable text, fetched without cookies; null when it is not an html page or cannot be had. */
async function fetchPageText(url, { fetch = globalThis.fetch } = {}) {
  if (!/^https?:\/\//i.test(url) || typeof fetch !== 'function') return null;
  try {
    const response = await fetch(url, { redirect: 'follow', credentials: 'omit', headers: { accept: 'text/html' }, signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) });
    if (!response.ok || !/html/i.test(response.headers.get('content-type') || '')) return null;
    const html = (await response.text()).slice(0, MAX_PAGE_BYTES);
    const text = require('../connect/gmail.cjs').htmlText(html);
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

/**
 * Keeps the text of each page among `rows` known by its address alone that Chat read (`opened`, openedBy) and that has
 * none kept yet, so it can be checked and read again. → how many were kept.
 */
async function keepPageTexts(ctx, rows, opened, { fetch = globalThis.fetch } = {}) {
  const db = ctx && ctx.libraryDb;
  if (!db || typeof db.setText !== 'function' || !opened || !opened.size) return 0;
  const pages = (rows || []).filter((row) => row.type === 'website' && !row.path && row.url && opened.has(openedKey(row.url)));
  if (!pages.length) return 0;
  const stamps = await db.textStamps().catch(() => new Map());
  let kept = 0;
  await Promise.all(pages.filter((row) => !stamps.has(row.id)).map(async (row) => {
    const text = await fetchPageText(row.url, { fetch });
    if (text) { await db.setText(row.id, text, Date.now()).catch(() => {}); kept += 1; }
  }));
  return kept;
}

module.exports = { sourceTexts, noteTexts, inkText, inkFiles, readInkOf, openedBy, openedKey, keepsText, keepPageTexts, fetchPageText, textDir, notesDir, MAX_TEXT_CHARS };
