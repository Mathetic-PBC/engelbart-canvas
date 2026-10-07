'use strict';
// Boxes on web pages (MATH-70 build 1, 2026-10-07): a rectangle drawn over part of a page in the Stage, kept as a mark in
// the page's ink beside its highlights ("web" list, shared/mark-answers.cjs WEB):
//   { id, box: { x, y, w, h, anchor: { selector, tag, src, text }, doc: { x, y, w, h, width } }, crop, text, note, at }
// x, y, w, h are fractions of the anchor element's rectangle (the element under the box when it was drawn); `doc` is the
// box in document coordinates and how wide the page was then, the fallback when the element is not found again
// (page-preload.cjs refind). `crop` is a picture of the box as it was drawn, "crops/<id>.png" under the annotations
// folder (store/library.cjs), deleted with its mark; `text` is the page's text under the box, at most TEXT_MAX.
//
// Drawn without touching the page's DOM: main inserts one author rule, `html::after`, out of flow (position:absolute,
// pointer-events:none, the top z-index) and covering only the boxes' bounding rectangle, the boxes an SVG data-URL
// background on it (boxesCss). It scrolls with the page by itself; the preload reports the boxes' rectangles again when
// the page reflows, and the rule is replaced. Checked on Wikipedia, GitHub and a Guardian article (2026-10-07, Electron 44, a hidden window):
// it paints, scrolls with the page and moves nothing. Pure: views.cjs and the preload use it, and the tests.
// MATH-70 build 2 (2026-10-07): a box is a 1px outline with no fill, as a macOS selection is; the selected one has 8 small
// square handles (HANDLES, white with a 1px stroke) that resize it (page-preload.cjs). A resize takes a new picture under
// a new name (nextCropName: "crops/<id>-<n>.png"), the old one kept for the answers given about it (an ask's `crop`), and
// every picture of a mark goes and comes back with it (cropsOf). A selected box has a card beside it (cardPlace).

const TEXT_MAX = 2000; // characters of the page's text under a box that are kept
const SELECTOR_MAX = 1000;
const ANCHOR_TEXT = 80; // characters of the anchor element's own text kept to check it is the same one
const SRC_MAX = 2048;
const MAX_BOXES = 200; // drawn on one page
const STROKE = '#0070f3'; // the highlights' blue (views.cjs MARK_CSS)
const HANDLE = 7; // a handle's side, its stroke included, in CSS pixels (page-preload.cjs HANDLE_HIT is the press's reach)
const PAD = Math.ceil(HANDLE / 2) + 2; // room around the boxes for a handle half outside its edge, and its stroke
// The handles, by name (a resize moves the edges a name holds: n, e, s, w), as fractions of the box's width and height.
const HANDLES = Object.freeze([['nw', 0, 0], ['n', 0.5, 0], ['ne', 1, 0], ['e', 1, 0.5], ['se', 1, 1], ['s', 0.5, 1], ['sw', 0, 1], ['w', 0, 0.5]]);
const CARD_GAP = 8; // pixels between a box and its card

const finite = (v, limit = 1e6) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= limit;
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/** An anchor as the preload sends it: { selector, tag, src, text } of bounded strings; null without a selector or tag. */
function anchorInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const selector = str(value.selector, SELECTOR_MAX), tag = str(value.tag, 32).toLowerCase();
  if (!selector || !/^[a-z][a-z0-9-]*$/.test(tag)) return null;
  return { selector, tag, src: str(value.src, SRC_MAX), text: str(value.text, ANCHOR_TEXT) };
}

/**
 * A box as the preload sends it or the ink keeps it → { x, y, w, h, anchor, doc } with finite numbers, a size, and the
 * document rectangle it was drawn at; null for anything else. `anchor` may be null (only `doc` to go by).
 */
function boxInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { x, y, w, h, doc } = value;
  if (![x, y, w, h].every((n) => finite(n, 1e4)) || !(w > 0) || !(h > 0)) return null;
  if (!doc || typeof doc !== 'object' || ![doc.x, doc.y, doc.w, doc.h, doc.width].every((n) => finite(n)) || !(doc.w > 0) || !(doc.h > 0)) return null;
  return { x, y, w, h, anchor: anchorInput(value.anchor), doc: { x: doc.x, y: doc.y, w: doc.w, h: doc.h, width: doc.width } };
}

/** A mark that is a box (`box` an object): every reader of the "web" list asks this before reading a quote. */
const isBox = (m) => !!(m && typeof m === 'object' && m.box && typeof m.box === 'object');

/** Where a box's picture is kept, relative to the annotations folder. */
const cropName = (id) => `crops/${id}.png`;
const CROP_RE = /^crops\/([\w-]{1,64})\.png$/;

/** Which picture of mark `id` a crop name is: 0 for "crops/<id>.png", n for "crops/<id>-<n>.png", -1 for none of its. */
function cropNumber(id, crop) {
  const name = typeof crop === 'string' ? crop.match(CROP_RE) : null;
  if (!name || typeof id !== 'string') return -1;
  if (name[1] === id) return 0;
  const n = name[1].startsWith(`${id}-`) ? name[1].slice(id.length + 1) : '';
  return /^[1-9]\d{0,5}$/.test(n) ? Number(n) : -1;
}

/** The pictures a box mark names: its own `crop` and each of its asks' (the one each answer was about), each once. */
function cropsOf(mark) {
  if (!mark || typeof mark !== 'object') return [];
  const all = [mark.crop, ...(Array.isArray(mark.asks) ? mark.asks.map((a) => a && a.crop) : [])];
  return [...new Set(all.filter((c) => typeof c === 'string' && CROP_RE.test(c)))];
}

/** The name a resized box's new picture takes: "crops/<id>-<n>.png", n one past the highest of its pictures so far. */
function nextCropName(mark) {
  const id = mark && mark.id;
  const n = Math.max(0, ...cropsOf(mark).map((c) => cropNumber(id, c)));
  return `crops/${id}-${n + 1}.png`;
}

/** The centres of a box's handles ({ x, y, w, h }) → [{ name, x, y }], in the box's coordinates. */
const handlesOf = (r) => HANDLES.map(([name, fx, fy]) => ({ name, x: r.x + fx * r.w, y: r.y + fy * r.h }));

/**
 * Where a selected box's card goes (`box` and `page`, the page view's bounds, both { x, y, width, height } in the window;
 * `size` the card's { width, height }): to the box's right when there is room in the page, else to its left, else against
 * the page's right edge; its top level with the box's, and the whole card inside the page. null when the box is out of
 * view (no part of it in the page).
 */
function cardPlace(box, page, size, gap = CARD_GAP) {
  if (![box, page, size].every((r) => r && [r.width, r.height].every(Number.isFinite))) return null;
  if (box.x + box.width <= page.x || box.x >= page.x + page.width || box.y + box.height <= page.y || box.y >= page.y + page.height) return null;
  const width = Math.min(size.width, page.width), height = Math.min(size.height, page.height);
  const right = box.x + box.width + gap, left = box.x - gap - width;
  let x = right + width <= page.x + page.width ? right : left >= page.x ? left : page.x + page.width - width;
  x = Math.max(page.x, Math.min(x, page.x + page.width - width));
  const y = Math.max(page.y, Math.min(box.y, page.y + page.height - height));
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

/**
 * The rule that draws `rects` ([{ id, x, y, w, h }] in the coordinates of html's containing block, CSS pixels): each a 1px
 * outline with no fill, `selected` (an id) with its 8 handles too. `size` ({ width, height }, the document's scroll size)
 * keeps the rule from reaching past the page's right and bottom, so it never adds to what scrolls; past its left and top
 * it adds nothing (a box's handles there are not cut off). '' when there is nothing to draw.
 */
function boxesCss(rects, selected = null, size = null) {
  const shown = (Array.isArray(rects) ? rects : []).filter((r) => r && [r.x, r.y, r.w, r.h].every((n) => finite(n)) && r.w > 0 && r.h > 0).slice(0, MAX_BOXES);
  if (!shown.length) return '';
  const maxW = size && finite(size.width) && size.width > 0 ? size.width : Infinity, maxH = size && finite(size.height) && size.height > 0 ? size.height : Infinity;
  const left = Math.floor(Math.min(...shown.map((r) => r.x)) - PAD), top = Math.floor(Math.min(...shown.map((r) => r.y)) - PAD);
  const right = Math.min(maxW, Math.ceil(Math.max(...shown.map((r) => r.x + r.w)) + PAD)), bottom = Math.min(maxH, Math.ceil(Math.max(...shown.map((r) => r.y + r.h)) + PAD));
  const W = Math.max(1, right - left), H = Math.max(1, bottom - top);
  // whole pixels, the 1px lines on them: a line between two pixels is drawn as two pale ones
  const shapes = shown.map((r) => {
    const x = Math.round(r.x - left), y = Math.round(r.y - top), w = Math.max(1, Math.round(r.w)), h = Math.max(1, Math.round(r.h));
    const outline = `<rect x="${x + 0.5}" y="${y + 0.5}" width="${Math.max(0, w - 1)}" height="${Math.max(0, h - 1)}" fill="none" stroke="${STROKE}" stroke-width="1"/>`;
    if (r.id !== selected) return outline;
    const half = (HANDLE - 1) / 2; // the square inside its stroke
    const handles = handlesOf({ x, y, w, h }).map((p) => `<rect x="${Math.round(p.x) - half}" y="${Math.round(p.y) - half}" width="${HANDLE - 1}" height="${HANDLE - 1}" fill="#fff" stroke="${STROKE}" stroke-width="1"/>`);
    return outline + handles.join('');
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges">${shapes}</svg>`;
  const url = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  const rule = [
    'content:""', 'display:block', 'position:absolute', `left:${left}px`, `top:${top}px`, `width:${W}px`, `height:${H}px`,
    'margin:0', 'padding:0', 'border:0', 'transform:none', 'opacity:1', 'visibility:visible', 'pointer-events:none', 'z-index:2147483647',
    `background:url("${url}") no-repeat 0 0 / ${W}px ${H}px`,
  ].map((p) => `${p} !important`).join(';');
  return `html::after{${rule}}`;
}

module.exports = { TEXT_MAX, SELECTOR_MAX, ANCHOR_TEXT, MAX_BOXES, HANDLE, PAD, HANDLES, CARD_GAP, anchorInput, boxInput, isBox, cropName, CROP_RE, cropNumber, cropsOf, nextCropName, handlesOf, cardPlace, boxesCss };
