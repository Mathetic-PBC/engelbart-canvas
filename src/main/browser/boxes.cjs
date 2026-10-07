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

const TEXT_MAX = 2000; // characters of the page's text under a box that are kept
const SELECTOR_MAX = 1000;
const ANCHOR_TEXT = 80; // characters of the anchor element's own text kept to check it is the same one
const SRC_MAX = 2048;
const MAX_BOXES = 200; // drawn on one page
const STROKE = '#0070f3'; // the highlights' blue (views.cjs MARK_CSS)
const PAD = 3; // room around the boxes for the stroke

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

/**
 * The rule that draws `rects` ([{ id, x, y, w, h }] in the coordinates of html's containing block, CSS pixels), `selected`
 * (an id) drawn heavier. `size` ({ width, height }, the document's scroll size) keeps the rule inside the page, so it
 * never adds to what scrolls. '' when there is nothing to draw.
 */
function boxesCss(rects, selected = null, size = null) {
  const shown = (Array.isArray(rects) ? rects : []).filter((r) => r && [r.x, r.y, r.w, r.h].every((n) => finite(n)) && r.w > 0 && r.h > 0).slice(0, MAX_BOXES);
  if (!shown.length) return '';
  const maxW = size && finite(size.width) && size.width > 0 ? size.width : Infinity, maxH = size && finite(size.height) && size.height > 0 ? size.height : Infinity;
  const left = Math.max(0, Math.floor(Math.min(...shown.map((r) => r.x)) - PAD)), top = Math.max(0, Math.floor(Math.min(...shown.map((r) => r.y)) - PAD));
  const right = Math.min(maxW, Math.ceil(Math.max(...shown.map((r) => r.x + r.w)) + PAD)), bottom = Math.min(maxH, Math.ceil(Math.max(...shown.map((r) => r.y + r.h)) + PAD));
  const W = Math.max(1, right - left), H = Math.max(1, bottom - top);
  const round = (n) => Math.round(n * 10) / 10;
  const shapes = shown.map((r) => {
    const on = r.id === selected;
    return `<rect x="${round(r.x - left)}" y="${round(r.y - top)}" width="${round(r.w)}" height="${round(r.h)}" rx="3" fill="${STROKE}" fill-opacity="${on ? 0.1 : 0.04}" stroke="${STROKE}" stroke-width="${on ? 3 : 2}"/>`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${shapes}</svg>`;
  const url = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  const rule = [
    'content:""', 'display:block', 'position:absolute', `left:${left}px`, `top:${top}px`, `width:${W}px`, `height:${H}px`,
    'margin:0', 'padding:0', 'border:0', 'transform:none', 'opacity:1', 'visibility:visible', 'pointer-events:none', 'z-index:2147483647',
    `background:url("${url}") no-repeat 0 0 / ${W}px ${H}px`,
  ].map((p) => `${p} !important`).join(';');
  return `html::after{${rule}}`;
}

module.exports = { TEXT_MAX, SELECTOR_MAX, ANCHOR_TEXT, MAX_BOXES, anchorInput, boxInput, isBox, cropName, CROP_RE, boxesCss };
