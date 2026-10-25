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
// A guide's section (2026-10-15, David: an essay's Read link lit one line): main gives the words a link's passage starts
// with (`engelbart-page:section`, views.cjs section); they are found in the page's text as find would (any case, any
// spacing) and the stretch from them to just before the next heading at the level of the one above them, or higher, is
// tinted (SECTION) as a pdf's section is; inside what holds both the words and that heading (else the page's <article>
// or <main>), whose end ends the last section; with no end in SECTION_MAX characters, the paragraph they are in.
// Another passage, or none, takes its place; a new document has none.
//
// A selection's card (2026-10-18, David: "the annotation card should appear by itself just under the selection"): once a
// selection settles (the pointer let go, or keys that changed it still for SELECTION_SETTLE_MS) with text in it, outside
// any field, the page offers it to main (`engelbart-page:selection-card`): a token, its quote and the page's text around it
// (as `selection` gives them), and where its last line and all of it are in the viewport. As the page scrolls or reflows
// the same token comes again with only where it is (once a frame), and a press anywhere in the page, another selection
// or none takes it back ({ token: null }). Main shows the chat icon at its end for it (2026-10-24), the card once that is
// clicked, and, on Save, keeps the quote as a highlight and
// tints it as the right-click menu's Highlight does (`add`, with the token for its nonce); Cancel keeps nothing
// (`card-gone`). A selection wholly inside a highlight is that highlight: its own card opens (with its markId), and no
// second mark is made for one passage (its icon first: `icon`). A plain click on a highlight's text or on its note's symbol opens its card too; a
// highlight with a note or an answer has its symbol (`noted`), drawn in the boxes' html::after rule over the top right of
// its first line, following it as the page scrolls or reflows; Remove in its card takes it off (`unmark`).
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
  // a guide's section (2026-10-15): the words it starts with, or '' to clear it
  section: 'engelbart-page:section',
  // a selection's card (2026-10-18): a settled selection offered (or a highlight's card asked for: its markId), where it
  // is now, or taken back; main says when it closed the card (cardGone, the offer's token), whether a highlight has a
  // note (noted: { id, on }, for its symbol) and that one was removed (unmark: its id)
  selectionCard: 'engelbart-page:selection-card', cardGone: 'engelbart-page:card-gone', noted: 'engelbart-page:noted', unmark: 'engelbart-page:unmark',
});
const HIGHLIGHT = 'engelbart-web-mark'; // the ::highlight() name main's insertCSS styles
const SECTION = 'engelbart-web-section'; // a guide's section, styled by main's insertCSS as a pdf's (PaperView pdf-section)
// The page's selection, as it is dragged and after (2026-10-24, David: "it should look the same"): its Range tinted here,
// the page's own paint of it hidden by main's insertCSS (views.cjs MARK_CSS), so that it is drawn the way a kept highlight
// is, over each line's glyph box, from the first frame of the drag to the highlight it becomes.
const SELECTION = 'engelbart-web-selection';
const SECTION_MAX = 30000; // characters a section runs to at most before it is taken to be its paragraph alone
const SECTION_WAIT = 3000; // ms a section's words not in the page yet are watched for (text a script draws after load)
const BLOCKS = 'p,li,blockquote,dd,dt,td,th,figcaption,pre,h1,h2,h3,h4,h5,h6';
const ARTICLE = 'article,main,[role="main"]';
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
const SELECTION_SETTLE_MS = 450; // a selection changed by keys is offered once it has not changed for this long
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

// Typography a guide's words and a page differ in (2026-10-16, Hudson: a Read link into an HTML file that did not
// scroll): curly quotes and primes, and dashes and hyphens, each one character for one, so offsets are the text's own.
const FOLD = { '\u2018': "'", '\u2019': "'", '\u201a': "'", '\u201b': "'", '\u2032': "'", '\u201c': '"', '\u201d': '"', '\u201e': '"', '\u201f': '"', '\u2033': '"', '\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2013': '-', '\u2014': '-', '\u2015': '-', '\u2212': '-' };
const fold = (text) => String(text || '').toLowerCase().replace(/[\u2018-\u201f\u2032\u2033\u2010-\u2015\u2212]/g, (c) => FOLD[c] || c);

/**
 * Every place `words` are in the text, from the first: [{ start, end }]. As find matches them (any case, any run of
 * whitespace one space, curly or straight quotes, any dash); where that matches nowhere, with no regard to whitespace at
 * all, for text whose nodes run together with none between them (a table's cells, a list's items).
 */
function matchWords(text, words) {
  const want = fold(String(words || '').replace(/\s+/g, ' ').trim());
  if (!want) return [];
  const hay = fold(text), out = [];
  for (let at = hay.indexOf(want); at >= 0; at = hay.indexOf(want, at + 1)) out.push({ start: at, end: at + want.length });
  if (out.length) return out;
  const bare = want.replace(/ /g, ''), index = [];
  let flat = '';
  for (let i = 0; i < hay.length; i += 1) if (!SPACE.test(hay[i])) { flat += hay[i]; index.push(i); }
  for (let at = flat.indexOf(bare); at >= 0; at = flat.indexOf(bare, at + 1)) out.push({ start: index[at], end: index[at + bare.length - 1] + 1 });
  return out;
}

/** Where `words` start in the text (matchWords' first), -1 when nowhere. */
function findWords(text, words) {
  const all = matchWords(text, words);
  return all.length ? all[0].start : -1;
}

/**
 * Where a section ends, from the headings in the page's order ([{ at, level }], `at` the offset in the text where each
 * starts) and the offset of its start words → the offset it runs to, or -1 for its paragraph alone: just before the first
 * heading after the start at the level of the last heading before it, or higher (any heading when none is before it),
 * within SECTION_MAX characters.
 */
function sectionEnd(headings, start, max = SECTION_MAX) {
  const above = [...headings].reverse().find((h) => h.at <= start);
  const next = headings.find((h) => h.at > start && (!above || h.level <= above.level));
  return next && next.at - start <= max ? next.at : -1;
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

/**
 * A selection's client rects ([{ left, top, width, height }], the viewport's) → { line, rect }, each { x, y, w, h }: its
 * last line (the boxes level with the lowest one) and all of it; null when it has no box with any size.
 */
function selectionBoxes(rects) {
  const boxes = (rects || []).filter((r) => r && r.width > 0.5 && r.height > 0.5 && [r.left, r.top, r.width, r.height].every(Number.isFinite));
  if (!boxes.length) return null;
  const low = boxes.reduce((a, b) => (b.top + b.height > a.top + a.height ? b : a));
  const span = (list) => {
    const x = Math.min(...list.map((b) => b.left)), y = Math.min(...list.map((b) => b.top));
    const round = (n) => Math.round(n * 10) / 10;
    return { x: round(x), y: round(y), w: round(Math.max(...list.map((b) => b.left + b.width)) - x), h: round(Math.max(...list.map((b) => b.top + b.height)) - y) };
  };
  return { line: span(boxes.filter((b) => b.top < low.top + low.height && b.top + b.height > low.top)), rect: span(boxes) };
}

// A highlight's card from the highlight itself (2026-10-18, David): a click on its tinted text or on its note's symbol
// opens it, and a selection wholly inside one opens that one's card rather than offering a new highlight (selecting
// highlighted text again had saved the same passage a second and third time).
const CHIP = 15; // a note's symbol, CSS pixels across: a blue disc at the top right of its highlight's first line
const CHIP_SLOP = 3; // pixels about the symbol a click still finds it within
const MAX_CHIPS = 500;
const CLICK_SLOP = 4; // pixels a press may move and still be a click, not a drag
const START_TO_START = 0, END_TO_END = 2; // Range's compareBoundaryPoints how (Range is not there in node)

/** A box as the page's DOMRects have it or as ours do ({ x, y, w, h }) → { left, top, width, height }, or null. */
function boxOf(r) {
  if (!r) return null;
  const left = Number.isFinite(r.left) ? r.left : r.x, top = Number.isFinite(r.top) ? r.top : r.y;
  const width = Number.isFinite(r.width) ? r.width : r.w, height = Number.isFinite(r.height) ? r.height : r.h;
  return [left, top, width, height].every(Number.isFinite) ? { left, top, width, height } : null;
}
/** Whether (x, y) is in one of `rects` (boxOf's either shape), `slop` pixels about each counted in. Empty boxes hold nothing. */
function inRects(rects, x, y, slop = 0) {
  for (const one of rects || []) {
    const b = boxOf(one);
    if (b && b.width > 0 && b.height > 0 && x >= b.left - slop && x <= b.left + b.width + slop && y >= b.top - slop && y <= b.top + b.height + slop) return true;
  }
  return false;
}
/** The highlight at (x, y): of `list` ([{ id, rects }], each its Range's client rects), the last one whose text is there (the
 *  one painted over the others), or null. */
function highlightAt(list, x, y) {
  let hit = null;
  for (const one of list || []) if (one && inRects(one.rects, x, y)) hit = one.id;
  return hit;
}
/** The selection being offered (its chat icon, its card): a copy of its own first Range, the very passage the person
 *  dragged (not the quote's, which is rebuilt from the page's text and snapped to whole words), or null with none. */
function selectionRange(selection) {
  return selection && !selection.isCollapsed && selection.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
}
/** The selection's tint (SELECTION) in the page's registry `h` for `range` (selectionRange, null with nothing selected):
 *  over the highlights (priority 1), so a passage selected inside one shows; none for none. `make`: Range → Highlight.
 *  → whether it is tinted. */
function tintSelection(h, range, make) {
  if (!h) return false;
  if (!range) { h.delete(SELECTION); return false; }
  const tint = make(range);
  tint.priority = 1;
  h.set(SELECTION, tint);
  return true;
}
/** The highlight `range` lies wholly inside, of `painted` (Map id → Range): its id, the smallest such if several, or null.
 *  A range that reaches past every highlight is a new passage. */
function holdingHighlight(painted, range) {
  if (!range) return null;
  let best = null, bestLen = Infinity;
  for (const [id, held] of painted || []) {
    try {
      if (held.compareBoundaryPoints(START_TO_START, range) > 0 || held.compareBoundaryPoints(END_TO_END, range) < 0) continue;
    } catch { continue; } // another document's range, or one gone
    const len = String(held).length;
    if (len < bestLen) { best = id; bestLen = len; }
  }
  return best;
}
/** Where a highlight's note symbol goes, from its Range's client rects (`rects`, the viewport's): over the top right corner
 *  of its first line, a little out from it → { x, y, size } (its top left, CSS pixels), or null for a highlight with no box. */
function symbolPlace(rects, size = CHIP) {
  const first = (rects || []).map(boxOf).find((b) => b && b.width > 0.5 && b.height > 0.5);
  if (!first) return null;
  const round = (n) => Math.round(n * 10) / 10;
  return { x: round(first.left + first.width - size * 0.35), y: round(first.top - size * 0.6), size };
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
  const quotes = new Map(); // mark id → its quote, for the page's text around it when its card asks @bart
  const noted = new Set(); // the ids of highlights with a note or an answer: each has its symbol
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
      if (range) { painted.set(m.id, range); quotes.set(m.id, m.quote); } else missed.push(m);
      if (m.noted) noted.add(m.id);
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
  // A guide's section: found in the text, run to its next heading (sectionEnd) or its paragraph's end, tinted, and scrolled
  // to its start, a little below the window's top (2026-10-15, David: the tint alone, not find's orange on its first
  // words, which Stage no longer runs once this has shown it). → whether it was found and shown
  // 2026-10-16 (Hudson: a Read link into an HTML file sometimes did not scroll): the first place the words are that is
  // drawn; one in a hidden menu or a display:none copy is passed over.
  const drawn = (range) => {
    const el = range.startContainer.parentElement;
    if (el && typeof el.checkVisibility === 'function' && !el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true })) return false;
    return [...range.getClientRects()].some((r) => r.width > 0 || r.height > 0);
  };
  function showSection(words) {
    const h = registry();
    if (!h) return false;
    h.delete(SECTION);
    if (!words) return false;
    const map = textMap(textNodes());
    let range = null, start = -1;
    for (const one of matchWords(map.text, words)) {
      const r = domRange(rangeOf(map, one.start, one.end));
      if (r && drawn(r)) { range = r; start = one.start; break; }
    }
    if (!range) return false;
    // The section stays inside what holds both its words and the heading above them (an article's body), else inside the
    // page's article or main: a sidebar, the tags or the footer are no part of it, even inside the same <article>.
    const from = range.startContainer.parentElement;
    const offsetOf = (node) => { const seg = map.segs.find((one) => node.contains(one.node)); return seg ? seg.start : -1; };
    const headingsIn = (root) => [...root.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((el) => ({ el, at: offsetOf(el), level: Number(el.tagName[1]) })).filter((one) => one.at >= 0).sort((a, b) => a.at - b.at);
    const above = [...headingsIn(document)].reverse().find((one) => one.at <= start);
    let holder = from && above ? from : null;
    while (holder && !holder.contains(above.el)) holder = holder.parentElement;
    if (!holder || holder === document.body || holder === document.documentElement) holder = (from && from.closest(ARTICLE)) || null;
    const headings = headingsIn(holder || document), end = sectionEnd(headings, start);
    const tint = document.createRange();
    tint.setStart(range.startContainer, range.startOffset);
    const stop = end >= 0 && headings.find((one) => one.at === end);
    const inside = holder ? map.segs.filter((one) => holder.contains(one.node)) : [];
    const last = inside[inside.length - 1], holderEnd = last ? last.start + last.map.length : -1;
    if (stop) tint.setEndBefore(stop.el);
    else if (holder && holderEnd - start <= SECTION_MAX) tint.setEndAfter(holder.lastChild || holder); // its last section
    else {
      const block = from && from.closest(BLOCKS);
      if (block) tint.setEndAfter(block.lastChild || block); else tint.setEnd(range.endContainer, range.endOffset);
    }
    const shown = new Highlight(tint);
    shown.priority = -1; // under find's matches (⌘F's), as a pdf's section is
    h.set(SECTION, shown);
    scrollToWords(range, from);
    return true;
  }
  // The section's start words a little below the top of each box that scrolls around them, the innermost first, then the
  // page: the date or heading above them in view too. The words' own place, not their block's (2026-10-16, David: an old
  // page, cs.brown.edu's, holds its whole text loose in one table cell, its "block", whose top is the page's), and at once
  // (a page's `scroll-behavior: smooth` let the second scroll cancel the first, which left the page at its top).
  function scrollToWords(range, from) {
    const pad = Math.round(Math.min(120, window.innerHeight / 6));
    const page = document.scrollingElement || document.documentElement;
    const boxes = [];
    for (let el = from; el && el !== page && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      const y = getComputedStyle(el).overflowY;
      if ((y === 'auto' || y === 'scroll' || y === 'overlay') && el.scrollHeight > el.clientHeight) boxes.push(el);
    }
    boxes.push(page);
    for (const box of boxes) {
      const rect = (range.getClientRects && range.getClientRects()[0]) || range.getBoundingClientRect();
      if (!rect || (!rect.height && !rect.width)) { const at = from && from.closest(BLOCKS) || from; if (at && at.scrollIntoView) at.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'instant' }); return; }
      const top = box === page ? 0 : box.getBoundingClientRect().top;
      const by = Math.round(rect.top - top - pad);
      if (box === page) window.scrollBy({ top: by, behavior: 'instant' }); else box.scrollBy({ top: by, behavior: 'instant' });
    }
  }
  // Words not in the page yet (2026-10-16: text a page's script draws after it has loaded): the page is watched for
  // SECTION_WAIT ms, and the section shown as soon as they are there. Another passage, the person scrolling, typing or
  // clicking, or a new document ends the wait; the page is left where it is.
  let watching = null;
  function stopWatching() {
    if (!watching) return;
    watching.stop();
    watching = null;
  }
  function watchFor(words) {
    if (typeof MutationObserver !== 'function' || !document.documentElement) return;
    let queued = 0;
    const check = () => { queued = 0; let shown = false; try { shown = showSection(words); } catch { shown = false; } if (shown) stopWatching(); };
    const observer = new MutationObserver(() => { if (!queued) queued = setTimeout(check, 50); });
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    const timer = setTimeout(stopWatching, SECTION_WAIT);
    const quit = () => stopWatching();
    const events = ['wheel', 'keydown', 'pointerdown', 'touchstart', 'pagehide'];
    for (const name of events) window.addEventListener(name, quit, { capture: true, passive: true });
    watching = { stop() { observer.disconnect(); clearTimeout(timer); clearTimeout(queued); for (const name of events) window.removeEventListener(name, quit, { capture: true }); } };
  }
  // { nonce, words } → { nonce, shown } (a bare string, as before 2026-10-15: no reply). Not found: answered at once, so
  // Stage's find runs as before, and watched for (watchFor).
  ipcRenderer.on(CHANNELS.section, (_event, asked) => {
    const nonce = asked && typeof asked === 'object' ? asked.nonce : null, words = nonce ? asked.words : asked;
    const text = typeof words === 'string' ? words.slice(0, MAX_EXACT) : '';
    stopWatching();
    let shown = false;
    try { shown = showSection(text); } catch { /* the page's own tints stay */ }
    if (nonce) ipcRenderer.send(CHANNELS.section, { nonce, shown: !!shown });
    if (!shown && text.trim()) watchFor(text);
  });
  ipcRenderer.on(CHANNELS.add, (_event, value) => {
    const { nonce, mark } = value || {};
    if (!mark || typeof mark.id !== 'string') return;
    const mine = offered && offered.token === nonce;
    const range = pending && pending.nonce === nonce ? pending.range : mine ? offered.range : null;
    if (pending && pending.nonce === nonce) pending = null;
    if (mark.noted) noted.add(mark.id); else noted.delete(mark.id);
    if (range) { painted.set(mark.id, range); if (mark.quote) quotes.set(mark.id, mark.quote); paint(); } else place([mark]);
    if (mine) offered.markId = mark.id;
    // saved and its card closed: the selection let go of, so the passage shows as a highlight (its card's offer gone first,
    // so letting go of it closes nothing)
    if (mine && value.clear) {
      setOffered(null);
      const selection = document.getSelection();
      if (selection && !selection.isCollapsed) selection.removeAllRanges();
    }
    schedule();
  });
  ipcRenderer.on(CHANNELS.noted, (_event, value) => {
    if (!value || typeof value.id !== 'string') return;
    if (value.on === true) noted.add(value.id); else noted.delete(value.id);
    schedule();
  });
  ipcRenderer.on(CHANNELS.unmark, (_event, id) => {
    if (typeof id !== 'string') return;
    painted.delete(id); quotes.delete(id); noted.delete(id);
    if (offered && offered.markId === id) setOffered(null);
    paint();
    schedule();
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
    const chips = noteChips();
    lastChips = chips;
    const html = document.documentElement;
    const size = html ? { width: html.scrollWidth, height: html.scrollHeight } : null;
    const round = (n) => Math.round(n * 10) / 10;
    const report = { rects: rects.map((r) => ({ id: r.id, x: round(r.x), y: round(r.y), w: round(r.w), h: round(r.h) })), selected: picked, size, missing };
    // the notes' symbols, drawn in the boxes' rule (2026-10-18)
    if (chips.length) report.notes = chips.map((c) => ({ id: c.id, x: round(c.x - at.x), y: round(c.y - at.y), size: c.size }));
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
  /** Each noted highlight's symbol where its first line is now (symbolPlace), in the document; none for one that does not
   *  show, or that a box scrolling inside the page has scrolled out of its view. */
  let lastChips = [];
  function noteChips() {
    const out = [];
    for (const id of noted) {
      const range = painted.get(id);
      if (!range) continue;
      let at = null;
      try { at = symbolPlace([...range.getClientRects()]); } catch { at = null; }
      if (!at || !unclipped(range, at)) continue;
      out.push({ id, x: at.x + window.scrollX, y: at.y + window.scrollY, size: at.size });
      if (out.length >= MAX_CHIPS) break;
    }
    return out;
  }
  // whether the symbol's corner shows inside every box around the highlight that clips what it holds (the page's own
  // scrolling aside: the symbol scrolls with the document)
  function unclipped(range, at) {
    const x = at.x + at.size * 0.35, y = at.y + at.size * 0.6; // the line's corner
    const page = document.scrollingElement || document.documentElement;
    for (let el = range.startContainer && (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement); el && el !== page && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      const style = getComputedStyle(el);
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
      const r = el.getBoundingClientRect();
      if (x < r.left - 1 || x > r.right + 1 || y < r.top - 1 || y > r.bottom + 1) return false;
    }
    return true;
  }
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
    if (!boxes.size && !noted.size) return;
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

  // A selection's card (2026-10-18): the settled selection offered to main, followed as the page moves, taken back. A
  // highlight's own card is offered the same way, with its id (markId): for a selection wholly inside it, a click on its
  // text (not a link's), or on its note's symbol. `offered.range` is where the card goes: the highlight's, for its card;
  // `offered.sel`, the selection's own Range when there is one (it is tinted as every selection is, tintSelection).
  let offered = null, offerSeq = 0, settleTimer = 0, offerFrame = 0, pointerDown = false, down = null;
  const fieldNode = (node) => { const el = node && (node.nodeType === 1 ? node : node.parentElement); return !!(el && el.closest && el.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])')); };
  function setOffered(value) { offered = value; }
  function withdraw() {
    clearTimeout(settleTimer); settleTimer = 0;
    if (!offered) return;
    setOffered(null);
    ipcRenderer.send(CHANNELS.selectionCard, { token: null });
  }
  function offerView() {
    if (offerFrame) { cancelAnimationFrame(offerFrame); offerFrame = 0; }
    if (!offered) return null;
    let at = null;
    try { at = selectionBoxes([...offered.range.getClientRects()]); } catch { at = null; }
    return { token: offered.token, line: at ? at.line : null, rect: at ? at.rect : null, viewport: viewportSize() };
  }
  const followSoon = () => { if (offered && !offerFrame) offerFrame = requestAnimationFrame(() => { offerFrame = 0; const view = offerView(); if (view) ipcRenderer.send(CHANNELS.selectionCard, view); }); };
  /** The page's text around highlight `id`, as a selection's comes with it, for an @bart asked from its card. */
  function pageTextOf(id) {
    const quote = quotes.get(id);
    if (!quote) return '';
    const map = textMap(textNodes()), at = anchor(map.text, quote);
    return at ? textAround(map.text, at.start, at.end) : '';
  }
  /** Highlight `id`'s card, under the highlight, its note in it (main reads it from the page's ink); `icon`, for a selection
   *  inside it (2026-10-24): the chat icon at the selection's end first, as a new selection has. */
  function openMark(id, icon = false) {
    const range = painted.get(id);
    if (!range) return;
    clearTimeout(settleTimer); settleTimer = 0;
    const selection = document.getSelection();
    setOffered({ token: `s${(offerSeq += 1)}`, range, text: selection && !selection.isCollapsed ? selection.toString() : '', markId: id, sel: icon ? selectionRange(selection) : null });
    let pageText = '';
    try { pageText = pageTextOf(id); } catch { pageText = ''; }
    ipcRenderer.send(CHANNELS.selectionCard, { ...offerView(), markId: id, pageText, ...(icon ? { icon: true } : {}) });
  }
  function offer() {
    clearTimeout(settleTimer); settleTimer = 0;
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount || editing || isField(document.activeElement) || fieldNode(selection.anchorNode) || fieldNode(selection.focusNode)) { withdraw(); return; }
    let got = null;
    try { got = selected(); } catch { got = null; }
    if (!got || !got.range) { withdraw(); return; }
    // the same passage again (a click's second selectionchange, a page setting it anew): the card it has stays
    const same = offered && offered.range.compareBoundaryPoints(Range.START_TO_START, got.range) === 0 && offered.range.compareBoundaryPoints(Range.END_TO_END, got.range) === 0;
    if (same) { followSoon(); return; }
    // inside a highlight already kept: that highlight's card, never a second mark for it
    const held = holdingHighlight(painted, got.range);
    if (held) { if (offered && offered.markId === held) followSoon(); else openMark(held, true); return; }
    setOffered({ token: `s${(offerSeq += 1)}`, range: got.range, text: selection.toString(), sel: selectionRange(selection) });
    const view = offerView();
    ipcRenderer.send(CHANNELS.selectionCard, { ...view, quote: got.quote, pageText: got.pageText });
  }
  /** The note symbol at (x, y) in the viewport, as last drawn: its highlight's id, or null. */
  const chipAt = (x, y) => {
    for (const c of lastChips) if (inRects([{ x: c.x - window.scrollX, y: c.y - window.scrollY, w: c.size, h: c.size }], x, y, CHIP_SLOP)) return c.id;
    return null;
  };
  /** A click's end: on a highlight's text (no selection made, no link) its card; otherwise the selection, if any, offered. */
  function clicked(event, from) {
    const selection = document.getSelection();
    const plain = from && event.button === 0 && event.detail <= 1 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && Math.abs(event.clientX - from.x) <= CLICK_SLOP && Math.abs(event.clientY - from.y) <= CLICK_SLOP;
    const target = event.target && event.target.nodeType === 1 ? event.target : event.target && event.target.parentElement;
    if (plain && (!selection || selection.isCollapsed) && painted.size && !(target && target.closest && target.closest('a[href],button,input,textarea,select,label,summary'))) {
      let id = null;
      try { id = highlightAt([...painted].map(([one, range]) => ({ id: one, rects: [...range.getClientRects()] })), event.clientX, event.clientY); } catch { id = null; }
      if (id) { openMark(id); return; }
    }
    offer();
  }
  window.addEventListener('mousedown', (event) => {
    pointerDown = event.button === 0;
    down = event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
    // a note's symbol: its highlight's card, and the press goes no further into the page (a link under it stays put). A
    // box's edge or handle never comes here (its press is stopped), so what `swallow` says now is a press before this one's.
    swallow = false;
    const chip = event.button === 0 && lastChips.length ? chipAt(event.clientX, event.clientY) : null;
    withdraw();
    if (!chip) return;
    stop(event);
    swallow = true;
    pointerDown = false;
    openMark(chip);
  }, true);
  window.addEventListener('mouseup', (event) => {
    if (event.button !== 0) return;
    pointerDown = false;
    if (swallow || drag) return; // a box's edge or handle, or a symbol: no selection was made
    const from = down;
    down = null;
    setTimeout(() => clicked(event, from), 0); // the selection as the press left it (a double or triple click's too)
  }, true);
  document.addEventListener('selectionchange', () => {
    const selection = document.getSelection();
    try { tintSelection(registry(), selectionRange(selection), (range) => new Highlight(range)); } catch { /* the page's own tints stay */ }
    if (pointerDown) return;
    // nothing selected: a selection's card goes (a highlight's opened by a click has no selection to lose)
    if (!selection || selection.isCollapsed) { if (!offered || offered.text) withdraw(); return; }
    // changed by keys (⇧ and an arrow, ⌘A): the card for what it was goes now, the new one once it settles
    if (offered && selection.toString() !== offered.text) withdraw();
    clearTimeout(settleTimer);
    settleTimer = setTimeout(offer, SELECTION_SETTLE_MS);
  });
  // main closed the card (Cancel, Esc, Save): the passage is not offered any more, so selecting it again opens one again.
  // The selection it was for goes with it (2026-10-24 later, David: closing it ends the selection's look; Save let go of it
  // already, add's `clear`).
  ipcRenderer.on(CHANNELS.cardGone, (_event, token) => {
    if (!offered || offered.token !== token) return;
    const had = !!offered.sel;
    setOffered(null);
    const selection = document.getSelection();
    if (had && selection && !selection.isCollapsed) selection.removeAllRanges();
  });
  document.addEventListener('scroll', followSoon, { capture: true, passive: true });
  window.addEventListener('resize', followSoon);
  window.addEventListener('blur', () => { pointerDown = false; });
  window.addEventListener('pagehide', withdraw);

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
else if (typeof module === 'object' && module && module.exports) module.exports = { CHANNELS, HIGHLIGHT, SECTION, SELECTION, selectionRange, tintSelection, SECTION_MAX, SECTION_WAIT, findWords, matchWords, sectionEnd, CONTEXT, MAX_EXACT, MAX_AFFIX, PAGE_TEXT, BOX_TEXT, EDGE, HANDLES, HANDLE_HIT, MIN_BOX, CURSORS, EDGE_CURSOR, LIVE_RESIZE, VISIBILITY, SELECTION_SETTLE_MS, selectionBoxes, CHIP, CHIP_SLOP, MAX_CHIPS, CLICK_SLOP, inRects, highlightAt, holdingHighlight, symbolPlace, textMap, rangeOf, snapWords, quoteOf, textAround, anchor, alike, chooseAnchor, fractionsOf, placeIn, sameElement, refind, boxAt, handleAt, cursorFor, resizeRect, shows };
