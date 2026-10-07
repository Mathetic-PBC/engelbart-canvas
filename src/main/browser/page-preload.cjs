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
// MATH-54 build 3a (2026-10-06): an @bart turn with the page in front asks for the selection as it is now
// (`engelbart-page:selection`): its quote and about PAGE_TEXT characters of the page's text around it, kept nowhere. A
// page keeps its selection while the person types in the document (another webContents; checked on Electron 44), so it
// is read as it stands, not remembered. A selection that starts or ends inside a word is taken to the whole word, for
// both (snapWords): what began at "he futur" is "the future".
// MATH-70 build 1 (2026-10-07): boxes. Given a rectangle drawn over the page (main's drawing layer), it says what the box
// is kept by (chooseAnchor: the element under it; fractionsOf its rectangle) and what text is under it, then finds each
// of the page's boxes again on load and reflow (refind) and tells main where they are, for main to draw them with an
// inserted html::after rule (boxes.cjs): the page's DOM is still never changed. A click on a box's edge selects it
// (boxAt) and goes no further into the page. It tells main whether a text field has the keyboard, so ⌥ stays the field's.
//
// Sandboxed, this can require only 'electron'. The finding is plain functions over text, exported below for the tests
// when Node loads this file; in a page, `module` is no CommonJS module and the page part runs instead.

const CHANNELS = Object.freeze({
  marks: 'engelbart-page:marks', quote: 'engelbart-page:quote', add: 'engelbart-page:add', selection: 'engelbart-page:selection',
  // boxes (MATH-70 build 1): main asks where a box drawn over the page is (box: anchor and text, answered with its nonce),
  // gives the page's boxes (boxSet), one more (boxAdd) or one fewer (boxRemove), and which is selected (boxSelect, boxHit:
  // a click on the drawing layer); the page says where its boxes are now (boxes) and whether a text field has the keyboard
  // (editing).
  box: 'engelbart-page:box', boxes: 'engelbart-page:boxes', boxSet: 'engelbart-page:box-set', boxAdd: 'engelbart-page:box-add',
  boxRemove: 'engelbart-page:box-remove', boxSelect: 'engelbart-page:box-select', boxHit: 'engelbart-page:box-hit', editing: 'engelbart-page:editing',
});
const HIGHLIGHT = 'engelbart-web-mark'; // the ::highlight() name main's insertCSS styles
const CONTEXT = 32; // characters of prefix and of suffix a new quote keeps
const MAX_EXACT = 5000; // a longer selection is not highlighted (views.cjs says the same)
const MAX_AFFIX = 64;
const PAGE_TEXT = 4000; // characters of the page's text a live selection comes with, itself included
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'SELECT', 'OPTION']);
const SPACE = /\s/;
const BOX_TEXT = 2000; // characters of the page's text under a box (boxes.cjs TEXT_MAX)
const ANCHOR_TEXT = 80; // characters of the anchor element's own text kept to check it again (boxes.cjs)
const HOLD = 0.6; // an element holds a box when this share of the box is inside it
const MEDIA = new Set(['img', 'svg', 'canvas', 'video', 'picture', 'figure', 'table']); // preferred as a box's anchor
const EDGE = 8; // pixels either side of a box's edge that a click selects it by

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

// A letter, a digit or a joining mark; an apostrophe between two letters ("don't") is inside the word too.
const LETTER = /[\p{L}\p{N}\p{M}_]/u;
const inWord = (text, i) => i >= 0 && i < text.length && (LETTER.test(text[i]) || (/['\u2019]/.test(text[i]) && LETTER.test(text[i - 1] || '') && LETTER.test(text[i + 1] || '')));

/**
 * Characters [start, end) of the text taken out to whole words: a start inside a word goes back to its first letter, an
 * end inside one on to its last. Only within the text node each end is in: two nodes run together with no space between
 * them (a block's last word and the next block's first) are not one word.
 */
function snapWords({ text, segs }, start, end) {
  if (!segs.length || end <= start) return { start, end };
  const a = segAt(segs, start), b = segAt(segs, end - 1);
  const first = a.start, last = b.start + b.map.length;
  while (start > first && inWord(text, start - 1) && inWord(text, start)) start -= 1;
  while (end < last && inWord(text, end - 1) && inWord(text, end)) end += 1;
  return { start, end };
}

/**
 * A selection from (seg `from`, offset `fromRaw` in its node) to (seg `to`, `toRaw`) → its quote, whitespace at either end
 * left out and each end taken to the whole word (snapWords): { quote: { exact, prefix, suffix }, start, end }, or null
 * when it holds no text or more than MAX_EXACT.
 */
function quoteOf(map, from, fromRaw, to, toRaw) {
  const { text, segs } = map;
  let start = segs[from].start + before(segs[from], fromRaw), end = segs[to].start + before(segs[to], toRaw);
  while (start < end && text[start] === ' ') start += 1;
  while (end > start && text[end - 1] === ' ') end -= 1;
  if (end <= start) return null;
  ({ start, end } = snapWords(map, start, end));
  if (end - start > MAX_EXACT) return null;
  return { quote: { exact: text.slice(start, end), prefix: text.slice(Math.max(0, start - CONTEXT), start), suffix: text.slice(end, end + CONTEXT) }, start, end };
}

/**
 * The page's text around characters [start, end): about `size` characters, the passage in the middle of them (a passage
 * longer than that, with a little on each side), cut at spaces so no word is broken at either edge.
 */
function textAround(text, start, end, size = PAGE_TEXT) {
  const side = Math.max(200, Math.floor((size - (end - start)) / 2));
  let from = Math.max(0, start - side), to = Math.min(text.length, end + side);
  if (from > 0) { const space = text.indexOf(' ', from); from = space >= 0 && space < start ? space + 1 : from; }
  if (to < text.length) { const space = text.lastIndexOf(' ', to); to = space >= end ? space : to; }
  return text.slice(from, to).trim();
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

// ------------------------------------------------------------------------------------------------- boxes (MATH-70)
// A box is kept by the element under it when it was drawn (its anchor: a selector, the tag, an image's src and the first
// ANCHOR_TEXT characters of its text) and where in that element's rectangle it was, as fractions; and by where it was in
// the document, with how wide the page was. Found again: the selector, when what it finds is still that element (same
// tag, src and much the same text); else an image with the same src; else the document coordinates, when the page is
// about as wide as it was; else it is not found and not drawn.

const area = (r) => Math.max(0, r.width) * Math.max(0, r.height);
function overlap(a, b) {
  const w = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left), h = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * The element a box is kept by: of `candidates` ([{ tag, rect: { left, top, width, height } }], the elements under the box's
 * centre), the smallest that holds most of the box (HOLD), a picture, figure or table before anything else; null for none.
 */
function chooseAnchor(candidates, box) {
  const size = area(box);
  if (!(size > 0)) return null;
  const held = (candidates || []).filter((c) => c && c.rect && area(c.rect) > 0 && overlap(c.rect, box) / size >= HOLD);
  const media = held.filter((c) => MEDIA.has(c.tag));
  return (media.length ? media : held).reduce((best, c) => (!best || area(c.rect) < area(best.rect) ? c : best), null);
}

/** Where `box` is in `rect`, as fractions of it: { x, y, w, h }. */
const fractionsOf = (box, rect) => ({ x: (box.left - rect.left) / rect.width, y: (box.top - rect.top) / rect.height, w: box.width / rect.width, h: box.height / rect.height });

/** A box's fractions placed in `rect` (an element's, in document coordinates) → { x, y, w, h }. */
const placeIn = (box, rect) => ({ x: rect.x + box.x * rect.w, y: rect.y + box.y * rect.h, w: box.w * rect.w, h: box.h * rect.h });

/** Whether `found` ({ tag, src, text }) is the element `anchor` describes: the same tag, the same src, much the same text. */
function sameElement(anchor, found) {
  if (!anchor || !found || found.tag !== anchor.tag) return false;
  if (anchor.src && found.src !== anchor.src) return false;
  const a = spaced(anchor.text).trim(), b = spaced(found.text).trim().slice(0, ANCHOR_TEXT);
  return !a || a === b || alike(a, b) >= 0.6;
}

/**
 * Where box `box` ({ anchor, doc }) is on the page now: { how, el }. `look`: { bySelector(selector) → element, describe(el)
 * → { tag, src, text }, bySrc(src) → an image, width (the page's width now) }. `how` is 'selector', 'src', 'doc' (its
 * document coordinates, `el` null) or 'none'.
 */
function refind(box, look) {
  const anchor = box && box.anchor;
  if (anchor && anchor.selector) {
    let el = null;
    try { el = look.bySelector(anchor.selector); } catch { el = null; }
    if (el && sameElement(anchor, look.describe(el))) return { how: 'selector', el };
  }
  if (anchor && anchor.src) {
    const el = look.bySrc(anchor.src);
    if (el) return { how: 'src', el };
  }
  const doc = box && box.doc;
  if (doc && Number.isFinite(look.width) && Math.abs(look.width - doc.width) <= Math.max(16, doc.width * 0.05)) return { how: 'doc', el: null };
  return { how: 'none', el: null };
}

/**
 * The box at (x, y) of `rects` ([{ id, x, y, w, h }]): one whose edge is within `band` of the point, or with `inside`, one
 * the point is in; the smallest of several. → its id, or null.
 */
function boxAt(rects, x, y, { inside = false, band = EDGE } = {}) {
  let best = null;
  for (const r of rects || []) {
    const out = x >= r.x - band && x <= r.x + r.w + band && y >= r.y - band && y <= r.y + r.h + band;
    if (!out) continue;
    const deep = x > r.x + band && x < r.x + r.w - band && y > r.y + band && y < r.y + r.h - band;
    if (deep && !inside) continue;
    if (!best || r.w * r.h < best.w * best.h) best = r;
  }
  return best ? best.id : null;
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
      if (!m || !m.quote || m.box) continue; // a box is no passage (boxes, below)
      const at = anchor(map.text, m.quote), range = at && domRange(rangeOf(map, at.start, at.end));
      if (range) painted.set(m.id, range); else missed.push(m);
    }
    paint();
    return missed;
  }

  /**
   * The selection's quote, Range and the page's text around it (textAround), or null: no selection, none in this page's
   * text, or longer than MAX_EXACT.
   */
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
    return got && { quote: got.quote, range: domRange(rangeOf(map, got.start, got.end)), pageText: textAround(map.text, got.start, got.end) };
  }

  ipcRenderer.on(CHANNELS.quote, (_event, nonce) => {
    let got = null;
    try { got = selected(); } catch { got = null; }
    pending = got ? { nonce, range: got.range } : null;
    ipcRenderer.send(CHANNELS.quote, { nonce, quote: got ? got.quote : null });
  });
  // the selection as it is now, for an @bart turn: nothing is tinted or kept
  ipcRenderer.on(CHANNELS.selection, (_event, nonce) => {
    let got = null;
    try { got = selected(); } catch { got = null; }
    ipcRenderer.send(CHANNELS.selection, { nonce, quote: got ? got.quote : null, pageText: got ? got.pageText : '' });
  });
  ipcRenderer.on(CHANNELS.add, (_event, value) => {
    const { nonce, mark } = value || {};
    if (!mark || typeof mark.id !== 'string') return;
    const range = pending && pending.nonce === nonce ? pending.range : null;
    pending = null;
    if (range) { painted.set(mark.id, range); paint(); } else place([mark]);
  });

  /* ------------------------------------------------------------------------------------------- boxes (MATH-70) */
  const boxes = new Map(); // mark id → { box, el, how }
  let picked = null, sent = '', measuring = 0, lastRects = [];
  const resized = typeof ResizeObserver === 'function' ? new ResizeObserver(() => schedule()) : null;
  const describe = (el) => ({
    tag: String(el.tagName || '').toLowerCase(),
    src: (el.getAttribute && el.getAttribute('src')) || '',
    text: spaced(el.textContent || (el.getAttribute && (el.getAttribute('alt') || el.getAttribute('aria-label'))) || '').trim().slice(0, ANCHOR_TEXT),
  });
  const unique = (selector) => { try { return document.querySelectorAll(selector).length === 1; } catch { return false; } };
  /** A selector that finds `el`: its id when that is the page's only one, else tag:nth-of-type steps up to one that has. */
  function selectorOf(el) {
    const steps = [];
    for (let at = el; at && at.nodeType === 1; at = at.parentElement) {
      const tag = at.tagName.toLowerCase();
      if (at.id && typeof CSS !== 'undefined' && CSS.escape && unique(`#${CSS.escape(at.id)}`)) { steps.unshift(`#${CSS.escape(at.id)}`); break; }
      if (tag === 'html' || tag === 'body') { steps.unshift(tag); break; }
      let n = 1;
      for (let sib = at.previousElementSibling; sib; sib = sib.previousElementSibling) if (sib.tagName === at.tagName) n += 1;
      steps.unshift(`${tag}:nth-of-type(${n})`);
    }
    return steps.join(' > ').slice(0, 1000);
  }
  const look = () => ({
    bySelector: (selector) => document.querySelector(selector),
    describe,
    bySrc: (src) => { for (const img of document.images) if (img.getAttribute('src') === src) return img; return null; },
    width: document.documentElement ? document.documentElement.clientWidth : 0,
  });
  const docRect = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height }; };
  // html::after is placed in html's containing block: the document's origin, unless html is positioned itself
  function origin() {
    const html = document.documentElement;
    if (!html || getComputedStyle(html).position === 'static') return { x: 0, y: 0 };
    const r = html.getBoundingClientRect();
    return { x: r.left + window.scrollX + html.clientLeft, y: r.top + window.scrollY + html.clientTop };
  }
  function findBox(held) {
    if (held.el && held.el.isConnected) return;
    if (held.el && resized) resized.unobserve(held.el);
    const got = refind(held.box, look());
    held.el = got.el;
    held.how = got.how;
    if (held.el && resized) resized.observe(held.el);
  }
  /** Each box found and measured; main is told where they are now (in html's containing block), when that changed. */
  function measure() {
    measuring = 0;
    const at = origin(), rects = [], missing = [];
    for (const [id, held] of boxes) {
      findBox(held);
      let r = null;
      if (held.el) { const e = docRect(held.el); if (e.w > 0 && e.h > 0) r = placeIn(held.box, e); }
      else if (held.how === 'doc') r = held.box.doc;
      if (r) rects.push({ id, x: r.x - at.x, y: r.y - at.y, w: r.w, h: r.h }); else missing.push(id);
    }
    if (picked && !boxes.has(picked)) picked = null;
    const html = document.documentElement;
    const size = html ? { width: html.scrollWidth, height: html.scrollHeight } : null;
    const round = (n) => Math.round(n * 10) / 10;
    const report = { rects: rects.map((r) => ({ id: r.id, x: round(r.x), y: round(r.y), w: round(r.w), h: round(r.h) })), selected: picked, size, missing };
    lastRects = report.rects.map((r) => ({ ...r, x: r.x + at.x, y: r.y + at.y }));
    const text = JSON.stringify(report);
    if (text === sent) return;
    sent = text;
    ipcRenderer.send(CHANNELS.boxes, report);
  }
  function schedule() { if (!measuring) measuring = setTimeout(measure, 50); }
  function setBoxes(marks) {
    for (const held of boxes.values()) if (held.el && resized) resized.unobserve(held.el);
    boxes.clear();
    for (const m of marks) if (m && typeof m.id === 'string' && m.box) boxes.set(m.id, { box: m.box, el: null, how: 'none' });
    schedule();
  }
  /**
   * Where a box drawn at `rect` (the viewport's CSS pixels) is: { box: { x, y, w, h (fractions of its anchor), anchor, doc },
   * text: the page's text under it, at most BOX_TEXT characters }.
   */
  function boxHere(rect) {
    const view = { left: rect.x, top: rect.y, width: rect.w, height: rect.h };
    const stack = document.elementsFromPoint(rect.x + rect.w / 2, rect.y + rect.h / 2);
    const chosen = chooseAnchor(stack.map((el) => ({ el, tag: String(el.tagName || '').toLowerCase(), rect: el.getBoundingClientRect() })), view);
    const doc = { x: rect.x + window.scrollX, y: rect.y + window.scrollY, w: rect.w, h: rect.h, width: document.documentElement.clientWidth };
    const box = chosen ? { ...fractionsOf(view, chosen.rect), anchor: { selector: selectorOf(chosen.el), ...describe(chosen.el) }, doc } : { x: 0, y: 0, w: 1, h: 1, anchor: null, doc };
    return { box, text: textUnder(view) };
  }
  /** The words whose middle is inside `view` (viewport pixels), in the page's order, and the alt text of pictures under it. */
  function textUnder(view) {
    const parts = [];
    let length = 0;
    const range = document.createRange();
    for (const node of textNodes()) {
      if (length >= BOX_TEXT) break;
      const parent = node.parentElement;
      if (!parent || !overlap(parent.getBoundingClientRect(), view)) continue;
      const words = [];
      for (const match of node.data.matchAll(/\S+/g)) {
        try { range.setStart(node, match.index); range.setEnd(node, match.index + match[0].length); } catch { continue; }
        const r = range.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        if (r.width && cx >= view.left && cx <= view.left + view.width && cy >= view.top && cy <= view.top + view.height) words.push(match[0]);
      }
      if (words.length) { parts.push(words.join(' ')); length += words.join(' ').length + 1; }
    }
    for (const img of document.images) {
      const alt = spaced(img.getAttribute('alt')).trim();
      if (alt && overlap(img.getBoundingClientRect(), view) > 0) parts.push(`[image: ${alt}]`);
    }
    return parts.join(' ').slice(0, BOX_TEXT);
  }
  const select = (id) => { picked = id && boxes.has(id) ? id : null; sent = ''; measure(); };

  ipcRenderer.on(CHANNELS.box, (_event, value) => {
    const { nonce, rect } = value || {};
    let got = null;
    try { got = rect && [rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) && rect.w > 0 && rect.h > 0 ? boxHere(rect) : null; } catch { got = null; }
    ipcRenderer.send(CHANNELS.box, { nonce, box: got ? got.box : null, text: got ? got.text : '' });
  });
  ipcRenderer.on(CHANNELS.boxSet, (_event, marks) => setBoxes(Array.isArray(marks) ? marks : []));
  ipcRenderer.on(CHANNELS.boxAdd, (_event, mark) => { if (mark && typeof mark.id === 'string' && mark.box) { boxes.set(mark.id, { box: mark.box, el: null, how: 'none' }); schedule(); } });
  ipcRenderer.on(CHANNELS.boxRemove, (_event, id) => { const held = boxes.get(id); if (held && held.el && resized) resized.unobserve(held.el); boxes.delete(id); schedule(); });
  ipcRenderer.on(CHANNELS.boxSelect, (_event, id) => select(id));
  ipcRenderer.on(CHANNELS.boxHit, (_event, point) => {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    select(boxAt(lastRects, point.x + window.scrollX, point.y + window.scrollY, { inside: true }));
  });
  // A click on a box's edge selects it, and goes no further into the page; anywhere else, what was selected is not.
  let swallow = false;
  window.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || !boxes.size) return;
    const id = boxAt(lastRects, event.clientX + window.scrollX, event.clientY + window.scrollY);
    if (id) { event.preventDefault(); event.stopImmediatePropagation(); swallow = true; select(id); } else if (picked) select(null);
  }, true);
  for (const name of ['mouseup', 'click']) window.addEventListener(name, (event) => { if (!swallow) return; event.preventDefault(); event.stopImmediatePropagation(); if (name === 'click') swallow = false; }, true);
  // the page reflows, scrolls inside a box of its own, or changes size: the boxes are measured again
  window.addEventListener('resize', schedule);
  document.addEventListener('scroll', (event) => { if (boxes.size && event.target !== document) schedule(); }, true);
  const watchRoot = () => { if (!resized) return; if (document.documentElement) resized.observe(document.documentElement); if (document.body) resized.observe(document.body); };

  // Whether a text field has the keyboard: ⌥ is then the field's (views.cjs draws no box). A frame's own field is not seen
  // from here, so a frame with the keyboard counts as one.
  let editing = false;
  const isField = (el) => {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = String(el.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'select' || tag === 'iframe') return true;
    return tag === 'input' && !/^(button|checkbox|radio|submit|reset|image|range|color|file|hidden)$/i.test(el.type || '');
  };
  const focusChanged = () => setTimeout(() => {
    const now = isField(document.activeElement);
    if (now !== editing) { editing = now; ipcRenderer.send(CHANNELS.editing, now); }
  }, 0);
  window.addEventListener('focusin', focusChanged, true);
  window.addEventListener('focusout', focusChanged, true);

  const load = () => ipcRenderer.invoke(CHANNELS.marks).then((marks) => {
    const list = Array.isArray(marks) ? marks : [];
    waiting = place(list);
    watchRoot();
    setBoxes(list);
    focusChanged();
  }, () => {});
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load, { once: true }); else void load();
  // text a page writes after its document has loaded: what was not found is looked for once more
  window.addEventListener('load', () => { setTimeout(() => { if (waiting.length) waiting = place(waiting); for (const held of boxes.values()) if (!held.el) held.how = 'none'; schedule(); }, 0); }, { once: true });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && typeof require === 'function') runInPage();
else if (typeof module === 'object' && module && module.exports) module.exports = { CHANNELS, HIGHLIGHT, CONTEXT, MAX_EXACT, MAX_AFFIX, PAGE_TEXT, BOX_TEXT, textMap, rangeOf, snapWords, quoteOf, textAround, anchor, alike, chooseAnchor, fractionsOf, placeIn, sameElement, refind, boxAt };
