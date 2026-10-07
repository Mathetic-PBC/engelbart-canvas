'use strict';

// A paper downloaded in the person's browser, brought back (MATH-65 build 4). A Zotero item with no pdf opens its DOI's
// page in the default browser (build 3: publishers' bot checks refuse the Stage, and the Stage is never disguised nor
// given the browser's cookies). From then, for 10 minutes, the Downloads folder is watched for a new .pdf: a browser's
// partial download (.crdownload, .download, .part, or Firefox's empty placeholder beside its .part) is passed over until
// it is finished, and a file is only read once its size and time have held still between two looks. Its first two pages'
// text (../context/pdf-text.cjs) must carry the item's DOI or most of its title (pdfMatches); a pdf that matches no item
// waited for is left alone. Several items may be waited for at once: one look at the folder serves them all, and each
// file goes to at most one of them (a DOI before a title, the item clicked last first). A wait ends on a match, after
// 10 minutes, or when the app quits (stopAll), and the chip is told each time (`onWaiting(key, on)`).
// The download itself is never moved, renamed or deleted: `onMatch(item, file)` copies it (./sync.cjs).

const fs = require('node:fs');
const path = require('node:path');
const { titleWords, cleanDoi } = require('./oa.cjs');

const WAIT_MS = 10 * 60_000;
const POLL_MS = 1500;
const PARTIAL_RE = /\.(crdownload|download|part|partial|opdownload)$/i;
const PARTIALS = ['.crdownload', '.download', '.part'];
// Items that are not papers: their page opened in the browser is not waited on for a pdf (unless they have a DOI).
const NOT_PAPERS = new Set(['webpage', 'blogPost', 'forumPost', 'videoRecording', 'audioRecording', 'podcast', 'film', 'tvBroadcast', 'radioBroadcast', 'artwork', 'map', 'computerProgram', 'email', 'instantMessage', 'interview']);

/** Whether `item` (an items.json entry) is a paper whose pdf may be downloaded: it has a DOI, or is a kind that has one. */
const paperLike = (item) => !!item && (!!cleanDoi(item.doi) || !NOT_PAPERS.has(item.itemType));

/** The text of a pdf's first two pages, its lines joined (pdf.js; loaded on first use). */
async function firstPagesText(file) {
  const { readPdfLines } = require('../context/pdf-text.cjs');
  return (await readPdfLines(file, { maxPages: 2 })).map((line) => line.text).join('\n');
}

/**
 * Whether the text of a pdf's first pages is the paper `item` (an items.json entry): its DOI is in it (spaces and line
 * breaks put aside), or most of its title is: the longest run of the title's words found together in the text is the
 * whole title (three words or 15 letters at least), or 70% of its letters and at least three words. → 'doi' | 'title' | ''
 */
function pdfMatches(text, item) {
  const doi = cleanDoi(item && item.doi).toLowerCase();
  const squashed = String(text || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  if (doi && squashed.includes(doi.replace(/\s+/g, ''))) return 'doi';
  // The text's words run together, and the title's: a title broken across lines (or at a hyphen) still reads as one.
  const page = titleWords(text).join('');
  const words = titleWords(item && item.title);
  if (!page || !words.length) return '';
  const whole = words.join('').length;
  let best = { chars: 0, count: 0 };
  for (let from = 0; from < words.length; from += 1) {
    let run = '';
    for (let to = from; to < words.length; to += 1) {
      run += words[to];
      if (!page.includes(run)) break;
      if (run.length > best.chars) best = { chars: run.length, count: to - from + 1 };
    }
  }
  if (best.count === words.length && (words.length >= 3 || whole >= 15)) return 'title'; // "Attention" alone is in any paper
  return best.count >= 3 && best.chars >= 0.7 * whole ? 'title' : '';
}

/**
 * `dir()`: the Downloads folder (app.getPath('downloads')). `onMatch(item, file)` → Promise<truthy when the copy was
 * kept>; `onWaiting(key, on)` as a wait starts and ends. `readText(file)` → its first pages' text (firstPagesText).
 * → { wait(item), stop(key), stopAll(), waiting() → [key], scan() }
 */
function createDownloadWatch({ dir, onMatch, onWaiting = () => {}, readText = firstPagesText, waitMs = WAIT_MS, pollMs = POLL_MS, watch = fs.watch } = {}) {
  const waits = new Map(); // item key → { item, timer, order }
  let clicks = 0; // the order waits were asked for: the latest first when a file could be either's
  let seen = new Map(); // file name → its size:mtime when last looked at (passed over, or examined)
  let pending = new Map(); // file name → its size:mtime at the last look, not yet held still
  let poll = null;
  let watcher = null;
  let scanning = null;
  let again = false;
  let folder = '';

  const tell = (key, on) => { try { onWaiting(key, on); } catch { /* a listener never breaks a wait */ } };
  const folderNow = () => { try { return String((typeof dir === 'function' ? dir() : dir) || ''); } catch { return ''; } };

  function list(at) {
    try { return fs.readdirSync(at); } catch { return []; }
  }
  function signature(file) {
    try { const stat = fs.statSync(file); return stat.isFile() ? { size: stat.size, sig: `${stat.size}:${stat.mtimeMs}` } : null; } catch { return null; }
  }

  // The pdfs in the folder now, as they are: what was there before the first wait is not new.
  function start() {
    folder = folderNow();
    if (!folder) return;
    seen = new Map(); pending = new Map();
    for (const name of list(folder)) {
      if (!/\.pdf$/i.test(name)) continue;
      const got = signature(path.join(folder, name));
      if (got) seen.set(name, got.sig);
    }
    poll = setInterval(() => { void scan(); }, pollMs);
    if (poll && typeof poll.unref === 'function') poll.unref();
    try {
      watcher = watch(folder, { persistent: false }, () => { void scan(); });
      if (watcher && typeof watcher.on === 'function') watcher.on('error', () => { try { watcher.close(); } catch { /* gone */ } watcher = null; });
    } catch { watcher = null; } // the clock alone, then
  }

  function halt() {
    if (poll) clearInterval(poll);
    poll = null;
    if (watcher) { try { watcher.close(); } catch { /* gone */ } }
    watcher = null;
    seen = new Map(); pending = new Map();
  }

  function end(key) {
    const held = waits.get(key);
    if (!held) return false;
    clearTimeout(held.timer);
    waits.delete(key);
    if (!waits.size) halt();
    tell(key, false);
    return true;
  }

  /** The finished pdfs that are new since the last look and have held still since it. */
  function fresh() {
    const out = [];
    const names = list(folder);
    const here = new Set(names);
    for (const name of names) {
      if (!/\.pdf$/i.test(name) || PARTIAL_RE.test(name)) continue;
      if (PARTIALS.some((ext) => here.has(name + ext))) continue; // still being written beside it
      const got = signature(path.join(folder, name));
      if (!got || !got.size) continue; // a placeholder
      if (seen.get(name) === got.sig) continue;
      if (pending.get(name) !== got.sig) { pending.set(name, got.sig); continue; } // look once more: still growing?
      pending.delete(name);
      seen.set(name, got.sig);
      out.push(path.join(folder, name));
    }
    return out;
  }

  /** Whether `file` is one of the papers waited for → the item it is, or null. */
  async function whose(file) {
    let head = '';
    try { const fd = fs.openSync(file, 'r'); try { const b = Buffer.alloc(4); fs.readSync(fd, b, 0, 4, 0); head = b.toString('latin1'); } finally { fs.closeSync(fd); } } catch { return null; }
    if (head !== '%PDF') return null;
    let text = '';
    try { text = await readText(file); } catch { return null; }
    const latest = [...waits.values()].sort((a, b) => b.order - a.order).map((held) => held.item);
    return latest.find((item) => pdfMatches(text, item) === 'doi') || latest.find((item) => pdfMatches(text, item) === 'title') || null;
  }

  /** One look at the folder (a change seen, or the clock); never two at once. */
  function scan() {
    if (scanning) { again = true; return scanning; }
    if (!waits.size || !folder) return Promise.resolve();
    scanning = (async () => {
      do {
        again = false;
        for (const file of fresh()) {
          if (!waits.size) break;
          const item = await whose(file);
          if (!item || !waits.has(item.key)) continue;
          let kept = false;
          try { kept = await onMatch(item, file); } catch { kept = false; }
          if (kept) end(item.key);
        }
      } while (again && waits.size);
    })().finally(() => { scanning = null; });
    return scanning;
  }

  /** Waits for `item`'s pdf (again: its 10 minutes start over). */
  function wait(item) {
    if (!item || !item.key) return false;
    const held = waits.get(item.key);
    if (held) clearTimeout(held.timer);
    if (!waits.size) start();
    const timer = setTimeout(() => end(item.key), waitMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    clicks += 1;
    waits.set(item.key, { item, timer, order: clicks });
    if (!held) tell(item.key, true);
    return true;
  }

  return {
    wait,
    stop: end,
    stopAll() { for (const key of [...waits.keys()]) end(key); halt(); },
    waiting: () => [...waits.keys()],
    scan,
  };
}

module.exports = { createDownloadWatch, pdfMatches, paperLike, firstPagesText, WAIT_MS, POLL_MS };
