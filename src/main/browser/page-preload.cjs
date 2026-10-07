'use strict';
// What runs in every Stage page (MATH-54 build 2, 2026-10-06): the tints of the page's web highlights. Registered once on
// the Stage's browsing session (views.cjs joinSession), so a tab a page opened (adopt) has it as a typed one does. It runs
// in the page's isolated world, sandboxed, and gives the page nothing: no contextBridge, no globals, and the page's DOM is
// never changed. Tints are CSS Custom Highlights (`CSS.highlights`, the document's one registry: the page's own scripts
// can see them there) over Ranges of the page's text, styled by main's insertCSS.
//
// A highlight is kept by its quote, { exact, prefix, suffix }, as a W3C TextQuoteSelector: the passage and some words on
// each side, in the page's text with every run of whitespace one space. On load the page's highlights come from main
// (`engelbart-page:marks`) and each is found again by its quote: where the passage is more than once, the words around it
// pick which. One not found is skipped, for now. The right-click menu's Highlight asks for the selection's quote
// (`engelbart-page:quote`, answered with main's nonce) and, once main has saved it, tints it (`engelbart-page:add`).
//
// Sandboxed, this can require only 'electron'. The finding is plain functions over text, exported below for the tests
// when Node loads this file; in a page, `module` is no CommonJS module and the page part runs instead.

const CHANNELS = Object.freeze({ marks: 'engelbart-page:marks', quote: 'engelbart-page:quote', add: 'engelbart-page:add' });
const HIGHLIGHT = 'engelbart-web-mark'; // the ::highlight() name main's insertCSS styles
const CONTEXT = 32; // characters of prefix and of suffix a new quote keeps
const MAX_EXACT = 5000; // a longer selection is not highlighted (views.cjs says the same)
const MAX_AFFIX = 64;
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'SELECT', 'OPTION']);
const SPACE = /\s/;

/**
 * Text nodes ([{ data }]) → the page's text with each run of whitespace one space, none at its start: { text, segs },
 * a seg { node, start, map } per node with text, `map[k]` the offset in node.data of its k-th character in `text`.
 */
function textMap(nodes) {
  let text = '', space = true; // nothing yet: leading whitespace goes
  const segs = [];
  for (const node of nodes) {
    const data = String((node && node.data) || '');
    const map = [];
    let out = '';
    for (let i = 0; i < data.length; i += 1) {
      if (SPACE.test(data[i])) {
        if (space) continue;
        space = true; out += ' ';
      } else {
        space = false; out += data[i];
      }
      map.push(i);
    }
    if (!out) continue;
    segs.push({ node, start: text.length, map });
    text += out;
  }
  return { text, segs };
}

/** How many of a seg's characters start before `raw` in its node. */
function before(seg, raw) {
  let lo = 0, hi = seg.map.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (seg.map[mid] < raw) lo = mid + 1; else hi = mid; }
  return lo;
}

/** The seg holding character `index` of the text (the last one for the text's end). */
function segAt(segs, index) {
  let lo = 0, hi = segs.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (segs[mid].start <= index) lo = mid; else hi = mid - 1; }
  return segs[lo];
}

/** Characters [start, end) of the text → where they are in the nodes: { startNode, startOffset, endNode, endOffset }. */
function rangeOf({ segs }, start, end) {
  if (!segs.length || end <= start) return null;
  const a = segAt(segs, start), b = segAt(segs, end - 1);
  return { startNode: a.node, startOffset: a.map[start - a.start], endNode: b.node, endOffset: b.map[end - 1 - b.start] + 1 };
}

/**
 * A selection from (seg `from`, offset `fromRaw` in its node) to (seg `to`, `toRaw`) → its quote, whitespace at either end
 * left out: { quote: { exact, prefix, suffix }, start, end }, or null when it holds no text or more than MAX_EXACT.
 */
function quoteOf({ text, segs }, from, fromRaw, to, toRaw) {
  let start = segs[from].start + before(segs[from], fromRaw), end = segs[to].start + before(segs[to], toRaw);
  while (start < end && text[start] === ' ') start += 1;
  while (end > start && text[end - 1] === ' ') end -= 1;
  if (end <= start || end - start > MAX_EXACT) return null;
  return { quote: { exact: text.slice(start, end), prefix: text.slice(Math.max(0, start - CONTEXT), start), suffix: text.slice(end, end + CONTEXT) }, start, end };
}

/** A quote as main keeps it, spaced as the text is: each run of whitespace one space. */
const spaced = (value) => String(value || '').replace(/\s+/g, ' ');

/** How alike two short strings are, 0–1: the share of their pairs of letters they have in common (Dice). */
function alike(a, b) {
  if (!a || !b) return 0;
  const pairs = new Map();
  for (let i = 0; i < a.length - 1; i += 1) { const p = a.slice(i, i + 2); pairs.set(p, (pairs.get(p) || 0) + 1); }
  let shared = 0;
  for (let i = 0; i < b.length - 1; i += 1) { const p = b.slice(i, i + 2), n = pairs.get(p) || 0; if (n) { shared += 1; pairs.set(p, n - 1); } }
  return (2 * shared) / Math.max(1, a.length - 1 + b.length - 1);
}

/** How well the text around an occurrence [at, end) fits the quote's prefix and suffix. */
function fit(text, at, end, prefix, suffix) {
  const slack = 8; // a word put in or taken out beside the passage
  const near = text.slice(Math.max(0, at - prefix.length - slack), at), after = text.slice(end, end + suffix.length + slack);
  let tail = 0;
  while (tail < prefix.length && tail < near.length && prefix[prefix.length - 1 - tail] === near[near.length - 1 - tail]) tail += 1;
  let head = 0;
  while (head < suffix.length && head < after.length && suffix[head] === after[head]) head += 1;
  return tail + head + alike(prefix, near) * prefix.length + alike(suffix, after) * suffix.length;
}

/**
 * Where a quote is in the text: { start, end }, or null when its passage is not there. Where the passage is more than
 * once, the occurrence whose surroundings best fit its prefix and suffix (fit); the first of equals.
 */
function anchor(text, quote) {
  const exact = spaced(quote && quote.exact).trim();
  if (!exact) return null;
  const prefix = spaced(quote.prefix), suffix = spaced(quote.suffix);
  let best = null, bestFit = -1;
  for (let at = text.indexOf(exact); at >= 0; at = text.indexOf(exact, at + 1)) {
    const score = fit(text, at, at + exact.length, prefix, suffix);
    if (score > bestFit) { best = { start: at, end: at + exact.length }; bestFit = score; }
  }
  return best;
}

// ------------------------------------------------------------------------------------------------- in the page

function runInPage() {
  const { ipcRenderer } = require('electron');
  const painted = new Map(); // mark id → Range
  let waiting = []; // marks not found yet: tried again once the page has loaded
  let pending = null; // { nonce, range }: the selection main asked for, until it says it was saved

  const registry = () => (typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function' ? CSS.highlights : null);
  function paint() {
    const h = registry();
    if (!h) return;
    if (painted.size) h.set(HIGHLIGHT, new Highlight(...painted.values()));
    else h.delete(HIGHLIGHT);
  }

  function textNodes() {
    const root = document.body || document.documentElement;
    if (!root) return [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (node) => (node.parentElement && SKIP.has(node.parentElement.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
    const out = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) out.push(node);
    return out;
  }

  function domRange(at) {
    if (!at) return null;
    const range = document.createRange();
    try { range.setStart(at.startNode, at.startOffset); range.setEnd(at.endNode, at.endOffset); } catch { return null; }
    return range;
  }

  /** Each mark found and tinted; → the ones not found. */
  function place(marks) {
    if (!marks.length) return [];
    const map = textMap(textNodes()), missed = [];
    for (const m of marks) {
      const at = anchor(map.text, m.quote), range = at && domRange(rangeOf(map, at.start, at.end));
      if (range) painted.set(m.id, range); else missed.push(m);
    }
    paint();
    return missed;
  }

  /** The selection's quote and Range, or null: no selection, none in this page's text, or longer than MAX_EXACT. */
  function selected() {
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0), map = textMap(textNodes());
    let from = -1, to = -1;
    for (let i = 0; i < map.segs.length; i += 1) {
      if (!range.intersectsNode(map.segs[i].node)) { if (from >= 0) break; continue; }
      if (from < 0) from = i;
      to = i;
    }
    if (from < 0) return null;
    const a = map.segs[from].node, b = map.segs[to].node;
    const got = quoteOf(map, from, a === range.startContainer ? range.startOffset : 0, to, b === range.endContainer ? range.endOffset : b.data.length);
    return got && { quote: got.quote, range: domRange(rangeOf(map, got.start, got.end)) };
  }

  ipcRenderer.on(CHANNELS.quote, (_event, nonce) => {
    let got = null;
    try { got = selected(); } catch { got = null; }
    pending = got ? { nonce, range: got.range } : null;
    ipcRenderer.send(CHANNELS.quote, { nonce, quote: got ? got.quote : null });
  });
  ipcRenderer.on(CHANNELS.add, (_event, value) => {
    const { nonce, mark } = value || {};
    if (!mark || typeof mark.id !== 'string') return;
    const range = pending && pending.nonce === nonce ? pending.range : null;
    pending = null;
    if (range) { painted.set(mark.id, range); paint(); } else place([mark]);
  });

  const load = () => ipcRenderer.invoke(CHANNELS.marks).then((marks) => { waiting = place(Array.isArray(marks) ? marks : []); }, () => {});
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load, { once: true }); else void load();
  // text a page writes after its document has loaded: what was not found is looked for once more
  window.addEventListener('load', () => { setTimeout(() => { if (waiting.length) waiting = place(waiting); }, 0); }, { once: true });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && typeof require === 'function') runInPage();
else if (typeof module === 'object' && module && module.exports) module.exports = { CHANNELS, HIGHLIGHT, CONTEXT, MAX_EXACT, MAX_AFFIX, textMap, rangeOf, quoteOf, anchor, alike };
