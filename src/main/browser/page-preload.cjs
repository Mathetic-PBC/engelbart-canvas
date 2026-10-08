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
// MATH-70 build 2 (2026-10-07): a box is selected by its edge alone, from the page or the drawing layer: a click inside
// one is the page's (a link in it opens). A box drawn is selected. The selected box's handles resize it: a press on one
// takes the drag (mousedown, mouseup and click go no further, as the edge's click), the new rectangle goes to main at most
// once a frame (LIVE_RESIZE) and is kept inside the visible page, and on release its anchor and text are worked out again
// (boxHere) and main takes a new picture and updates the mark (boxResize). Where the selected box is in the viewport goes
// to main as it moves or the page scrolls (boxView, once a frame), for the card beside it. The text under a box is only
// what shows (shows): a word whose centre is in the box and the viewport, whose element is visible (checkVisibility) and
// is what is at that point (elementFromPoint), and the alt text of a picture by the same rule over its visible part. A
// cover with pointer-events:none is not seen by elementFromPoint (a known gap). An inserted rule (main's) gives the
// pointer the handle's cursor; the page's DOM is still never changed.
// MATH-70 build 3 (2026-10-07): a box being resized is reported with where the pointer is (resizing), for main to draw it
// as ⌘⇧4 draws one (boxes.cjs: a flat fill and its size beside the pointer). Over a box's edge, where a click selects it
// (boxAt's band), the pointer is a hand (EDGE_CURSOR); off it, the page's own again.
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
  // build 2: a box resized (invoked: { id, rect, box, text } → { box } or null), the selected box's place in the viewport
  // (boxView), a frame drawn (frame: main's nonce back once the page has painted twice), the cursor over a handle (cursor).
  boxResize: 'engelbart-page:box-resize', boxView: 'engelbart-page:box-view', frame: 'engelbart-page:frame', cursor: 'engelbart-page:cursor',
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
// The selected box's handles (boxes.cjs HANDLES, the same names and places): a press this near one's centre takes it.
const HANDLES = [['nw', 0, 0], ['n', 0.5, 0], ['ne', 1, 0], ['e', 1, 0.5], ['se', 1, 1], ['s', 0.5, 1], ['sw', 0, 1], ['w', 0, 0.5]];
const HANDLE_HIT = 6;
const MIN_BOX = 6; // pixels: a box is never resized smaller (box-layer-preload.cjs MIN)
const EDGE_CURSOR = 'pointer'; // over the edge band of any box: it can be clicked
const CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };
// Whether a box being resized is drawn at its new size as it is dragged (main redraws its rule each frame), or only once
// it is let go. Live: measured on a GitHub repository page and a Wikipedia article (2026-10-07, Electron 44, 40 pointer
// moves 16 ms apart), each move's new outline was drawn 3–10 ms after it (median 6 on GitHub, 3 on Wikipedia), inside a
// frame, and main skips a report a newer one has overtaken; so it does not lag behind the pointer.
const LIVE_RESIZE = true;
const SCROLL_END_MS = 150; // the page has stopped scrolling when it has not scrolled for this long
const VISIBILITY = Object.freeze({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true });

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
 * The box whose edge is at (x, y) of `rects` ([{ id, x, y, w, h }]): one whose edge is within `band` of the point, the
 * smallest of several. A point well inside a box is not on it: that click is the page's. → its id, or null.
 */
function boxAt(rects, x, y, { band = EDGE } = {}) {
  let best = null;
  for (const r of rects || []) {
    const out = x >= r.x - band && x <= r.x + r.w + band && y >= r.y - band && y <= r.y + r.h + band;
    if (!out) continue;
    const deep = x > r.x + band && x < r.x + r.w - band && y > r.y + band && y < r.y + r.h - band;
    if (deep) continue;
    if (!best || r.w * r.h < best.w * best.h) best = r;
  }
  return best ? best.id : null;
}

/** The handle of box `r` ({ x, y, w, h }) whose centre is within `reach` of (x, y): its name ('nw' … 'w'), or null. */
function handleAt(r, x, y, reach = HANDLE_HIT) {
  if (!r) return null;
  let best = null, bestD = Infinity;
  for (const [name, fx, fy] of HANDLES) {
    const dx = Math.abs(x - (r.x + fx * r.w)), dy = Math.abs(y - (r.y + fy * r.h));
    if (dx > reach || dy > reach) continue;
    if (dx + dy < bestD) { best = name; bestD = dx + dy; }
  }
  return best;
}

/** The pointer's cursor: a handle's (its name) before a box's edge (an id), the page's own ('') over neither. */
const cursorFor = (handle, edge) => (handle && CURSORS[handle]) || (edge ? EDGE_CURSOR : '');

/**
 * Box `start` ({ x, y, w, h }) with handle `handle` dragged by (dx, dy): the edges the handle holds move, never past the
 * other side less `min`, and the whole box is kept inside `bounds` (the visible page, { x, y, w, h }). → { x, y, w, h }.
 */
function resizeRect(start, handle, dx, dy, bounds, min = MIN_BOX) {
  const name = String(handle || '');
  const bx = bounds.x, by = bounds.y, br = bounds.x + bounds.w, bb = bounds.y + bounds.h;
  let l = start.x, t = start.y, r = start.x + start.w, b = start.y + start.h;
  if (name.includes('w')) l = Math.min(l + dx, r - min);
  if (name.includes('e')) r = Math.max(r + dx, l + min);
  if (name.includes('n')) t = Math.min(t + dy, b - min);
  if (name.includes('s')) b = Math.max(b + dy, t + min);
  l = Math.max(bx, Math.min(l, br - min)); r = Math.min(br, Math.max(r, l + min));
  t = Math.max(by, Math.min(t, bb - min)); b = Math.min(bb, Math.max(b, t + min));
  return { x: l, y: t, w: r - l, h: b - t };
}

const inRect = (x, y, r) => x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height;
function intersect(a, b) {
  const left = Math.max(a.left, b.left), top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width), bottom = Math.min(a.top + a.height, b.top + b.height);
  return right > left && bottom > top ? { left, top, width: right - left, height: bottom - top } : null;
}

/**
 * Whether something on the page counts as showing under a box: `rect` (a word's, or with `part` a picture's, of which its
 * part inside the box and the viewport is judged), `box` and `viewport` ({ width, height }) in viewport pixels. Its
 * centre must be inside the box and the viewport, then `probe.visible()` (its element's checkVisibility) true, then
 * `probe.hits(x, y)` (what elementFromPoint finds there is its element or inside it). The probes are asked last, and
 * only when the geometry holds.
 */
function shows(rect, box, viewport, probe, { part = false } = {}) {
  if (!rect || !(rect.width > 0) || !(rect.height > 0) || !box || !viewport) return false;
  const screen = { left: 0, top: 0, width: viewport.width, height: viewport.height };
  const r = part ? intersect(rect, box) && intersect(intersect(rect, box), screen) : rect;
  if (!r) return false;
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  if (!inRect(cx, cy, box) || !inRect(cx, cy, screen)) return false;
  if (!probe.visible()) return false;
  return !!probe.hits(cx, cy);
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
      // a box being resized is where the drag has it, and once let go, there until main has its new anchor
      if (drag && drag.id === id && drag.rect) r = { x: drag.rect.x + window.scrollX, y: drag.rect.y + window.scrollY, w: drag.rect.w, h: drag.rect.h };
      else if (held.pending) r = held.pending;
      else if (held.el) { const e = docRect(held.el); if (e.w > 0 && e.h > 0) r = placeIn(held.box, e); }
      else if (held.how === 'doc') r = held.box.doc;
      if (r) rects.push({ id, x: r.x - at.x, y: r.y - at.y, w: r.w, h: r.h }); else missing.push(id);
    }
    if (picked && !boxes.has(picked)) picked = null;
    const html = document.documentElement;
    const size = html ? { width: html.scrollWidth, height: html.scrollHeight } : null;
    const round = (n) => Math.round(n * 10) / 10;
    const report = { rects: rects.map((r) => ({ id: r.id, x: round(r.x), y: round(r.y), w: round(r.w), h: round(r.h) })), selected: picked, size, missing };
    // the box being resized and where the pointer is in the viewport: main draws its size beside it
    if (drag && drag.pointer) report.resizing = { id: drag.id, x: round(drag.pointer.x), y: round(drag.pointer.y), viewport: viewportSize() };
    lastRects = report.rects.map((r) => ({ ...r, x: r.x + at.x, y: r.y + at.y }));
    sendView();
    const text = JSON.stringify(report);
    if (text === sent) return;
    sent = text;
    ipcRenderer.send(CHANNELS.boxes, report);
  }
  function schedule() { if (!measuring) measuring = setTimeout(measure, 50); }
  function setBoxes(marks) {
    for (const held of boxes.values()) if (held.el && resized) resized.unobserve(held.el);
    boxes.clear();
    for (const m of marks) if (m && typeof m.id === 'string' && m.box) boxes.set(m.id, { box: m.box, el: null, how: 'none', pending: null });
    schedule();
  }
  const viewportSize = () => { const html = document.documentElement; return { width: html ? html.clientWidth : window.innerWidth, height: html ? html.clientHeight : window.innerHeight }; };
  /** The selected box in the viewport (CSS pixels), or null: where it is in the document, less how far the page is scrolled. */
  function pickedView() {
    const r = picked ? lastRects.find((x) => x.id === picked) : null;
    return r ? { x: r.x - window.scrollX, y: r.y - window.scrollY, w: r.w, h: r.h } : null;
  }

  // Where the selected box is in the viewport, for its card (main, views.cjs): when it changes, at most once a frame, and
  // whether the page is scrolling (main may hide the card meanwhile).
  let viewSent = '', viewFrame = 0, scrolling = false, scrollEnd = 0;
  function sendView() {
    if (viewFrame) { cancelAnimationFrame(viewFrame); viewFrame = 0; }
    const rect = pickedView();
    const round = (n) => Math.round(n * 10) / 10;
    const value = rect ? { id: picked, rect: { x: round(rect.x), y: round(rect.y), w: round(rect.w), h: round(rect.h) }, viewport: viewportSize(), scrolling } : { id: null };
    const text = JSON.stringify(value);
    if (text === viewSent) return;
    viewSent = text;
    ipcRenderer.send(CHANNELS.boxView, value);
  }
  const viewSoon = () => { if (!viewFrame) viewFrame = requestAnimationFrame(() => { viewFrame = 0; sendView(); }); };

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
  /**
   * The words that show under `view` (viewport pixels), in the page's order, and the alt text of the pictures that show
   * there (shows: centre in the box and the viewport, visible, not covered).
   */
  function textUnder(view) {
    const parts = [];
    let length = 0;
    const viewport = viewportSize();
    const seen = new Map(); // element → whether it is visible (checkVisibility), asked once each
    const visible = (el) => {
      if (!seen.has(el)) { let on = true; try { on = typeof el.checkVisibility === 'function' ? el.checkVisibility(VISIBILITY) : true; } catch { on = true; } seen.set(el, on); }
      return seen.get(el);
    };
    const probe = (el) => ({ visible: () => visible(el), hits: (x, y) => { const at = document.elementFromPoint(x, y); return !!at && (at === el || el.contains(at)); } });
    const range = document.createRange();
    for (const node of textNodes()) {
      if (length >= BOX_TEXT) break;
      const parent = node.parentElement;
      if (!parent || !overlap(parent.getBoundingClientRect(), view)) continue;
      const words = [], look = probe(parent);
      for (const match of node.data.matchAll(/\S+/g)) {
        try { range.setStart(node, match.index); range.setEnd(node, match.index + match[0].length); } catch { continue; }
        if (shows(range.getBoundingClientRect(), view, viewport, look)) words.push(match[0]);
      }
      if (words.length) { parts.push(words.join(' ')); length += words.join(' ').length + 1; }
    }
    for (const img of document.images) {
      const alt = spaced(img.getAttribute('alt')).trim();
      if (alt && shows(img.getBoundingClientRect(), view, viewport, probe(img), { part: true })) parts.push(`[image: ${alt}]`);
    }
    return parts.join(' ').slice(0, BOX_TEXT);
  }
  const select = (id) => {
    if (drag && drag.id !== id) endDrag(false);
    picked = id && boxes.has(id) ? id : null;
    sent = '';
    if (!picked) setCursor('');
    measure();
  };

  ipcRenderer.on(CHANNELS.box, (_event, value) => {
    const { nonce, rect } = value || {};
    let got = null;
    try { got = rect && [rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) && rect.w > 0 && rect.h > 0 ? boxHere(rect) : null; } catch { got = null; }
    ipcRenderer.send(CHANNELS.box, { nonce, box: got ? got.box : null, text: got ? got.text : '' });
  });
  ipcRenderer.on(CHANNELS.boxSet, (_event, marks) => setBoxes(Array.isArray(marks) ? marks : []));
  // one more box, or one whose anchor main has anew (a resize): a box just drawn (`select`) is the one selected
  ipcRenderer.on(CHANNELS.boxAdd, (_event, mark) => {
    if (!mark || typeof mark.id !== 'string' || !mark.box) return;
    const held = boxes.get(mark.id);
    if (held && held.el && resized) resized.unobserve(held.el);
    boxes.set(mark.id, { box: mark.box, el: null, how: 'none', pending: null });
    if (mark.select) select(mark.id); else schedule();
  });
  ipcRenderer.on(CHANNELS.boxRemove, (_event, id) => { const held = boxes.get(id); if (held && held.el && resized) resized.unobserve(held.el); boxes.delete(id); if (drag && drag.id === id) endDrag(false); schedule(); });
  ipcRenderer.on(CHANNELS.boxSelect, (_event, id) => select(id));
  // a click on the drawing layer: a box's edge selects it, as a click on the page does; inside it, nothing
  ipcRenderer.on(CHANNELS.boxHit, (_event, point) => {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    select(boxAt(lastRects, point.x + window.scrollX, point.y + window.scrollY));
  });
  // main waits for the page to have painted (twice: the frame the change is in is then on screen) before a picture
  ipcRenderer.on(CHANNELS.frame, (_event, nonce) => { requestAnimationFrame(() => requestAnimationFrame(() => ipcRenderer.send(CHANNELS.frame, nonce))); });

  // The pointer's cursor over a handle of the selected box, or over any box's edge: main inserts a rule for it, and takes
  // it out again.
  let cursor = '';
  function setCursor(value) { if (value === cursor) return; cursor = value; ipcRenderer.send(CHANNELS.cursor, value); }
  const cursorAt = (x, y) => cursorFor(picked ? handleAt(pickedView(), x, y) : null, boxAt(lastRects, x + window.scrollX, y + window.scrollY));

  // Resizing (build 2): a press on a handle of the selected box. Its rectangle follows the pointer in the viewport (kept
  // inside it), drawn by main once a frame (LIVE_RESIZE); let go, the page says what it is kept by now and the text under
  // it, and main takes its picture and updates the mark. Until main answers it stays where it was let go.
  let drag = null, dragFrame = 0;
  function pressHandle(event) {
    const r = pickedView();
    const handle = r && handleAt(r, event.clientX, event.clientY);
    if (!handle) return false;
    drag = { id: picked, handle, start: r, from: { x: event.clientX, y: event.clientY }, rect: r, pointer: { x: event.clientX, y: event.clientY } };
    setCursor(CURSORS[handle]);
    return true;
  }
  function moveHandle(event) {
    const { width, height } = viewportSize();
    drag.rect = resizeRect(drag.start, drag.handle, event.clientX - drag.from.x, event.clientY - drag.from.y, { x: 0, y: 0, w: width, h: height });
    drag.pointer = { x: event.clientX, y: event.clientY };
    if (LIVE_RESIZE && !dragFrame) dragFrame = requestAnimationFrame(() => { dragFrame = 0; if (drag) measure(); });
  }
  function endDrag(keep = true) {
    const was = drag;
    drag = null;
    if (dragFrame) { cancelAnimationFrame(dragFrame); dragFrame = 0; }
    if (!was) return;
    const held = boxes.get(was.id), r = was.rect;
    const moved = r && (Math.abs(r.x - was.start.x) + Math.abs(r.y - was.start.y) + Math.abs(r.w - was.start.w) + Math.abs(r.h - was.start.h)) >= 1;
    if (!keep || !held || !moved) { measure(); return; }
    held.pending = { x: r.x + window.scrollX, y: r.y + window.scrollY, w: r.w, h: r.h };
    measure();
    let got = null;
    try { got = boxHere(r); } catch { got = null; }
    if (!got) { held.pending = null; measure(); return; }
    ipcRenderer.invoke(CHANNELS.boxResize, { id: was.id, rect: r, box: got.box, text: got.text }).then((answer) => answer, () => null).then((answer) => {
      if (boxes.get(was.id) !== held) return;
      if (answer && answer.box) { held.box = answer.box; if (held.el && resized) resized.unobserve(held.el); held.el = null; held.how = 'none'; }
      held.pending = null;
      measure();
    });
  }

  // A click on a box's edge selects it, and goes no further into the page; anywhere else, what was selected is not. A
  // press on the selected box's handle takes the drag the same way.
  let swallow = false;
  const stop = (event) => { event.preventDefault(); event.stopImmediatePropagation(); };
  window.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || !boxes.size) return;
    if (picked && pressHandle(event)) { stop(event); swallow = true; return; }
    const id = boxAt(lastRects, event.clientX + window.scrollX, event.clientY + window.scrollY);
    if (id) { stop(event); swallow = true; select(id); } else if (picked) select(null);
  }, true);
  window.addEventListener('mousemove', (event) => {
    if (drag) { stop(event); moveHandle(event); return; }
    setCursor(boxes.size ? cursorAt(event.clientX, event.clientY) : '');
  }, true);
  window.addEventListener('mouseup', (event) => {
    if (drag && event.button === 0) { stop(event); endDrag(true); setCursor(cursorAt(event.clientX, event.clientY)); return; }
    if (swallow) stop(event);
  }, true);
  window.addEventListener('click', (event) => { if (!swallow) return; stop(event); swallow = false; }, true);
  window.addEventListener('blur', () => { if (drag) endDrag(false); });
  // the page reflows, scrolls inside a box of its own, or changes size: the boxes are measured again. The page itself
  // scrolling moves no box in the document (the rule scrolls with it), but moves the selected one in the viewport.
  window.addEventListener('resize', schedule);
  document.addEventListener('scroll', (event) => {
    if (!boxes.size) return;
    if (event.target !== document) { schedule(); return; }
    if (!picked) return;
    scrolling = true;
    clearTimeout(scrollEnd);
    scrollEnd = setTimeout(() => { scrolling = false; viewSoon(); }, SCROLL_END_MS);
    viewSoon();
  }, true);
  // a page given back from the back-forward cache: main has forgotten what it was told, and is told again
  window.addEventListener('pageshow', (event) => { if (!event.persisted) return; sent = ''; viewSent = ''; cursor = ''; schedule(); });
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
else if (typeof module === 'object' && module && module.exports) module.exports = { CHANNELS, HIGHLIGHT, CONTEXT, MAX_EXACT, MAX_AFFIX, PAGE_TEXT, BOX_TEXT, EDGE, HANDLES, HANDLE_HIT, MIN_BOX, CURSORS, EDGE_CURSOR, LIVE_RESIZE, VISIBILITY, textMap, rangeOf, snapWords, quoteOf, textAround, anchor, alike, chooseAnchor, fractionsOf, placeIn, sameElement, refind, boxAt, handleAt, cursorFor, resizeRect, shows };
