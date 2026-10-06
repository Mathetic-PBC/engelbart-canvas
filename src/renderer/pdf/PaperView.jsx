// PaperView — the "Paper" pane: a PDF drawn page by page with pdf.js, each page one white
// sheet, rough.js zigzag highlights, Caveat handwritten notes and faint rough.js arrows. Port of
// the design's syncPdf / pdfMouseUp / freeWidth / pendingSelKey / addMark / renderMarks
// (design/goal-canvas/Goal Canvas.dc.html lines 516–602), with two changes: marks are stored in
// page units (fractions of the page's drawn width) so they survive a re-layout at another zoom,
// and the document is parsed once and only re-laid-out on zoom or resize.
// Zoom follows the "Stage" design (Add - Mention Stage.dc.html, 2026-09-23), with 100% = fit width
// (Hudson, 2026-09-23: "I want fit width for 100%"): at 100% the first page is exactly as wide as the
// pane, and every zoom is that width times the percentage, so a resized pane keeps its zoom and
// redraws. Pages are centered with no gutter of their own; a floating bar at the bottom shows the
// page and zoom; a pinch (or ⌘ / ⌃ scroll) zooms around the pointer.
// `target` (2026-09-30): a passage a link asked for. Once every page is drawn it is found from page 1, scrolled to and
// shown as a section (showSection), and told through onTarget(text, result); once per target, until the prop is cleared
// and given again. Nothing matching leaves the scroll where it is. `targetTo` (@discover round 2): the first words of the
// section after it; the stretch from the passage to just before them, up to six pages on, is tinted (SECTION), else the
// passage alone is. The section is find's no longer (2026-10-03, the Stage's Sections menu): it stays while find
// searches and stops, until another is shown or clearSection(). `initialSection` { find, to }: the section to show the
// same way when the viewer opens with no target (a tab with a guide's sections come to the front again). Never ink.
// A margin note mentions library items (MATH-21, 2026-10-05): `@` in it opens the @ menu (`mentionItems`, the workspace's
// list, of which only library rows are kept, and Bart at the start of a highlight's note: MATH-27), and a pick writes
// `@[Name](lib:<id>)` into the note (model/doc.js libMention).
// A note no one is typing in is shown as text (`data-note-view`), its mentions links: a click on one is
// `onOpenMention(id)`, a click anywhere else in it gives the note its field back, the caret where it was clicked. Its
// names are the library's now (`library`), so a renamed item shows its new name; one gone from the library is grey. With
// no `onOpenMention` a note is its field alone, as before: the token reads as typed.
// The page as a canvas (MATH-27 phase 1, 2026-10-06; the pure parts are ./canvas.js). Every page lies on a desk at least
// DESK px wide each side, at every zoom, that a box moved past its edge widens. Every note is a box with a light border
// and a grip: a highlight's note opens on the desk beside it (its `side`), a click on the page or the desk makes a free
// note there, and dragging the grip moves either (`pos`, page units, saved on drop); a click in its text edits it. Each
// answer Bart gave from a highlight's note (`asks`) is a box under the note, joined by a short line, moved the same way.
// Boxes that were not moved are spaced on every draw (canvas.js spaceBoxes), never saved. A note on a highlight that
// starts with @bart asks on Enter (`onAsk`; Shift+Enter is a new line), and a second one continues the exchange (its
// `asks` go as the turns). An answer being written (`pendingAsks`, the workspace's) is a box of its own until it lands
// (`addAsk`, from the Stage). Space-drag or a middle-drag pans; a fade and a chip say where boxes are out of view; the
// bar has Fit page and Fit page + notes.
// Follow-ups (2026-10-06): the boxes hanging under a moved one widen the desk as it does (canvas.js deskNeed), while it is
// dragged too; @bart from a part of a selection across pages sends the whole passage (./marks.js passageOf), and so does
// Continue in workspace; a deleted answer comes back with ⌘Z (undoKey) and stays a turn of its exchange, so the next
// question goes on in the same session (canvas.js exchangeOf); Space, ⌘Z and a pending selection's keys are the paper's
// only while nothing has the keyboard (keyFree).
import React from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import rough from 'roughjs';
import { mergeLineRects, placeHighlight, boxSeed, selectionParts, scalePart, partMarks, passageOf } from './marks.js';
import { nextFind, createTargetGate, sectionSpans, paintSection, clearFind, FIND, FIND_ACTIVE } from '../model/find.js';
import { wheelZooms, wheelZoom, createPageCache } from '../model/paper-zoom.js';
import { mentionAt, libMention, noteHtml, noteParts, noteOffset, inlineHtml, esc, LIB_MENTION_RE } from '../model/doc.js';
import { sideSpace, deskOf, deskNeed, hangLeft, placeOf, posOf, spaceBoxes, extentAt, fitZoom, offscreen, offscreenSide, chipLabel, revealScroll, noteQuestion, turnsOf, shownAsks, keptMarks, modelLabel, runningLabel, DESK_EDGE, BOX_GAP, NOTE_W, ASK_W, COLLAPSED_W, SIDE_GAP, POS_DY } from './canvas.js';
import { fieldCaret } from '../workspace/caret.js';
import MentionMenu from '../workspace/MentionMenu.jsx';

// pdf.js 6: a document is torn down through its loading task (PDFDocumentProxy has no destroy()).
const destroyDoc = (doc) => { try { const task = doc && doc.loadingTask; if (task && typeof task.destroy === 'function') task.destroy().catch(() => {}); } catch { /* already gone */ } };

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const BASE = document.baseURI;
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.min.mjs', BASE).href;
// Optional asset folders next to index.html (copied by the build when present): standard
// fonts for PDFs that do not embed theirs, CMaps for CJK text, wasm image decoders.
const ASSETS = {
  standardFontDataUrl: new URL('./standard_fonts/', BASE).href,
  cMapUrl: new URL('./cmaps/', BASE).href,
  wasmUrl: new URL('./wasm/', BASE).href,
};

/* ---------------------------------------------------------------- zoom math (pure) */
// 100% = page 1 as wide as the pane. Zoom is kept as a fraction (1 = 100%).
export const ZOOM_MIN = 0.15, ZOOM_MAX = 2;
export const ZOOM_STEPS = [15, 30, 41, 67, 69, 90, 100, 110, 150, 200];
/** The fixed zoom (percent) that − (dir < 0) or + (dir > 0) goes to from `pct`, or null past the ends. */
export function zoomStep(pct, dir) {
  const r = Math.round(pct);
  if (dir > 0) { const s = ZOOM_STEPS.find((v) => v > r); return s == null ? null : s; }
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i -= 1) if (ZOOM_STEPS[i] < r) return ZOOM_STEPS[i];
  return null;
}
/** 1-based page whose sheet contains y, given the sheets' ascending tops (tops[0] is page 1). */
export function pageAt(tops, y) {
  if (!tops.length) return 0;
  let lo = 0, hi = tops.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (tops[mid] <= y) lo = mid; else hi = mid - 1; }
  return lo + 1;
}
export { sideSpace };
/** Canvas pixels per CSS px: 2×, capped so one page's canvas stays near 4 million device pixels. */
export const canvasScale = (cssW, cssH) => Math.min(2, Math.sqrt(4e6 / Math.max(1, cssW * cssH)));
const PINCH_SETTLE_MS = 180;

// pdf.js 6 positions text-layer spans through CSS custom properties (--font-height,
// --scale-x, --rotate, --total-scale-factor); these rules mirror pdf_viewer.css for the
// design's .pdf-text container so selection rectangles line up with the printed text.
// .endOfContent (MATH-14, 2026-10-05) is pdf.js's TextLayerBuilder's: an empty, unselectable box at the end of each
// layer that covers it while a selection is made there (.selecting, see trackSelecting). Without it a drag ending past a
// line or in a margin lands on the layer itself, whose spans are all absolutely placed, and Chromium takes the end of the
// layer: the rest of the page was selected.
const LAYER_CSS = `
[data-pdf] .pdf-text{color-scheme:only light;overflow:clip;opacity:1;letter-spacing:normal;word-spacing:normal;caret-color:CanvasText;z-index:0;--min-font-size:1;--text-scale-factor:calc(var(--total-scale-factor) * var(--min-font-size));--min-font-size-inv:calc(1 / var(--min-font-size))}
[data-pdf] .pdf-text :is(span,br){color:transparent;position:absolute;white-space:pre;cursor:text;transform-origin:0% 0%;user-select:text}
[data-pdf] .pdf-text > :not(.markedContent),[data-pdf] .pdf-text .markedContent span:not(.markedContent){z-index:1;--font-height:0;font-size:calc(var(--text-scale-factor) * var(--font-height));--scale-x:1;--rotate:0deg;transform:rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv))}
[data-pdf] .pdf-text .markedContent{display:contents}
[data-pdf] .pdf-text .endOfContent{display:block;position:absolute;inset:100% 0 0;z-index:0;cursor:default;user-select:none}
[data-pdf] .pdf-text.selecting .endOfContent{top:0}
[data-pdf] .pdf-text span[role="img"]{user-select:none;cursor:default}
[data-pdf][data-pinching] .pdf-text{display:none}
[data-pdf]{overflow-x:scroll!important}
[data-pdf]::-webkit-scrollbar{width:10px;height:10px;background:#f2f2f2}
[data-pdf]::-webkit-scrollbar-thumb{background:#d0d0d0;border-radius:5px;border:2px solid #f2f2f2}
[data-pdf]::-webkit-scrollbar-thumb:hover{background:#b5b5b5}
[data-pdf]::-webkit-scrollbar-corner{background:#f2f2f2}
[data-pdf][data-space],[data-pdf][data-space] *{cursor:grab!important}
[data-pdf][data-panning],[data-pdf][data-panning] *{cursor:grabbing!important}
[data-pdf] [data-grip]{cursor:grab}
[data-pdf][data-dragging],[data-pdf][data-dragging] *{cursor:grabbing!important;user-select:none!important}
[data-pdf] [data-box] button{border:0;background:transparent;padding:2px 6px;border-radius:5px;font:12px/1.4 var(--font-sans);color:#4d4d4d;cursor:pointer;white-space:nowrap}
[data-pdf] [data-box] button:hover{background:#f2f2f2}
[data-pdf] [data-box] [data-ask-body],[data-pdf] [data-box] [data-run-body]{user-select:text;cursor:text}
[data-pdf] [data-box] [data-ask-body] p,[data-pdf] [data-box] [data-run-body] p{margin:0 0 6px}
[data-pdf] [data-box] a{color:#0070f3;text-decoration:underline;text-underline-offset:2px}
@keyframes pdf-spin{to{transform:rotate(360deg)}}
::highlight(pdf-section){background-color:rgba(255,196,0,.13)}
::highlight(pdf-find){background-color:rgba(255,196,0,.35)}
::highlight(pdf-find-active){background-color:rgba(255,140,0,.6)}
`;

// The page-and-zoom bar (Stage design).
const BAR = { position: 'absolute', left: '50%', bottom: 16, transform: 'translateX(-50%)', display: 'flex', alignItems: 'center', gap: 2, height: 34, boxSizing: 'border-box', padding: '0 4px 0 12px', background: '#fff', border: '1px solid #eaeaea', borderRadius: 8, font: '400 12.5px/1 var(--font-sans)', fontVariantNumeric: 'tabular-nums', color: '#4d4d4d', whiteSpace: 'nowrap', zIndex: 5 };
const BAR_STEP = { flex: 'none', width: 26, height: 26, padding: 0, borderRadius: 6, border: 0, background: 'transparent', font: '400 14px/1 var(--font-sans)', color: '#4d4d4d', cursor: 'pointer' };
const BAR_PCT = { flex: 'none', minWidth: 48, height: 26, padding: '0 6px', borderRadius: 6, border: 0, background: 'transparent', font: '500 12.5px/1 var(--font-sans)', fontVariantNumeric: 'tabular-nums', color: '#171717', cursor: 'pointer' };
const BAR_FIT = { flex: 'none', height: 26, padding: '0 8px', borderRadius: 6, border: 0, background: 'transparent', font: '400 12.5px/1 var(--font-sans)', color: '#4d4d4d', cursor: 'pointer' };
// Boxes out of view (MATH-27): a fade on each edge with some beyond it, and a chip that brings them in. The scrollbars
// are 10px (LAYER_CSS): the fades stop short of them.
const BAR_SIDE = 10;
const FADE = 36;
const fadeStyle = (side) => {
  const to = { left: 'to right', right: 'to left', up: 'to bottom', down: 'to top' }[side];
  const at = side === 'left' ? { left: 0, top: 0, bottom: BAR_SIDE, width: FADE } : side === 'right' ? { right: BAR_SIDE, top: 0, bottom: BAR_SIDE, width: FADE } : side === 'up' ? { top: 0, left: 0, right: BAR_SIDE, height: FADE } : { bottom: BAR_SIDE, left: 0, right: BAR_SIDE, height: FADE };
  return { position: 'absolute', ...at, pointerEvents: 'none', zIndex: 4, background: `linear-gradient(${to}, rgba(250,250,250,.96), rgba(250,250,250,0))` };
};
const CHIP = { position: 'absolute', zIndex: 5, height: 26, padding: '0 10px', border: '1px solid #eaeaea', borderRadius: 999, background: '#fff', font: '500 12px/1 var(--font-sans)', color: '#4d4d4d', cursor: 'pointer', whiteSpace: 'nowrap', boxShadow: '0 1px 2px rgba(0,0,0,.04)' };
const chipStyle = (side) => ({ ...CHIP, ...(side === 'left' ? { left: 12, top: '50%', transform: 'translateY(-50%)' } : side === 'right' ? { right: BAR_SIDE + 12, top: '50%', transform: 'translateY(-50%)' } : side === 'up' ? { top: 10, left: '50%', transform: 'translateX(-50%)' } : { bottom: 62, left: '50%', transform: 'translateX(-50%)' }) });
const SIDES = ['left', 'right', 'up', 'down'];
const NO_OFF = { left: 0, right: 0, up: 0, down: 0 };
// A box (MATH-27): a light border, a grip at its top that moves it.
const BOX_LOOK = 'position:absolute;box-sizing:border-box;border:1px solid #e3e3e3;border-radius:8px;background:rgba(255,255,255,.97);pointer-events:auto;box-shadow:0 1px 2px rgba(0,0,0,.03)';
const GRIP_HTML = '<div data-grip="1" title="Drag to move" style="height:12px;display:flex;align-items:center;justify-content:center"><span style="width:22px;height:3px;border-radius:2px;background:#d9d9d9"></span></div>';
const SPINNER = '<span style="flex:none;width:10px;height:10px;box-sizing:border-box;border:1.5px solid #c9d9f2;border-top-color:#0070f3;border-radius:50%;animation:pdf-spin .8s linear infinite"></span>';

// Find (the Browser pane's ⌘F, 2026-09-22): matches are Ranges over the text layer, painted with
// the CSS Custom Highlight API, so the page's DOM is never touched. Space in the query matches any
// run of space, or none (pdf.js splits lines and words into separate spans), and a word may be
// broken by a hyphen at the end of a line ("construc-" / "tion"; a line break is \n here).
const escapeChar = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const findPattern = (query) => new RegExp(query.trim().split(/\s+/).map((word) => [...word].map(escapeChar).join('(?:-\\n)?')).join('\\s*'), 'gi');
// A link's target as the gate holds it: the passage, and the start of the section after it when there is one.
const targetKey = (find, to) => (find ? (to ? `${find}\n${to}` : find) : '');
const highlights = () => (typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function' ? CSS.highlights : null);

const clone = (v) => JSON.parse(JSON.stringify(v));
const markId = (prefix = 'm') => prefix + Date.now() + Math.random().toString(36).slice(2, 6); // 'g…': a selection across pages' group
// What has the keyboard when it is no field, button or link: Space, ⌘Z and a pending selection's keys can be the paper's.
const CONTROL = 'input,textarea,select,button,a[href],[contenteditable="true"]';
// A range's text as a selection gives it: its text nodes in order, a line break (<br>) as \n. Range.toString() leaves
// out line breaks, which would run one line's last word into the next one's first.
function rangeText(range) {
  const root = range.commonAncestorContainer;
  if (root.nodeType === Node.TEXT_NODE) return root.data.slice(range.startOffset, range.endOffset);
  let out = '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!range.intersectsNode(node)) continue;
    if (node.nodeType === Node.TEXT_NODE) out += node.data.slice(node === range.startContainer ? range.startOffset : 0, node === range.endContainer ? range.endOffset : node.data.length);
    else if (node.nodeName === 'BR') out += '\n';
  }
  return out;
}
const SVG = 'http://www.w3.org/2000/svg';
// A note's handwriting, the same in its field and shown as text (so the side arrows meet either where they did).
const NOTE_LOOK = "pointer-events:auto;padding:0 6px;font:500 17px/1.25 'Caveat',cursive;color:#171717";

// An answer as its box draws it (MATH-27): a paragraph a line, with what Bart was told a box may hold (bold, italic,
// code, links), and a list's or a heading's mark taken off should one come anyway.
function answerHtml(text, opts) {
  return String(text || '').split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const item = line.match(/^[-*] (.*)$/), head = line.match(/^#{1,6} (.*)$/);
    return `<p>${item ? `• ${inlineHtml(item[1], opts)}` : head ? `<strong>${inlineHtml(head[1], opts)}</strong>` : inlineHtml(line, opts)}</p>`;
  }).join('');
}

function toBytes(src) {
  // pdf.js transfers the buffer to its worker (detaching it), so hand it a private copy.
  if (!src) return null;
  if (src instanceof ArrayBuffer) return src.slice(0);
  if (ArrayBuffer.isView(src)) return new Uint8Array(src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength));
  return null;
}

export default class PaperView extends React.Component {
  constructor(props) {
    super(props);
    this.state = { note: 'Opening the paper…', page: 0, pages: 0, pct: 100, mention: null, mentionIdx: 0, off: NO_OFF };
    this.host = React.createRef();
    this.root = React.createRef(); // the pane: the paper, its bar and its chips
    this.marks = clone(props.marks || {}); // { [page]: Mark[] }, geometry in page units
    this.doc = null;
    this.gen = 0; // document generation
    this.layoutGen = 0; // page-layout generation
    this.renderTask = null;
    this.textLayer = null;
    this.pdfG = 150; // page 1's side space (per-page values live in this.geo)
    this.pdfW = null; // pane width of the current layout
    this.pageW = null; // page 1's drawn width
    this.resetGeometry();
    this.pendingSel = null;
    this.pdfDown = null;
    this.dirty = false;
    this.saveTimer = null;
    this.resizeTimer = null;
    this.pinchTimer = null;
    this.pinchAt = null;
    this.scrollRaf = 0;
    this.editing = null; // the id of the note being typed in: drawn as its field, the rest as text (see renderMarks)
    this.redrawing = 0; // > 0 while notes are taken out to be drawn again: a field losing the keyboard then is not left
    this.libDrawn = ''; // the mentioned items' names the notes were drawn with (libKey)
    this.drawn = {}; // { [page]: { boxes, units, chains } }: the boxes as last drawn, for spacing, links and fitting
    this.drag = null; // a box being moved by its grip
    this.pan = null; // a Space-drag or middle-drag under way
    this.space = false; // Space held over the paper: a drag pans
    this.hovered = false;
    this.openLogs = new Set(); // answers being written whose steps are shown
    this.offRaf = 0;
    this.undos = []; // what ⌘Z brings back, the last first: answers deleted, { page, markId, askId } (undoKey)
    this.downHere = false; // the last press was in this pane: ⌘Z is the paper's
    this.onDown = (e) => {
      if (!(e.target.closest && e.target.closest('[data-pdf] [data-page]'))) return;
      if (e.target.closest('[data-box]')) return;
      this.pdfDown = { x: e.clientX, y: e.clientY };
      if (!e.target.closest('textarea')) this.clearPending();
      const tl = e.target.closest('[data-text-layer]');
      if (tl) tl.classList.add('selecting');
    };
    this.onUp = (e) => this.pdfMouseUp(e);
    // A selection being made (see LAYER_CSS .endOfContent): the layers it touches stay .selecting until the pointer is
    // up, the window loses focus, or a key is let go with the pointer up (pdf.js TextLayerBuilder's listeners).
    this.pointerIsDown = false;
    this.onPointerDown = (e) => {
      this.pointerIsDown = true;
      const root = this.root.current;
      this.downHere = !!(root && e && e.target && root.contains(e.target));
    };
    this.onPointerUp = () => { this.pointerIsDown = false; this.endSelecting(); };
    this.onBlur = () => { this.pointerIsDown = false; this.endSelecting(); this.holdSpace(false); };
    this.onKeyUp = (e) => { if (e && e.code === 'Space') this.holdSpace(false); if (!this.pointerIsDown) this.endSelecting(); };
    this.onSelectionChange = () => this.trackSelecting();
    this.onKeyCapture = (e) => { if (this.spaceKey(e) || this.pendingSelKey(e) || this.undoKey(e)) e.stopPropagation(); };
    this.onWheel = (e) => this.pinch(e);
    this.onScroll = () => {
      if (this.state.mention) this.closeMention();
      if (this.scrollRaf) return;
      this.scrollRaf = requestAnimationFrame(() => { this.scrollRaf = 0; this.syncBar(); this.syncOffscreen(); });
    };
    // Panning (MATH-27): Space held over the paper, or the middle button, and a drag moves the view both ways. Caught
    // before anything inside: no selection starts, no note is made, no box is grabbed.
    this.onEnter = () => { this.hovered = true; };
    this.onLeave = () => { this.hovered = false; };
    this.onPanDown = (e) => {
      if (!(e.button === 1 || (e.button === 0 && this.space))) return;
      const host = this.host.current;
      if (!host) return;
      e.preventDefault(); e.stopPropagation();
      this.pan = { x: e.clientX, y: e.clientY, left: host.scrollLeft, top: host.scrollTop };
      host.dataset.panning = '1';
      window.addEventListener('mousemove', this.onPanMove);
      window.addEventListener('mouseup', this.onPanUp);
    };
    this.onPanMove = (e) => {
      const host = this.host.current, p = this.pan;
      if (!host || !p) return;
      host.scrollLeft = p.left - (e.clientX - p.x);
      host.scrollTop = p.top - (e.clientY - p.y);
    };
    this.onPanUp = () => {
      window.removeEventListener('mousemove', this.onPanMove);
      window.removeEventListener('mouseup', this.onPanUp);
      this.pan = null;
      const host = this.host.current;
      if (host) delete host.dataset.panning;
    };
    this.onAux = (e) => { if (e.button === 1) e.preventDefault(); }; // no paste or autoscroll on a middle click
    // A box's grip held: the box follows the pointer, the view scrolls at the pane's edges (dragTick).
    this.onDragMove = (e) => { const d = this.drag; if (!d) return; d.at = { x: e.clientX, y: e.clientY }; this.dragTo(); };
    this.onDragUp = () => this.endDrag();
    this.findQuery = '';
    this.findAt = -1;
    this.findRanges = [];
    this.findSpots = []; // where each of findRanges is: { page, from, to } in its page's text
    this.section = null; // { text, to, spot }: a link's section, its start words found at `spot` ({ page, from, to })
    this.gate = createTargetGate();
    const first = props.target ? { find: props.target, to: props.targetTo } : props.initialSection || {};
    this.gate.set(targetKey(first.find, first.to));
  }

  // Zoom and layout state, dropped whenever a new document opens (which opens at 100%).
  resetGeometry() {
    this.zoom = 1; // committed zoom (fraction of fit width)
    this.live = null; // zoom while a pinch is under way, before it is laid out
    this.renderedZoom = 1; // the zoom the sheets in the DOM were drawn at
    this.css = 1; // CSS zoom on the inner wrapper (live / rendered, during a pinch or a fit resize)
    this.pages = []; // [n] PDFPageProxy
    this.v0 = []; // [n] viewport at scale 1 (pdf points)
    this.geo = []; // [n] { G, pageW, pageH, scale } in CSS px
    this.sheets = []; // [n] { wrap, canvas, hl, tl, ar, notes }
    this.tops = []; // [n − 1] top of sheet n inside the inner wrapper (unzoomed)
    this.inner = null;
    const pages = this.pages;
    this.texts = createPageCache((n) => pages[n].getTextContent()); // each page's text, asked for once a document
  }

  componentDidMount() {
    const host = this.host.current;
    host.addEventListener('mousedown', this.onPanDown, true);
    host.addEventListener('mousedown', this.onDown);
    host.addEventListener('mouseup', this.onUp);
    host.addEventListener('auxclick', this.onAux);
    host.addEventListener('mouseenter', this.onEnter);
    host.addEventListener('mouseleave', this.onLeave);
    host.addEventListener('wheel', this.onWheel, { passive: false });
    host.addEventListener('scroll', this.onScroll, { passive: true });
    window.addEventListener('keydown', this.onKeyCapture, true);
    document.addEventListener('pointerdown', this.onPointerDown);
    document.addEventListener('pointerup', this.onPointerUp);
    document.addEventListener('keyup', this.onKeyUp);
    document.addEventListener('selectionchange', this.onSelectionChange);
    window.addEventListener('blur', this.onBlur);
    this.ro = new ResizeObserver(() => this.onResize());
    this.ro.observe(host);
    this.load();
  }

  componentDidUpdate(prev, prevState) {
    if (prevState && !prevState.mention !== !this.state.mention && this.props.onMentionOpen) this.props.onMentionOpen(!!this.state.mention);
    if (prev.target !== this.props.target || prev.targetTo !== this.props.targetTo) {
      const text = this.gate.set(targetKey(this.props.target, this.props.targetTo));
      if (text) this.applyTarget(text);
    }
    if (prev.bytes !== this.props.bytes) {
      this.flushSave(prev.onMarksChange);
      this.marks = clone(this.props.marks || {});
      this.dirty = false;
      this.clearPending();
      this.load();
      return;
    }
    if (prev.marks !== this.props.marks && !this.dirty) {
      // Annotations arriving after the bytes (loaded separately) adopt as long as nothing
      // was edited here in the meantime. A box moved past the desk's edge widens it again.
      this.marks = clone(this.props.marks || {});
      this.reframe();
      this.renderAllMarks();
    }
    if (prev.pendingAsks !== this.props.pendingAsks) {
      this.reframe(); // an answer being written under a moved box can widen the desk, as a written one does
      this.syncPending(prev.pendingAsks || []);
    }
    // A mentioned item renamed, or gone from the library: its mentions are drawn again with its name now.
    if (prev.library !== this.props.library && this.libKey() !== this.libDrawn) this.renderAllMarks();
  }

  componentWillUnmount() {
    const host = this.host.current;
    if (host) {
      host.removeEventListener('mousedown', this.onPanDown, true);
      host.removeEventListener('mousedown', this.onDown);
      host.removeEventListener('mouseup', this.onUp);
      host.removeEventListener('auxclick', this.onAux);
      host.removeEventListener('mouseenter', this.onEnter);
      host.removeEventListener('mouseleave', this.onLeave);
      host.removeEventListener('wheel', this.onWheel);
      host.removeEventListener('scroll', this.onScroll);
    }
    this.onPanUp();
    if (this.drag) this.endDrag(true);
    if (this.offRaf) cancelAnimationFrame(this.offRaf);
    window.removeEventListener('keydown', this.onKeyCapture, true);
    document.removeEventListener('pointerdown', this.onPointerDown);
    document.removeEventListener('pointerup', this.onPointerUp);
    document.removeEventListener('keyup', this.onKeyUp);
    document.removeEventListener('selectionchange', this.onSelectionChange);
    window.removeEventListener('blur', this.onBlur);
    if (this.ro) this.ro.disconnect();
    clearTimeout(this.resizeTimer);
    clearTimeout(this.pinchTimer);
    if (this.scrollRaf) cancelAnimationFrame(this.scrollRaf);
    if (this.state.mention && this.props.onMentionOpen) this.props.onMentionOpen(false);
    this.flushSave(this.props.onMarksChange);
    this.gen += 1;
    this.cancelLayout();
    this.stopFind();
    this.clearSection();
    if (this.doc) { const d = this.doc; this.doc = null; destroyDoc(d); }
  }

  // In this viewer only: the Paper pane and a pdf in the Browser pane can both be open, with the same page numbers.
  find1(selector) { const host = this.host.current; return host ? host.querySelector(selector) : null; }

  // A page's drawn geometry (falls back to page 1's before the first layout).
  geom(page) { return this.geo[page] || { G: this.pdfG || 0, R: this.pdfG || 0, pageW: this.pageW || 1 }; }

  /* ---------------------------------------------------------------- persistence */
  scheduleSave() {
    this.dirty = true;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.emit(this.props.onMarksChange); }, 300);
  }
  flushSave(cb) {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.emit(cb);
  }
  emit(cb) {
    if (typeof cb !== 'function') return;
    const out = {}, now = Date.now();
    for (const [page, list] of Object.entries(this.marks)) if (list && list.length) out[page] = clone(keptMarks(list, now));
    cb(out);
  }

  /* ---------------------------------------------------------------- loading */
  async load() {
    const gen = ++this.gen;
    this.cancelLayout();
    clearTimeout(this.pinchTimer); this.pinchTimer = null;
    if (this.doc) { const d = this.doc; this.doc = null; destroyDoc(d); }
    const host = this.host.current;
    this.closeMention();
    this.redrawing += 1;
    try { if (host) host.replaceChildren(); } finally { this.redrawing -= 1; }
    this.resetGeometry();
    this.setPinching(false);
    this.pdfW = null;
    this.undos = []; // another paper
    this.gate.drawing();
    const data = toBytes(this.props.bytes);
    if (!data) { this.setState({ note: 'No paper to open.', page: 0, pages: 0 }); return; }
    this.setState({ note: 'Opening the paper…', page: 0, pages: 0, pct: 100 });
    try {
      const doc = await pdfjsLib.getDocument({ data, isEvalSupported: false, ...ASSETS }).promise;
      if (gen !== this.gen) { destroyDoc(doc); return; }
      this.doc = doc;
      this.setState({ note: '' });
      await this.layout(null);
    } catch (err) {
      if (gen !== this.gen) return;
      this.setState({ note: 'Could not open the paper — ' + ((err && err.message) || err) });
    }
  }

  cancelLayout() {
    this.layoutGen += 1;
    if (this.renderTask) { try { this.renderTask.cancel(); } catch (e) { /* already done */ } this.renderTask = null; }
    if (this.textLayer) { try { this.textLayer.cancel(); } catch (e) { /* already done */ } this.textLayer = null; }
  }

  /* ---------------------------------------------------------------- zoom */
  pct() { return Math.round((this.live != null ? this.live : this.zoom) * 100); }

  // CSS px per pdf point at 100% for a pane W wide: page 1 exactly fills it.
  unit(W) {
    const v = this.v0[1];
    return v ? W / v.width : 1;
  }

  setCss(v) {
    this.css = v;
    if (this.inner) this.inner.style.zoom = Math.abs(v - 1) < 1e-4 ? '' : String(v);
  }

  // While a pinch is under way the text layers are hidden: CSS zoom would otherwise restyle and lay out every one of
  // their spans on each wheel event, which is most of a pinch's cost. They show again when layout() replaces them.
  setPinching(on) {
    const host = this.host.current;
    if (!host || on === (host.dataset.pinching === '1')) return;
    if (on) host.dataset.pinching = '1'; else delete host.dataset.pinching;
  }

  hostPoint(where) {
    const host = this.host.current, r = host.getBoundingClientRect();
    const x = r.left + host.clientLeft + host.clientWidth / 2;
    return { x, y: where === 'center' ? r.top + host.clientTop + host.clientHeight / 2 : r.top + host.clientTop };
  }

  // The document point under a client point, in page units, so it can be found again at any zoom.
  anchorAt(x, y) {
    if (!this.inner || !this.tops.length) return null;
    const css = this.css, top = this.inner.getBoundingClientRect().top;
    const n = pageAt(this.tops, (y - top) / css), g = this.geo[n], s = this.sheets[n];
    if (!g || !s) return null;
    const r = s.wrap.getBoundingClientRect(), bt = n > 1 ? 1 : 0;
    return { n, fx: ((x - r.left) / css - g.G) / g.pageW, fy: ((y - r.top) / css - bt) / g.pageW, x, y };
  }

  // Scroll so the anchored document point sits under its client point again.
  restoreAnchor(a) {
    const host = this.host.current;
    if (!a || !host) return;
    const g = this.geo[a.n], s = this.sheets[a.n];
    if (!g || !s) return;
    const r = s.wrap.getBoundingClientRect(), css = this.css, bt = a.n > 1 ? 1 : 0;
    host.scrollLeft += r.left + (g.G + a.fx * g.pageW) * css - a.x;
    host.scrollTop += r.top + (bt + a.fy * g.pageW) * css - a.y;
  }

  /** Zoom to a percent of fit width, anchored at the middle of the view. */
  zoomTo(target) {
    if (!this.host.current || !this.doc) return;
    clearTimeout(this.pinchTimer); this.pinchTimer = null; this.live = null;
    this.zoom = clamp(target / 100, ZOOM_MIN, ZOOM_MAX);
    this.layout(this.hostPoint('center'));
  }
  zoomStepBy(dir) { const next = zoomStep(this.pct(), dir); if (next != null) this.zoomTo(next); }
  // The percentage goes back to 100%: the page as wide as the pane.
  togglePct() { if (this.pct() !== 100) this.zoomTo(100); }

  // The view moved so a point of page n (px from the page's top-left; null keeps that axis) is in its middle.
  centerOn(n, x, y) {
    const host = this.host.current, s = this.sheets[n], g = this.geo[n];
    if (!host || !s || !g) return;
    const r = s.wrap.getBoundingClientRect(), h = host.getBoundingClientRect(), css = this.css || 1, bt = n > 1 ? 1 : 0;
    if (x != null) host.scrollLeft += r.left + (g.G + x) * css - (h.left + host.clientLeft + host.clientWidth / 2);
    if (y != null) host.scrollTop += r.top + (bt + y) * css - (h.top + host.clientTop + host.clientHeight / 2);
  }

  // The boxes of page n as ./canvas.js extentAt reads them: a moved one by its page units, one beside the page by its px
  // from the page's edge, any other by where it is now in page units; sizes as drawn.
  boxShapes(n) {
    const model = this.drawn[n], g = this.geo[n];
    if (!model || !g) return [];
    const P = g.pageW || 1;
    return model.boxes.filter((b) => b.el && b.el.isConnected).map((b) => {
      const w = b.width, h = b.height, pos = b.how === 'pos' && b.pos, from = b.how === 'hang' && b.from && b.from.how === 'pos' && b.from.pos;
      if (pos) return { x: { a: pos.x, b: 0 }, y: { a: pos.y, b: -POS_DY }, w, h };
      // Under a moved box: its px from that box, which keeps its page units.
      if (from) return { x: { a: from.x, b: b.left - b.from.left }, y: { a: from.y, b: b.top - b.from.top - POS_DY }, w, h };
      if (b.how === 'right') return { x: { a: 1, b: b.left - g.G - P }, y: { a: b.top / P, b: 0 }, w, h };
      if (b.how === 'left') return { x: { a: 0, b: b.left - g.G }, y: { a: b.top / P, b: 0 }, w, h };
      return { x: { a: (b.left - g.G) / P, b: 0 }, y: { a: b.top / P, b: 0 }, w, h };
    });
  }

  /** "Fit page": the page in view whole in the pane; `withNotes`, "Fit page + notes": zoomed out until its boxes are too.
   *  Only that page's boxes: other pages' would zoom a long paper with notes far apart down to ZOOM_MIN. */
  fitPage(withNotes = false) {
    const host = this.host.current;
    if (!host || !this.doc || !this.inner) return;
    const n = this.currentPage() || 1, v0 = this.v0[n];
    if (!v0) return;
    const W = host.clientWidth, H = host.clientHeight, unit = this.unit(W);
    const shape = { pageW1: v0.width * unit, pageH1: v0.height * unit, boxes: withNotes ? this.boxShapes(n) : [] };
    const z = fitZoom({ ...shape, availW: Math.max(40, W - 48), availH: Math.max(40, H - 48 - 50), zMin: ZOOM_MIN, zMax: ZOOM_MAX });
    clearTimeout(this.pinchTimer); this.pinchTimer = null; this.live = null;
    this.zoom = z;
    this.layout(undefined, () => {
      const e = extentAt({ ...shape, pageW1: this.geo[n].pageW / z }, z);
      this.centerOn(n, (e.left + e.right) / 2, (e.top + e.bottom) / 2);
    });
  }

  // Trackpad pinch (and ⌃ scroll) arrive as wheel events with ctrlKey, ⌘ scroll with metaKey. The drawn sheets are
  // scaled with CSS zoom at once (scroll geometry stays real), and laid out again once the pinch settles.
  pinch(e) {
    if (!wheelZooms(e)) return;
    e.preventDefault();
    if (!this.doc || !this.inner) return;
    const from = this.live != null ? this.live : this.zoom;
    const to = wheelZoom(from, e, ZOOM_MIN, ZOOM_MAX);
    if (to !== from) {
      this.closeMention();
      const a = this.anchorAt(e.clientX, e.clientY);
      this.live = to;
      this.setPinching(true);
      this.setCss(to / this.renderedZoom);
      this.restoreAnchor(a);
      this.syncBar();
    }
    this.pinchAt = { x: e.clientX, y: e.clientY };
    clearTimeout(this.pinchTimer);
    this.pinchTimer = setTimeout(() => {
      this.pinchTimer = null;
      if (this.live == null) return;
      this.zoom = this.live; this.live = null;
      this.layout(this.pinchAt);
    }, PINCH_SETTLE_MS);
  }

  onResize() {
    const host = this.host.current;
    if (!host || !this.doc) return;
    const W = host.clientWidth;
    if (!this.inner) { clearTimeout(this.resizeTimer); this.resizeTimer = setTimeout(() => this.layout(null), 200); return; }
    if (W === this.pdfW || W < 40) return;
    if (this.live == null) {
      // The zoom is a share of the pane's width: show the new width at once by scaling what is drawn,
      // then draw it for real when the resize settles.
      const pt = this.hostPoint('top'), a = this.anchorAt(pt.x, pt.y);
      this.setCss(W / this.pdfW);
      this.restoreAnchor(a);
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => this.layout(), 200);
      return;
    }
    this.recenter(W);
  }

  // At a fixed zoom a resize only moves the pages sideways: new side space, same drawings.
  recenter(W) {
    this.pdfW = W;
    const need = this.deskNeedNow();
    for (let n = 1; n < this.geo.length; n += 1) {
      const g = this.geo[n], s = this.sheets[n];
      if (!g || !s) continue;
      Object.assign(g, deskOf(W, g.pageW, need));
      this.place(n);
    }
    if (this.geo[1]) this.pdfG = this.geo[1].G;
    this.renderAllMarks();
  }

  // How wide the desk must be each side (./canvas.js deskNeed), at the pages' widths now; `extra` ({ left, right } px)
  // for a box being dragged past it.
  deskNeedNow(extra = null) {
    const need = deskNeed(this.marks, (n) => (this.geo[n] ? this.geo[n].pageW : 0), (id) => this.runsOf(id));
    return extra ? { left: Math.max(need.left, extra.left || 0), right: Math.max(need.right, extra.right || 0) } : need;
  }

  // The desk made as wide as the boxes need (MATH-27), the drawings kept: each sheet takes its new sides, the boxes
  // drawn on it move with its page, and the view moves with page 1 so nothing on screen jumps. → whether anything changed.
  reframe(extra = null) {
    const host = this.host.current;
    if (!host || !this.pdfW || this.geo.length < 2) return false;
    const need = this.deskNeedNow(extra), was = this.geo[1] ? this.geo[1].G : 0;
    let changed = false;
    for (let n = 1; n < this.geo.length; n += 1) {
      const g = this.geo[n], s = this.sheets[n];
      if (!g || !s) continue;
      const next = deskOf(this.pdfW, g.pageW, need), dG = next.G - g.G;
      if (!dG && next.R === g.R) continue;
      changed = true;
      g.G = next.G; g.R = next.R;
      this.place(n);
      const model = this.drawn[n];
      if (model && dG) {
        for (const b of model.boxes) { b.left += dG; b.el.style.left = `${b.left}px`; }
        this.drawLinks(n);
      }
    }
    if (!changed) return false;
    this.pdfG = this.geo[1].G;
    host.scrollLeft += (this.pdfG - was) * (this.css || 1);
    return true;
  }

  /* ---------------------------------------------------------------- layout */
  // Everything about a sheet that depends on its geometry (side space, page size).
  place(n) {
    const g = this.geo[n], s = this.sheets[n];
    const { G, R, pageW, pageH } = g, sheetW = G + pageW + R;
    s.wrap.style.width = `${sheetW}px`;
    s.wrap.style.height = `${pageH}px`;
    // The page, white with a faint edge, on the desk (MATH-27); its drawing goes over it once it is ready.
    if (s.bg) s.bg.style.cssText = `position:absolute;left:${G}px;top:0;width:${pageW}px;height:${pageH}px;background:#fff;box-shadow:0 0 0 1px #e6e6e6`;
    if (s.canvas) s.canvas.style.cssText = `position:absolute;left:${G}px;top:0;width:${pageW}px;height:${pageH}px;background:#fff`;
    s.hl.setAttribute('width', pageW); s.hl.setAttribute('height', pageH); s.hl.setAttribute('viewBox', `0 0 ${pageW} ${pageH}`);
    s.hl.style.cssText = `position:absolute;left:${G}px;top:0;width:${pageW}px;height:${pageH}px;pointer-events:none;overflow:visible`;
    s.tl.style.left = `${G}px`; s.tl.style.top = '0'; s.tl.style.width = `${pageW}px`; s.tl.style.height = `${pageH}px`;
    s.ar.setAttribute('width', sheetW); s.ar.setAttribute('height', pageH); s.ar.setAttribute('viewBox', `0 0 ${sheetW} ${pageH}`);
  }

  /* paper — drawn page by page. Each page is one white sheet on a desk (MATH-27): the desk G on its left and R on its
     right are each at least DESK px, and at least what centers the page in the pane, so the whole sheet is writable and
     there is room beside every page for its notes. Sheets stack 1px apart so page breaks still read. All sheets
     are laid out at their final size first (so the scroll position can be kept), showing the
     previous drawing stretched, then drawn starting from the page in view. `anchor` is a client
     point to keep fixed; undefined keeps the top of the view, null starts at the top with page 1 in the middle. `then`,
     when given, places the view instead, once the sheets are laid out (Fit page). */
  async layout(anchor, then = null) {
    const host = this.host.current, doc = this.doc;
    if (!host || !doc || host.clientWidth < 40) { this.setPinching(this.live != null); return; }
    this.cancelLayout();
    this.gate.drawing();
    const gen = this.layoutGen;
    try {
      for (let n = 1; n <= doc.numPages; n += 1) {
        if (!this.pages[n]) {
          const page = await doc.getPage(n);
          if (gen !== this.layoutGen) return;
          this.pages[n] = page;
          this.v0[n] = page.getViewport({ scale: 1 });
        }
      }
    } catch (err) {
      if (gen === this.layoutGen) this.setState({ note: 'Could not draw the paper — ' + ((err && err.message) || err) });
      return;
    }
    if (gen !== this.layoutGen || !this.host.current) return;

    const W = host.clientWidth, N = doc.numPages;
    this.closeMention(); // a zoom or a resize moves the note it hangs from
    const pt = anchor === undefined ? this.hostPoint('top') : anchor, at = pt ? this.anchorAt(pt.x, pt.y) : null;
    const focused = document.activeElement && host.contains(document.activeElement) && document.activeElement.dataset.mark
      ? { id: document.activeElement.dataset.mark, a: document.activeElement.selectionStart, b: document.activeElement.selectionEnd } : null;
    const z = clamp(this.zoom, ZOOM_MIN, ZOOM_MAX), unit = this.unit(W);
    this.zoom = z;

    const geo = [], sheets = [], tops = [];
    const inner = document.createElement('div');
    inner.style.cssText = 'position:relative;width:max-content;min-width:100%;margin:0 auto;display:flex;flex-direction:column;align-items:flex-start';
    const widths = [];
    for (let n = 1; n <= N; n += 1) widths[n] = Math.max(1, Math.round(this.v0[n].width * unit * z));
    const need = deskNeed(this.marks, (n) => widths[n] || 0, (id) => this.runsOf(id));
    let top = 0;
    for (let n = 1; n <= N; n += 1) {
      const v0 = this.v0[n], pageW = widths[n], scale = pageW / v0.width;
      geo[n] = { ...deskOf(W, pageW, need), pageW, pageH: v0.height * scale, scale };
      tops.push(top);
      top += geo[n].pageH + (n > 1 ? 1 : 0);
      const wrap = document.createElement('div');
      wrap.dataset.page = n;
      wrap.style.cssText = `position:relative;flex:none;margin:0 auto;${n > 1 ? 'border-top:1px solid transparent;' : ''}box-sizing:content-box`;
      const bg = document.createElement('div');
      // The previous drawing of this page, stretched, until the new one is ready.
      const old = this.sheets[n] && this.sheets[n].canvas;
      const hl = document.createElementNS(SVG, 'svg');
      hl.dataset.hl = n;
      const tl = document.createElement('div');
      tl.className = 'pdf-text'; tl.dataset.textLayer = n;
      tl.style.setProperty('--scale-factor', String(scale));
      tl.style.setProperty('--user-unit', '1');
      tl.style.setProperty('--total-scale-factor', String(scale));
      tl.style.setProperty('--scale-round-x', '1px');
      tl.style.setProperty('--scale-round-y', '1px');
      // Boxes and their arrows above every page's drawing and text (a box pushed past its page's foot stays in sight).
      const notes = document.createElement('div');
      notes.dataset.notes = n; notes.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:2';
      const ar = document.createElementNS(SVG, 'svg');
      ar.dataset.arrows = n;
      ar.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:visible;z-index:1';
      wrap.append(bg);
      if (old) wrap.append(old);
      wrap.append(hl, tl, ar, notes);
      sheets[n] = { wrap, bg, canvas: old || null, hl, tl, ar, notes };
      inner.appendChild(wrap);
    }

    this.redrawing += 1; // the note being typed in keeps being so (this.editing), and has the keyboard back below
    try { host.replaceChildren(inner); } finally { this.redrawing -= 1; }
    this.setPinching(this.live != null); // the new text layers show unless a pinch is still under way
    const oldGeo = this.geo;
    this.inner = inner; this.geo = geo; this.sheets = sheets; this.tops = tops; this.drawn = {};
    this.renderedZoom = z; this.css = 1;
    for (let n = 1; n <= N; n += 1) this.place(n);
    if (this.live != null) this.setCss(this.live / z);
    this.pdfW = W; this.pdfG = geo[1].G; this.pageW = geo[1].pageW;
    if (!then) {
      if (at) this.restoreAnchor(at);
      else if (anchor === null) { host.scrollTop = 0; host.scrollLeft = 0; this.centerOn(1, geo[1].pageW / 2, null); }
    }

    // A pending selection is kept in pixels of the layout it was made in, a part a page; carry it over.
    const p = this.pendingSel;
    if (p) {
      p.parts = p.parts.map((part) => (geo[part.page]
        ? scalePart(part, part.u || (oldGeo[part.page] && oldGeo[part.page].pageW), geo[part.page].pageW) : part));
    }
    this.renderAllMarks();
    if (then) then();
    if (focused) {
      const ta = this.find1(`textarea[data-mark="${focused.id}"]`);
      if (ta) { ta.focus({ preventScroll: true }); try { ta.setSelectionRange(focused.a, focused.b); } catch { /* not a text field */ } }
    }
    this.syncBar();
    this.syncOffscreen();

    // Draw the page in view first, then the one above it, then onward, then the rest above.
    const cur = this.currentPage() || 1;
    const order = [cur];
    if (cur > 1) order.push(cur - 1);
    for (let n = cur + 1; n <= N; n += 1) order.push(n);
    for (let n = cur - 2; n >= 1; n -= 1) order.push(n);
    try {
      for (const n of order) {
        if (gen !== this.layoutGen) return;
        const page = this.pages[n], g = geo[n], s = sheets[n];
        const vp = page.getViewport({ scale: g.scale }), vp2 = page.getViewport({ scale: g.scale * canvasScale(g.pageW, g.pageH) });
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.floor(vp2.width)); c.height = Math.max(1, Math.floor(vp2.height));
        const task = page.render({ canvasContext: c.getContext('2d'), viewport: vp2 });
        this.renderTask = task;
        try { await task.promise; } catch (err) { if (gen !== this.layoutGen) return; }
        this.renderTask = null;
        if (gen !== this.layoutGen) return;
        if (s.canvas) s.canvas.replaceWith(c); else s.wrap.prepend(c);
        s.canvas = c;
        this.place(n);
        try {
          const textLayer = new pdfjsLib.TextLayer({ textContentSource: await this.texts.get(n), container: s.tl, viewport: vp });
          if (gen !== this.layoutGen) return;
          this.textLayer = textLayer;
          await textLayer.render();
          this.textLayer = null;
          const end = document.createElement('div');
          end.className = 'endOfContent';
          s.tl.append(end);
        } catch (err) { /* a page without a text layer is still readable */ }
        if (gen !== this.layoutGen) return;
        // Free notes size themselves around the printed text, which only now exists.
        if ((this.marks[n] || []).some((m) => m.pos && m.note != null && !(m.rects || []).length)) this.renderMarks(n);
      }
      if (this.findQuery) this.report(this.find(this.findQuery, 0, { scroll: false }));
      if (this.section) { this.section.spot = this.sectionStart(this.section.text).spot; this.paintSection(); } // the text layer was drawn again: found again
      const text = this.gate.drawn();
      if (text) this.applyTarget(text);
    } catch (err) {
      if (gen === this.layoutGen) this.setState({ note: 'Could not draw the paper — ' + ((err && err.message) || err) });
    }
  }

  // The page whose sheet holds the vertical middle of the view.
  currentPage() {
    const host = this.host.current;
    if (!host || !this.tops.length) return 0;
    return pageAt(this.tops, (host.scrollTop + host.clientHeight / 2) / this.css);
  }

  syncBar() {
    const next = { page: this.currentPage(), pages: this.tops.length, pct: this.pct() };
    const s = this.state;
    if (next.page !== s.page || next.pages !== s.pages || next.pct !== s.pct) this.setState(next);
  }

  /* ---------------------------------------------------------------- find */
  /** `step` 0: a new query starts at the first match in view or below (the same query keeps its place);
   *  1 / -1: the next / previous match, wrapping. '' stops. `fromStart`: counted from page 1 (a link's passage).
   *  Answers { matches, active } (active from 1). Where it lands: ../model/find.js nextFind. */
  find(query, step = 0, { scroll = true, fromStart = false } = {}) {
    const text = String(query || '');
    if (!text.trim()) { this.stopFind(); return { matches: 0, active: 0 }; }
    const fresh = text !== this.findQuery;
    this.findQuery = text;
    const pages = this.pageTexts();
    this.findSpots = this.matchSpots(text, pages);
    this.findRanges = [];
    const spots = [];
    for (const spot of this.findSpots) {
      const range = this.rangeIn(pages, spot.page, spot.from, spot.to);
      if (range) { this.findRanges.push(range); spots.push(spot); }
    }
    this.findSpots = spots;
    const plan = nextFind({ fresh, step, count: this.findRanges.length, at: this.findAt, fromStart, firstInView: () => this.firstInView() });
    this.findAt = plan.at;
    this.paintFind(scroll && plan.scroll);
    return { matches: this.findRanges.length, active: this.findAt + 1 };
  }

  // A link's passage, every page drawn: shown as a section from page 1 (`target`, `targetTo`). Told through onTarget alone:
  // find has not been asked anything.
  applyTarget(key) {
    const [text, to = ''] = String(key).split('\n');
    const result = this.showSection(text, to);
    if (typeof this.props.onTarget === 'function') this.props.onTarget(text, result);
  }

  // Where a section starts: its words' first match from page 1, as find counts them (one with a range) → { spot, range,
  // matches }; `spot` null when they are nowhere.
  sectionStart(text, pages = this.pageTexts()) {
    let first = null, matches = 0;
    for (const spot of this.matchSpots(text, pages)) {
      const range = this.rangeIn(pages, spot.page, spot.from, spot.to);
      if (!range) continue;
      matches += 1;
      if (!first) first = { spot, range };
    }
    return { spot: first ? first.spot : null, range: first ? first.range : null, matches };
  }

  /** A section (2026-10-03, apart from find): its start words `find` found from page 1 and scrolled to, and tinted to just
   *  before `to` (paintSection). Answers { matches, active } as find would; nothing matching clears it and leaves the scroll. */
  showSection(find, to = '') {
    const text = String(find || '');
    if (!text.trim()) { this.clearSection(); return { matches: 0, active: 0 }; }
    const { spot, range, matches } = this.sectionStart(text);
    if (!spot) { this.clearSection(); return { matches: 0, active: 0 }; }
    this.section = { text, to: String(to || ''), spot };
    this.paintSection();
    this.scrollToRange(range);
    return { matches, active: 1 };
  }

  clearSection() {
    this.section = null;
    paintSection(highlights(), [], null);
  }

  // The section from its start words to just before the first match of `to` after them, one range a page
  // (../model/find.js sectionSpans). No `to`, `to` nowhere after them, or too far on: the start words alone are tinted.
  paintSection() {
    const h = highlights();
    if (!h) return;
    const s = this.section, start = s && s.spot;
    const pages = start ? this.pageTexts() : [];
    const spans = start ? (s.to && sectionSpans(start, this.matchSpots(s.to, pages))) || [start] : [];
    paintSection(h, spans.map((span) => this.rangeIn(pages, span.page, span.from, span.to)).filter(Boolean), Highlight);
  }

  stopFind() {
    this.findQuery = '';
    this.findAt = -1;
    this.findRanges = [];
    this.findSpots = [];
    clearFind(highlights());
  }

  report(result) { if (typeof this.props.onFind === 'function') this.props.onFind(result); }

  // Each page's text layer as one string (a line break is \n) → [{ page, layer, joined, locate }]; `locate(index, end)`
  // is the text node and offset at that index (`end`: the end of a stretch, so a node starting there is not it).
  pageTexts() {
    const host = this.host.current;
    if (!host) return [];
    return [...host.querySelectorAll('[data-text-layer]')].map((layer) => {
      const nodes = [];
      let joined = '';
      const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.nodeType === Node.TEXT_NODE) { nodes.push({ node, start: joined.length }); joined += node.data; }
        else if (node.nodeName === 'BR') joined += '\n';
      }
      const locate = (index, end) => {
        for (let i = nodes.length - 1; i >= 0; i -= 1) {
          const { node, start } = nodes[i];
          if (end ? start < index : start <= index) return { node, offset: Math.min(index - start, node.data.length) };
        }
        return null;
      };
      return { page: Number(layer.dataset.textLayer), layer, joined, locate };
    });
  }

  // Where a query matches, page by page in order → [{ page, from, to }].
  matchSpots(query, pages = this.pageTexts()) {
    const pattern = findPattern(query);
    const spots = [];
    for (const { page, joined } of pages) {
      pattern.lastIndex = 0;
      for (let m = pattern.exec(joined); m; m = pattern.exec(joined)) {
        if (!m[0]) { pattern.lastIndex += 1; continue; }
        spots.push({ page, from: m.index, to: m.index + m[0].length });
      }
    }
    return spots;
  }

  // A Range over one page's text, from `from` to `to` (null: to the end of the page); null when there is nothing there.
  rangeIn(pages, page, from, to) {
    const at = pages.find((p) => p.page === page);
    if (!at) return null;
    const a = at.locate(from, false), b = to == null ? null : at.locate(to, true);
    if (!a || (to != null && !b)) return null;
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    if (b) range.setEnd(b.node, b.offset); else range.setEnd(at.layer, at.layer.childNodes.length);
    return range.collapsed ? null : range;
  }

  firstInView() {
    const host = this.host.current;
    if (!host) return 0;
    const top = host.getBoundingClientRect().top;
    const i = this.findRanges.findIndex((range) => range.getBoundingClientRect().bottom >= top);
    return i < 0 ? 0 : i;
  }

  paintFind(scroll) {
    const h = highlights();
    const active = this.findRanges[this.findAt];
    if (h) {
      h.set(FIND, new Highlight(...this.findRanges.filter((range) => range !== active)));
      const on = new Highlight(...(active ? [active] : []));
      on.priority = 1;
      h.set(FIND_ACTIVE, on);
    }
    if (scroll) this.scrollToRange(active);
  }

  // A range out of view is brought a third of the way down (and across) the pane.
  scrollToRange(range) {
    const host = this.host.current;
    if (!range || !host) return;
    const box = host.getBoundingClientRect(), r = range.getBoundingClientRect();
    if (r.top < box.top + 24 || r.bottom > box.bottom - 24) host.scrollTop += r.top - box.top - host.clientHeight / 3;
    if (r.left < box.left || r.right > box.left + host.clientWidth) host.scrollLeft += r.left - box.left - host.clientWidth / 3;
  }

  /* ---------------------------------------------------------------- selection → marks */
  // The text layers a selection touches are .selecting (LAYER_CSS .endOfContent): `layers` (default: every one in this
  // viewer) stop being so, their .endOfContent back at their end. Electron 44's Chromium is 152; pdf.js moves the box next
  // to the selection's anchor only before Chromium 148, so that part of TextLayerBuilder is left out.
  endSelecting(layers) {
    const host = this.host.current;
    for (const tl of layers || (host ? host.querySelectorAll('[data-text-layer]') : [])) {
      tl.classList.remove('selecting');
      const end = tl.querySelector(':scope > .endOfContent');
      if (end && end !== tl.lastChild) tl.append(end);
    }
  }
  trackSelecting() {
    const host = this.host.current, sel = document.getSelection();
    if (!host) return;
    const ranges = [];
    for (let i = 0; sel && i < sel.rangeCount; i += 1) ranges.push(sel.getRangeAt(i));
    for (const tl of host.querySelectorAll('[data-text-layer]')) {
      if (ranges.some((range) => range.intersectsNode(tl))) tl.classList.add('selecting');
      else if (tl.classList.contains('selecting')) this.endSelecting([tl]);
    }
  }

  // A range cut into one a page: for each text layer in this viewer it touches, the range from the layer's start where it
  // began on an earlier page, to the layer's end where it goes on to a later one. → [{ page, layer, range }] in page order.
  pageRanges(range) {
    const host = this.host.current;
    if (!host) return [];
    const out = [];
    for (const tl of host.querySelectorAll('[data-text-layer]')) {
      if (!range.intersectsNode(tl)) continue;
      const part = range.cloneRange();
      if (!tl.contains(range.startContainer)) part.setStart(tl, 0);
      if (!tl.contains(range.endContainer)) part.setEnd(tl, tl.childNodes.length);
      if (!part.collapsed) out.push({ page: Number(tl.dataset.textLayer), layer: tl, range: part });
    }
    return out;
  }

  // Client rects are divided by this.css so geometry is in the layout's own pixels mid-pinch too. A fully selected span
  // gives its own box and its text's (they differ in height), and spans can overlap, so the rects are merged into one
  // box per stretch of a line (./marks.js) before anything is drawn or stored. A selection across pages (MATH-14) is one
  // part a page (pageRanges, ./marks.js selectionParts), each measured against its own page's text layer; a page that
  // gives no rects has no part.
  pdfMouseUp(e) {
    const wrap = e.target.closest && e.target.closest('[data-pdf] [data-page]');
    if (!wrap || this.pan) return;
    if (e.target.closest('textarea, [data-note-view], [data-box]')) return;
    const sel = getSelection(), css = this.css || 1;
    if (sel && !sel.isCollapsed && sel.rangeCount) {
      const range = sel.getRangeAt(0);
      const cut = this.pageRanges(range);
      if (!cut.length) { this.clearPending(); return; }
      this.endSelecting(); // the pointer is up: no .endOfContent covers a layer while it is measured
      const text = sel.toString();
      const parts = selectionParts(cut.map(({ page, layer, range: part }) => {
        const box = layer.getBoundingClientRect();
        const rects = [...part.getClientRects()].filter((r) => r.width > 1 && r.height > 1)
          .map((r) => ({ x: (r.left - box.left) / css, y: (r.top - box.top) / css, w: r.width / css, h: r.height / css }));
        return { page, rects, width: box.width / css, text: cut.length > 1 ? rangeText(part) : text, u: this.geom(page).pageW };
      }));
      if (!parts.length) return;
      this.pendingSel = { parts, text };
      this.showPending(); sel.removeAllRanges();
      return;
    }
    if (this.pdfDown && Math.hypot(e.clientX - this.pdfDown.x, e.clientY - this.pdfDown.y) < 4 && !e.target.closest('.pdf-text span')) {
      const box = wrap.getBoundingClientRect(), x = (e.clientX - box.left) / css, y = (e.clientY - box.top) / css, page = Number(wrap.dataset.page);
      const m = this.addMark({ page, rects: [], side: null, y, text: '' }, '', { x, y });
      requestAnimationFrame(() => { const ta = this.find1(`textarea[data-mark="${m.id}"]`); if (ta) ta.focus(); });
    }
  }

  // Width available for a free-placed note at (x, y): stops before the next printed text on
  // that line, so notes wrap instead of running over the page.
  freeWidth(page, x, y, h) {
    const { G, R, pageW } = this.geom(page), tl = this.find1(`[data-text-layer="${page}"]`);
    if (!tl) return 160;
    let right = G + pageW + R - 8;
    for (const s of tl.querySelectorAll('span')) {
      const l = s.offsetLeft + G, t = s.offsetTop, b = t + s.offsetHeight;
      if (b < y || t > y + h) continue;
      if (l > x && l < right) right = l - 6;
    }
    return Math.max(70, right - x);
  }

  // Nothing has the keyboard (2026-10-06): it is on the page itself, or on something of the paper's that is no field,
  // button or link. A note's field, a button (the Stage's, the sidebar's, an answer's Copy) or the document keeps its keys.
  keyFree(t) {
    if (!t || t === document || t === document.body || t === document.documentElement) return true;
    const host = this.host.current;
    return !!(host && host.contains(t) && !(t.closest && t.closest(CONTROL)));
  }

  // Space held with the pointer over the paper, and nothing has the keyboard (keyFree): a drag pans (MATH-27). The page
  // does not scroll a screen down, as Space would make it.
  spaceKey(e) {
    if (e.code !== 'Space' || e.metaKey || e.ctrlKey || e.altKey || !this.hovered || !this.keyFree(e.target)) return false;
    e.preventDefault();
    this.holdSpace(true);
    return true;
  }
  holdSpace(on) {
    this.space = !!on;
    const host = this.host.current;
    if (!host) return;
    if (on) host.dataset.space = '1'; else delete host.dataset.space;
  }

  // ⌘Z (or Ctrl+Z) after a press in this pane, nothing having the keyboard: the answer deleted last comes back (one gone
  // meanwhile is passed over). With nothing to bring back the key is the app's.
  undoKey(e) {
    if (!this.undos.length || !this.downHere || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || String(e.key).toLowerCase() !== 'z' || !this.keyFree(e.target)) return false;
    while (this.undos.length) {
      if (this.restoreAsk(this.undos.pop())) { e.preventDefault(); return true; }
    }
    return false;
  }
  restoreAsk({ page, markId, askId }) {
    const m = ((this.marks || {})[page] || []).find((x) => x && x.id === markId);
    const a = m && (m.asks || []).find((x) => x && x.id === askId && x.deleted);
    if (!a) return false;
    delete a.deleted;
    this.reframe();
    this.renderMarks(page);
    this.scheduleSave();
    return true;
  }

  pendingSelKey(e) {
    const p = this.pendingSel; if (!p) return false;
    if (!this.keyFree(e.target)) return false;
    if (e.key === 'Escape') { this.clearPending(); return true; }
    if (e.key === 'Enter') { e.preventDefault(); this.addMark(p, null); this.clearPending(); return true; }
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const m = this.addMark(p, e.key); this.clearPending();
      requestAnimationFrame(() => { const ta = m && this.find1(`textarea[data-mark="${m.id}"]`); if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } });
      return true;
    }
    return false;
  }

  // The pending selection (merged boxes, see pdfMouseUp), each part drawn into its page's highlight layer until a note is
  // typed or it is dismissed. Over an existing highlight it is drawn on top of it. `page`: that page's part only.
  showPending(page) {
    const p = this.pendingSel; if (!p) return;
    if (page == null) this.hidePending();
    for (const part of p.parts) {
      if (page != null && part.page !== page) continue;
      const hl = this.find1(`[data-hl="${part.page}"]`); if (!hl) continue;
      const g = document.createElementNS(SVG, 'g'); g.dataset.pending = '1';
      for (const r of part.rects) {
        const el = document.createElementNS(SVG, 'rect');
        el.setAttribute('x', r.x); el.setAttribute('y', r.y); el.setAttribute('width', r.w); el.setAttribute('height', r.h); el.setAttribute('fill', 'rgba(0,112,243,.22)');
        g.appendChild(el);
      }
      hl.appendChild(g);
    }
  }
  hidePending() { const host = this.host.current; if (host) host.querySelectorAll('[data-pending]').forEach((n) => n.remove()); }
  clearPending() { this.pendingSel = null; this.hidePending(); }

  // p carries pixel geometry from the current layout; the stored marks are in page units. A free note (`pos`) is p.page's
  // alone. A selection (`p.parts`) is one mark a part, on its own page (./marks.js partMarks): the parts of a selection
  // across pages share a `group` id, and only the first has the note. Each is placed among its page's marks (./marks.js
  // placeHighlight): inside one already there it adds nothing, and overlapping ones without notes become one. Answers
  // the mark that holds the first part (or the free note), whose note a caller may focus.
  addMark(p, note, pos) {
    if (pos) {
      const { G, pageW } = this.geom(p.page), u = pageW || 1;
      const m = { id: markId(), rects: [], side: p.side, y: p.y / u, note, text: p.text, pos: { x: (pos.x - G) / u, y: pos.y / u } };
      this.editing = m.id; // a new note opens as its field, for the caller to focus
      this.marks[p.page] = [...(this.marks[p.page] || []), m];
      this.renderMarks(p.page);
      this.scheduleSave();
      return m;
    }
    let first = null;
    for (const { page, mark } of partMarks(p.parts, note, markId, (n) => this.geom(n).pageW)) {
      const placed = placeHighlight(this.marks[page] || [], mark);
      this.marks[page] = placed.list;
      if (!first) { first = placed.mark; if (note != null) this.editing = first.id; }
      this.renderMarks(page);
    }
    this.scheduleSave();
    return first;
  }

  renderAllMarks() {
    const host = this.host.current; if (!host) return;
    this.libDrawn = this.libKey();
    for (const wrap of host.querySelectorAll('[data-page]')) this.renderMarks(Number(wrap.dataset.page));
  }

  // Highlights are drawn once a page: every mark's rects merged (./marks.js mergeLineRects), one zigzag a box, seeded by
  // where the box is so it keeps its shape between renders and zooms. Marks overlapping each other, or saved with
  // doubled rects, draw no darker. A note being typed in when its page is drawn again (a mark added beside it, a free note
  // fitted once the text is drawn, a rename) has the keyboard back after.
  // Boxes (MATH-27): a mark with a note or an answer is a chain, its note's box, a box for each answer (`asks`), then
  // one for each answer being written (`pendingAsks`). Each box is where it was moved to (`pos`), else under the box
  // before it, else (the first of its chain) on the desk beside its highlight, on its `side`. The boxes not moved are then
  // spaced (arrange), and the arrow from the highlight and the lines between boxes drawn where they ended up (drawLinks).
  renderMarks(page) {
    const hl = this.find1(`[data-hl="${page}"]`), notes = this.find1(`[data-notes="${page}"]`), ar = this.find1(`[data-arrows="${page}"]`);
    if (!hl || !notes) return;
    const { G, pageW } = this.geom(page), u = pageW;
    const active = document.activeElement;
    const had = active && active.tagName === 'TEXTAREA' && notes.contains(active) ? { id: active.dataset.mark, a: active.selectionStart, b: active.selectionEnd } : null;
    this.redrawing += 1;
    try { hl.innerHTML = ''; notes.innerHTML = ''; if (ar) ar.innerHTML = ''; } finally { this.redrawing -= 1; }
    const rc = rough ? rough.svg(hl) : null;
    const list = (this.marks || {})[page] || [];
    for (const b of mergeLineRects(list.flatMap((m) => m.rects || []))) {
      const r = { x: b.x * u, y: b.y * u, w: b.w * u, h: b.h * u };
      if (rc) hl.appendChild(rc.rectangle(r.x, r.y + r.h * 0.15, r.w, r.h * 0.7, { fill: 'rgba(0,112,243,.14)', fillStyle: 'zigzag', fillWeight: 1.2, hachureGap: 2.6, hachureAngle: -4, stroke: 'none', roughness: 0.9, seed: boxSeed(page, b) }));
      else { const d = document.createElementNS(SVG, 'rect'); d.setAttribute('x', r.x); d.setAttribute('y', r.y); d.setAttribute('width', r.w); d.setAttribute('height', r.h); d.setAttribute('fill', 'rgba(0,112,243,.12)'); hl.appendChild(d); }
    }
    const boxes = [], units = [], chains = [], running = this.pendingOn(page);
    list.forEach((m, k) => {
      const asks = shownAsks(m), runs = running.filter((p) => p.markId === m.id);
      if (m.note == null && !asks.length && !runs.length) return;
      const side = m.side === 'left' ? 'left' : 'right';
      const chain = { m, k: k + 1, rects: (m.rects || []).map((r) => ({ x: G + r.x * u, y: r.y * u, w: r.w * u, h: r.h * u })), boxes: [] };
      const parts = [];
      if (m.note != null) parts.push({ kind: 'note', pos: m.pos || null });
      for (const a of asks) parts.push({ kind: 'ask', ask: a, pos: a.pos || null });
      for (const p of runs) parts.push({ kind: 'run', run: p, pos: null });
      let unit = null, prev = null;
      for (const part of parts) {
        const el = part.kind === 'note' ? this.noteBox(m, page) : part.kind === 'ask' ? this.askBox(m, part.ask, page) : this.runBox(part.run, page);
        notes.appendChild(el);
        const ta = el.querySelector('textarea');
        if (ta) this.fitNote(ta);
        const b = { el, kind: part.kind, m, ask: part.ask || null, page, fixed: !!part.pos, pos: part.pos, how: 'pos', left: 0, top: 0, width: 0, height: 0 };
        if (part.pos) { Object.assign(b, placeOf(part.pos, G, u || 1)); unit = null; }
        else {
          if (!unit) { unit = { id: `${m.id}:${chain.boxes.length}`, want: Math.max(0, m.y * u - 6), side: prev ? null : side, parent: prev, boxes: [] }; units.push(unit); }
          b.how = unit.parent ? 'hang' : side;
          unit.boxes.push(b);
        }
        boxes.push(b); chain.boxes.push(b); prev = b;
      }
      chains.push(chain);
    });
    this.drawn[page] = { boxes, units, chains };
    this.arrange(page);
    // Clearing the highlight layer took the pending selection with it.
    this.showPending(page);
    if (had) {
      const ta = notes.querySelector(`textarea[data-mark="${had.id}"]`);
      if (ta) { ta.focus({ preventScroll: true }); try { ta.setSelectionRange(had.a, had.b); } catch { /* not a text field */ } }
    }
    const open = this.state.mention;
    if (open && open.page === page) {
      const ta = notes.querySelector(`textarea[data-mark="${open.markId}"]`);
      if (ta && document.activeElement === ta) this.setState({ mention: { ...open, anchor: fieldCaret(ta) } }); else this.closeMention();
    }
    this.syncOffscreenSoon();
  }

  /* ---------------------------------------------------------------- boxes (MATH-27) */
  // The spacing pass (./canvas.js spaceBoxes), on every draw and while a box is dragged: every box measured; a unit
  // beside its page goes against the page's edge (a left one's right edge to it), one under a moved box hangs from that
  // box's edge nearest the page's middle; each then goes as high as it wants with BOX_GAP from any box it shares x with.
  arrange(page) {
    const model = this.drawn[page];
    if (!model) return;
    const { G, pageW } = this.geom(page), mid = G + pageW / 2;
    for (const b of model.boxes) { b.width = b.el.offsetWidth; b.height = b.el.offsetHeight; }
    const fixed = model.boxes.filter((b) => b.fixed);
    for (const b of fixed) { b.el.style.left = `${b.left}px`; b.el.style.top = `${b.top}px`; }
    const shaped = model.units.filter((unit) => unit.boxes.length).map((unit) => {
      const p = unit.parent;
      if (p) {
        for (const b of unit.boxes) { b.left = hangLeft(p.left, p.width, b.width, mid); b.from = p; }
        return { unit, want: p.top + p.height + BOX_GAP };
      }
      for (const b of unit.boxes) b.left = unit.side === 'left' ? G - SIDE_GAP - b.width : G + pageW + SIDE_GAP;
      return { unit, want: unit.want };
    });
    const tops = spaceBoxes(shaped.map(({ unit, want }) => ({ id: unit.id, want, boxes: unit.boxes.map((b) => ({ left: b.left, width: b.width, height: b.height })) })), fixed);
    for (const { unit } of shaped) {
      let t = tops.get(unit.id);
      for (const b of unit.boxes) { b.top = t; b.el.style.left = `${b.left}px`; b.el.style.top = `${t}px`; t += b.height + BOX_GAP; }
    }
    this.drawLinks(page);
  }

  // The arrow from each highlight to the first box of its chain, wherever that box is, and a short line between each box
  // and the next.
  drawLinks(page) {
    const ar = this.find1(`[data-arrows="${page}"]`), model = this.drawn[page];
    if (!ar || !model) return;
    ar.innerHTML = '';
    const ra = rough ? rough.svg(ar) : null;
    for (const chain of model.chains) {
      if (!chain.boxes.length) continue;
      if (ra && chain.rects.length) this.drawArrow(ra, ar, chain, chain.boxes[0], page);
      for (let i = 1; i < chain.boxes.length; i += 1) this.drawJoin(ar, chain.boxes[i - 1], chain.boxes[i]);
    }
  }
  drawArrow(ra, ar, chain, box, page) {
    const rects = chain.rects, first = rects[0], last = rects[rects.length - 1];
    const hlL = Math.min(...rects.map((r) => r.x)), hlR = Math.max(...rects.map((r) => r.x + r.w));
    const bl = box.left, br = box.left + box.width, bt = box.top, bb = box.top + box.height, ny0 = bt + Math.min(18, box.height / 2);
    let ax, ay, nx, ny, sway;
    if (bl >= hlR) { ax = first.x + first.w + 3; ay = first.y + first.h / 2; nx = bl - 2; ny = ny0; sway = [0, 6]; }
    else if (br <= hlL) { ax = first.x - 3; ay = first.y + first.h / 2; nx = br + 2; ny = ny0; sway = [0, -6]; }
    else if (bt >= last.y + last.h) { ax = last.x + last.w / 2; ay = last.y + last.h + 3; nx = clamp(ax, bl + 12, br - 12); ny = bt - 2; sway = [6, 0]; }
    else { ax = first.x + first.w / 2; ay = first.y - 3; nx = clamp(ax, bl + 12, br - 12); ny = bb + 2; sway = [-6, 0]; }
    const mx = (ax + nx) / 2 + sway[0], my = (ay + ny) / 2 + sway[1];
    const opts = { stroke: 'rgba(0,112,243,.35)', strokeWidth: 1.1, roughness: 1.4, bowing: 1.2, seed: page * 13 + chain.k };
    ar.appendChild(ra.curve([[ax, ay], [mx, my], [nx, ny]], opts));
    const dx = nx - mx, dy = ny - my, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len, hx = nx - ux * 7, hy = ny - uy * 7;
    ar.appendChild(ra.line(nx, ny, hx - uy * 3.5, hy + ux * 3.5, opts));
    ar.appendChild(ra.line(nx, ny, hx + uy * 3.5, hy - ux * 3.5, opts));
  }
  drawJoin(ar, a, b) {
    const lo = Math.max(a.left, b.left), hi = Math.min(a.left + a.width, b.left + b.width);
    let x1, y1, x2, y2;
    if (hi - lo >= 16 && b.top >= a.top + a.height) { x1 = x2 = (lo + hi) / 2; y1 = a.top + a.height; y2 = b.top; }
    else if (hi - lo >= 16 && a.top >= b.top + b.height) { x1 = x2 = (lo + hi) / 2; y1 = a.top; y2 = b.top + b.height; }
    else if (b.left >= a.left + a.width) { x1 = a.left + a.width; y1 = a.top + Math.min(18, a.height / 2); x2 = b.left; y2 = b.top + Math.min(18, b.height / 2); }
    else { x1 = a.left; y1 = a.top + Math.min(18, a.height / 2); x2 = b.left + b.width; y2 = b.top + Math.min(18, b.height / 2); }
    const line = document.createElementNS(SVG, 'line');
    line.setAttribute('x1', x1); line.setAttribute('y1', y1); line.setAttribute('x2', x2); line.setAttribute('y2', y2);
    line.setAttribute('stroke', '#cfcfcf'); line.setAttribute('stroke-width', '1.2'); line.setAttribute('stroke-linecap', 'round');
    ar.appendChild(line);
  }

  // A note's box: the grip, then its field (being typed in, empty, or with nowhere for a mention to go) or its text. A
  // free note keeps to the room before the printed text beside it, as it always did; a highlight's is NOTE_W wide.
  noteBox(m, page) {
    const { G, pageW } = this.geom(page), u = pageW || 1;
    let width = NOTE_W;
    if (m.pos && !(m.rects || []).length) {
      const at = placeOf(m.pos, G, u);
      width = Math.max(120, Math.min(this.freeWidth(page, at.left, at.top + POS_DY, 22), G + pageW * 0.6));
    }
    const box = document.createElement('div');
    box.dataset.box = 'note'; box.dataset.boxMark = m.id;
    box.style.cssText = `${BOX_LOOK};left:0;top:0;width:${width}px;padding-bottom:4px`;
    box.innerHTML = GRIP_HTML;
    box.onmousedown = (ev) => ev.stopPropagation(); // not a click on the page: no new note, the pending selection stays
    this.grip(box, page);
    if (this.editing === m.id || !String(m.note).trim() || !this.showsNotes()) {
      const ta = this.noteField(m, page);
      ta.style.cssText = `${NOTE_LOOK};display:block;width:100%;box-sizing:border-box;margin:0;border:0;background:transparent;resize:none;overflow:hidden;outline:none`;
      box.appendChild(ta);
    } else {
      const view = this.noteView(m, page);
      view.style.cssText = `${NOTE_LOOK};white-space:pre-wrap;overflow-wrap:break-word;cursor:text`;
      box.appendChild(view);
    }
    return box;
  }

  // An answer's box: the grip, the question in grey and the model, the answer (scrolling inside past 40% of the pane's
  // height), then Continue in workspace, Copy, Delete (⌘Z brings it back) and Collapse. Collapsed it is one line, "Bart ›".
  askBox(m, a, page) {
    const box = document.createElement('div');
    box.dataset.box = 'ask'; box.dataset.boxMark = m.id; box.dataset.ask = String(a.id || '');
    box.onmousedown = (ev) => ev.stopPropagation();
    box.onclick = (ev) => this.askClick(ev, m, a, page);
    if (a.collapsed) {
      box.style.cssText = `${BOX_LOOK};left:0;top:0;width:${COLLAPSED_W}px;padding:0 4px 4px`;
      box.innerHTML = `${GRIP_HTML}<button type="button" data-act="expand" title="${esc(a.question || '')}" style="display:block;width:100%;text-align:left;font-weight:500;color:#171717">Bart ›</button>`;
    } else {
      const model = modelLabel(a.meta), lib = { libName: (id) => this.libName(id) };
      box.style.cssText = `${BOX_LOOK};left:0;top:0;width:${ASK_W}px;max-height:${this.boxMaxHeight()}px;display:flex;flex-direction:column;font:13px/1.55 var(--font-sans);color:#171717`;
      box.innerHTML = GRIP_HTML
        + `<div style="flex:none;display:flex;align-items:baseline;gap:8px;padding:0 12px 6px"><span title="${esc(a.question || '')}" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#8f8f8f">${esc(a.question || '')}</span>${model ? `<span style="flex:none;font-size:11.5px;color:#b5b5b5">${esc(model)}</span>` : ''}</div>`
        + `<div data-ask-body="1" style="flex:1 1 auto;min-height:0;overflow:auto;padding:0 12px 2px;overflow-wrap:anywhere">${answerHtml(a.answer, lib)}</div>`
        + '<div style="flex:none;display:flex;flex-wrap:wrap;gap:2px;padding:4px 6px 2px;border-top:1px solid #f2f2f2">'
        + (this.props.onContinueAsk ? '<button type="button" data-act="continue">Continue in workspace</button>' : '')
        + (this.props.onCopyText ? '<button type="button" data-act="copy">Copy</button>' : '')
        + '<button type="button" data-act="delete">Delete</button><button type="button" data-act="collapse">Collapse</button></div>';
    }
    this.grip(box, page);
    return box;
  }
  boxMaxHeight() { const host = this.host.current; return Math.max(140, Math.round((host && host.clientHeight ? host.clientHeight : 600) * 0.4)); }

  askClick(ev, m, a, page) {
    const link = ev.target.closest && ev.target.closest('a[href]');
    if (link) { // never the app's window: the Stage opens it
      ev.preventDefault(); ev.stopPropagation();
      if (this.props.onOpenLink) this.props.onOpenLink(link.getAttribute('href'));
      return;
    }
    const lib = ev.target.closest && ev.target.closest('[data-lib]');
    if (lib) { ev.preventDefault(); if (this.props.onOpenMention) this.props.onOpenMention(lib.dataset.lib); return; }
    const act = ev.target.closest && ev.target.closest('[data-act]');
    if (!act) return;
    ev.preventDefault();
    const what = act.dataset.act;
    const say = (words, back) => { act.textContent = words; setTimeout(() => { if (act.isConnected) act.textContent = back; }, 1400); };
    if (what === 'copy') { if (this.props.onCopyText) this.props.onCopyText(a.answer || ''); say('Copied', 'Copy'); return; }
    if (what === 'continue') {
      if (this.props.onContinueAsk) this.props.onContinueAsk({ markId: m.id, page, quote: passageOf(this.marks, m), question: a.question || '', answer: a.answer || '', foot: (a.meta && a.meta.foot) || '' });
      say('Added', 'Continue in workspace');
      return;
    }
    // Deleted, an answer is no longer drawn but stays one of the exchange's turns (./canvas.js exchangeOf), and ⌘Z brings it back.
    if (what === 'delete') { a.deleted = true; this.undos.push({ page, markId: m.id, askId: a.id }); }
    else if (what === 'collapse') a.collapsed = true;
    else if (what === 'expand') a.collapsed = false;
    else return;
    this.reframe(); // a box under a moved one that went, or changed width, may have held the desk wide
    this.renderMarks(page);
    this.scheduleSave();
  }

  // An answer being written (`pendingAsks`): no grip, since nothing of it is kept until it lands. Its header says what
  // Bart is doing, with a spinner, and Stop; ▸ shows its steps; the answer comes in once it is writing. A failure says
  // why, with × to close it.
  runBox(p, page) {
    const box = document.createElement('div');
    box.dataset.box = 'run'; box.dataset.askRun = p.askId;
    box.style.cssText = `${BOX_LOOK};left:0;top:0;width:${ASK_W}px;max-height:${this.boxMaxHeight()}px;display:flex;flex-direction:column;padding-top:8px;font:13px/1.55 var(--font-sans);color:#171717`;
    box.onmousedown = (ev) => ev.stopPropagation();
    box.onclick = (ev) => this.runClick(ev, p.askId, page);
    this.fillRun(box, p);
    return box;
  }
  fillRun(box, p) {
    const before = box.querySelector('[data-run-body]'), atEnd = !before || before.scrollTop + before.clientHeight >= before.scrollHeight - 4;
    const failed = p.error != null, log = Array.isArray(p.log) ? p.log : [], open = this.openLogs.has(p.askId);
    const lines = !failed && p.activity === 'Writing' && Array.isArray(p.lines) ? p.lines : [];
    const head = failed
      ? '<span style="flex:1;min-width:0;font-weight:500;color:#171717">Bart · No answer</span><button type="button" data-act="dismiss" aria-label="Close">×</button>'
      : `${SPINNER}<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#4d4d4d">${esc(runningLabel(p))}</span><button type="button" data-act="stop">Stop</button>`;
    box.innerHTML = `<div style="flex:none;display:flex;align-items:center;gap:8px;padding:0 6px 4px 12px">${head}</div>`
      + `<div title="${esc(p.question || '')}" style="flex:none;padding:0 12px 6px;color:#8f8f8f;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.question || '')}</div>`
      + (failed ? `<div style="flex:none;padding:0 12px 8px;color:#c4372d;overflow-wrap:anywhere">${esc(p.error || 'The run failed.')}</div>` : '')
      + (log.length ? `<div style="flex:none;padding:0 6px 4px"><button type="button" data-act="log" aria-expanded="${open}">${open ? '▾' : '▸'} ${log.length} ${log.length === 1 ? 'step' : 'steps'}</button></div>` : '')
      + (open && log.length ? `<div style="flex:none;padding:0 12px 6px;font-size:12px;line-height:1.7;color:#8f8f8f">${log.map((entry) => `<div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(entry)}</div>`).join('')}</div>` : '')
      + (lines.length ? `<div data-run-body="1" style="flex:1 1 auto;min-height:0;overflow:auto;padding:0 12px 8px;color:#8f8f8f;overflow-wrap:anywhere">${answerHtml(lines.join('\n'))}</div>` : '');
    const after = box.querySelector('[data-run-body]');
    if (after && atEnd) after.scrollTop = after.scrollHeight;
  }
  runClick(ev, askId, page) {
    const act = ev.target.closest && ev.target.closest('[data-act]');
    if (!act) return;
    ev.preventDefault();
    const what = act.dataset.act;
    if (what === 'stop' && this.props.onStopAsk) this.props.onStopAsk(askId);
    else if (what === 'dismiss' && this.props.onDismissAsk) this.props.onDismissAsk(askId);
    else if (what === 'log') {
      if (this.openLogs.has(askId)) this.openLogs.delete(askId); else this.openLogs.add(askId);
      const p = (this.props.pendingAsks || []).find((x) => x && x.askId === askId), box = this.find1(`[data-ask-run="${askId}"]`);
      if (p && box) { this.fillRun(box, p); this.arrange(page); }
    }
  }

  // How many answers are being written for mark `id`: each is a box under its others (deskNeed).
  runsOf(id) { return (Array.isArray(this.props.pendingAsks) ? this.props.pendingAsks : []).filter((p) => p && p.askId && p.markId === id).length; }

  // The answers being written for this pdf on a page.
  pendingOn(page) { return (Array.isArray(this.props.pendingAsks) ? this.props.pendingAsks : []).filter((p) => p && p.page === page && p.askId); }

  // What Bart is doing changed: a box that is already there is filled again and its page spaced; one that came or went
  // draws its page again.
  syncPending(before) {
    const now = Array.isArray(this.props.pendingAsks) ? this.props.pendingAsks : [];
    const pages = new Set([...before, ...now].filter(Boolean).map((p) => p.page));
    const ids = (list, page) => list.filter((p) => p && p.page === page).map((p) => `${p.markId}/${p.askId}`).join(',');
    for (const page of pages) {
      if (ids(before, page) !== ids(now, page)) { this.renderMarks(page); continue; }
      let filled = false;
      for (const p of this.pendingOn(page)) {
        const box = this.find1(`[data-ask-run="${p.askId}"]`);
        if (box) { this.fillRun(box, p); filled = true; }
      }
      if (filled) this.arrange(page);
    }
  }

  /** A finished answer, from the Stage (MATH-27): it joins its mark's answers, drawn and saved. → whether the mark is here. */
  addAsk(page, markId, entry) {
    const m = ((this.marks || {})[page] || []).find((x) => x && x.id === markId);
    if (!m || !entry) return false;
    if (!(m.asks || []).some((a) => a && a.id === entry.id)) m.asks = [...(m.asks || []), entry];
    this.reframe(); // under a moved box it holds the desk wide, as its box being written did
    this.renderMarks(page);
    this.scheduleSave();
    return true;
  }

  // Moving a box by its grip. A press that does not move is no drag. Moved, the box leaves the spacing (the boxes that
  // hung under it hang from it now), follows the pointer, widens the desk when it goes past its edge, and on release keeps
  // its place in page units.
  grip(box, page) {
    const grip = box.querySelector('[data-grip]');
    if (grip) grip.onmousedown = (ev) => this.startDrag(ev, box, page);
  }
  startDrag(ev, el, page) {
    if (ev.button !== 0) return;
    ev.preventDefault(); ev.stopPropagation();
    const model = this.drawn[page], b = model && model.boxes.find((x) => x.el === el);
    if (!b || this.drag) return;
    const r = el.getBoundingClientRect(), css = this.css || 1;
    this.closeMention();
    this.drag = { b, page, grabX: (ev.clientX - r.left) / css, grabY: (ev.clientY - r.top) / css, x0: ev.clientX, y0: ev.clientY, at: { x: ev.clientX, y: ev.clientY }, moved: false, raf: 0 };
    window.addEventListener('mousemove', this.onDragMove);
    window.addEventListener('mouseup', this.onDragUp);
  }
  // The box out of the unit it was spaced in: it stays where it is put, and the boxes after it in that unit hang from it.
  detach(model, b) {
    b.fixed = true; b.how = 'pos';
    const unit = model && model.units.find((x) => x.boxes.includes(b));
    if (!unit) return;
    const at = unit.boxes.indexOf(b), after = unit.boxes.slice(at + 1);
    unit.boxes = unit.boxes.slice(0, at);
    if (after.length) { for (const x of after) x.how = 'hang'; model.units.push({ id: `${unit.id}~${at}`, want: 0, side: null, parent: b, boxes: after }); }
  }
  dragTo() {
    const d = this.drag, host = this.host.current, s = d && this.sheets[d.page], g = d && this.geo[d.page];
    if (!d || !host || !s || !g) return;
    if (!d.moved) {
      if (Math.hypot(d.at.x - d.x0, d.at.y - d.y0) < 3) return;
      d.moved = true;
      host.dataset.dragging = '1';
      this.detach(this.drawn[d.page], d.b);
      this.dragTick();
    }
    const css = this.css || 1, b = d.b;
    let wr = s.wrap.getBoundingClientRect();
    b.left = (d.at.x - wr.left) / css - d.grabX;
    b.top = Math.max(-(this.tops[d.page - 1] || 0), (d.at.y - wr.top) / css - d.grabY);
    this.arrange(d.page);
    const extra = this.reach(d.page); // the box, and the answers that hang under it
    if ((extra.left > g.G || extra.right > g.R) && this.reframe(extra)) {
      wr = s.wrap.getBoundingClientRect(); b.left = (d.at.x - wr.left) / css - d.grabX;
      this.arrange(d.page);
    }
  }
  // How far past page n its moved boxes and those hanging under them reach as drawn, DESK_EDGE added → { left, right } px.
  reach(n) {
    const model = this.drawn[n], g = this.geo[n], out = { left: 0, right: 0 };
    if (!model || !g) return out;
    for (const x of model.boxes) {
      if (x.how !== 'pos' && x.how !== 'hang') continue;
      out.left = Math.max(out.left, DESK_EDGE - (x.left - g.G));
      out.right = Math.max(out.right, x.left + x.width + DESK_EDGE - g.G - g.pageW);
    }
    return out;
  }
  // Held near an edge of the pane, the view scrolls that way and the box goes with it.
  dragTick() {
    const d = this.drag, host = this.host.current;
    if (!d || !host || typeof requestAnimationFrame !== 'function') return;
    const r = host.getBoundingClientRect(), edge = 28, speed = 14;
    const dx = d.at.x < r.left + edge ? -speed : d.at.x > r.left + host.clientWidth - edge ? speed : 0;
    const dy = d.at.y < r.top + edge ? -speed : d.at.y > r.top + host.clientHeight - edge ? speed : 0;
    if (dx || dy) {
      const left = host.scrollLeft, top = host.scrollTop;
      host.scrollLeft += dx; host.scrollTop += dy;
      if (host.scrollLeft !== left || host.scrollTop !== top) this.dragTo();
    }
    d.raf = requestAnimationFrame(() => this.dragTick());
  }
  endDrag(cancel = false) {
    const d = this.drag;
    window.removeEventListener('mousemove', this.onDragMove);
    window.removeEventListener('mouseup', this.onDragUp);
    this.drag = null;
    if (!d) return;
    if (d.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(d.raf);
    const host = this.host.current;
    if (host) delete host.dataset.dragging;
    if (!d.moved || cancel) return;
    const g = this.geom(d.page), pos = posOf(d.b.left, d.b.top, g.G, g.pageW || 1);
    if (d.b.kind === 'note') d.b.m.pos = pos; else if (d.b.ask) d.b.ask.pos = pos;
    this.reframe();
    this.renderMarks(d.page);
    this.scheduleSave();
  }

  /* ---------------------------------------------------------------- boxes out of view (MATH-27) */
  viewRect() {
    const host = this.host.current, r = host.getBoundingClientRect();
    return { left: r.left + host.clientLeft, top: r.top + host.clientTop, right: r.left + host.clientLeft + host.clientWidth, bottom: r.top + host.clientTop + host.clientHeight };
  }
  // The boxes of the pages in view, as client rects: a page further on is not "out of view", it is further on.
  boxRects(view) {
    const out = [];
    for (let n = 1; n < this.sheets.length; n += 1) {
      const s = this.sheets[n];
      if (!s) continue;
      const r = s.wrap.getBoundingClientRect();
      if (r.bottom < view.top || r.top > view.bottom) continue;
      for (const el of s.notes.querySelectorAll('[data-box]')) out.push(el.getBoundingClientRect());
    }
    return out;
  }
  syncOffscreen() {
    const host = this.host.current;
    const off = host && this.inner && !this.pan ? offscreen(this.boxRects(this.viewRect()), this.viewRect()) : NO_OFF;
    const was = this.state.off || NO_OFF;
    if (SIDES.some((side) => was[side] !== off[side])) this.setState({ off });
  }
  syncOffscreenSoon() {
    if (this.offRaf || typeof requestAnimationFrame !== 'function') return;
    this.offRaf = requestAnimationFrame(() => { this.offRaf = 0; this.syncOffscreen(); });
  }
  // A chip: the boxes off its edge scrolled into view (all of them when they fit, else the nearest).
  reveal(side) {
    const host = this.host.current;
    if (!host) return;
    const view = this.viewRect();
    const { dx, dy } = revealScroll(this.boxRects(view).filter((r) => offscreenSide(r, view) === side), view, side);
    if (typeof host.scrollBy === 'function') host.scrollBy({ left: dx, top: dy, behavior: 'smooth' });
    else { host.scrollLeft += dx; host.scrollTop += dy; }
  }

  /* ---------------------------------------------------------------- notes (MATH-21: mentions) */
  // Notes are shown as text, their mentions links, once there is somewhere for a link to go.
  showsNotes() { return typeof this.props.onOpenMention === 'function'; }
  fitNote(ta) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }

  // A mentioned item's name now: null when the library no longer holds it; undefined (the name it was mentioned by)
  // when there is no library to ask, or none yet.
  libName(id) {
    const lib = this.props.library;
    if (!Array.isArray(lib) || !lib.length) return undefined;
    const row = lib.find((r) => r && r.id === id);
    return row ? row.name || '' : null;
  }
  // The names now of every item the notes mention, as one string: the notes are drawn again when it changes.
  libKey() {
    const ids = new Set();
    for (const list of Object.values(this.marks || {})) {
      for (const m of list || []) if (m && m.note) for (const part of noteParts(m.note)) { const t = part.match(LIB_MENTION_RE); if (t) ids.add(t[2]); }
    }
    return [...ids].sort().map((id) => `${id}\t${this.libName(id)}`).join('\n');
  }

  // A note being typed in: its text, saved as it changes, and the @ menu opened by what stands before the caret.
  noteField(m, page) {
    const ta = document.createElement('textarea');
    ta.dataset.mark = m.id; ta.value = m.note; ta.rows = 1; ta.spellcheck = false;
    ta.oninput = () => { m.note = ta.value; this.fitNote(ta); this.scheduleSave(); this.noteMention(ta, m, page); };
    ta.onfocus = () => { this.editing = m.id; };
    ta.onblur = () => this.leaveNote(ta, m, page);
    ta.onkeydown = (ev) => this.noteKey(ev, ta, m, page);
    // The caret moved along the line: the menu follows what stands before it now (↑ and ↓ are the menu's).
    ta.onkeyup = (ev) => { if (/^(ArrowLeft|ArrowRight|Home|End)$/.test(ev.key) && this.state.mention && this.state.mention.markId === m.id) this.noteMention(ta, m, page); };
    ta.onmousedown = (ev) => ev.stopPropagation();
    return ta;
  }
  // A note no one is typing in, as text: a mention opens its item; a click anywhere else is a click into its field.
  noteView(m, page) {
    const view = document.createElement('div');
    view.dataset.noteView = m.id;
    view.innerHTML = noteHtml(m.note, { libName: (id) => this.libName(id) });
    view.onmousedown = (ev) => {
      ev.stopPropagation(); // not a click on the page: no new note, the pending selection stays (as in a field)
      if (ev.button !== 0) return;
      ev.preventDefault();
      if (ev.target.closest && ev.target.closest('[data-lib]')) return; // its click opens it
      this.editNote(m, page, this.noteCaret(view, m, ev));
    };
    view.onclick = (ev) => {
      const link = ev.target.closest && ev.target.closest('[data-lib]');
      if (!link) return;
      ev.preventDefault(); ev.stopPropagation();
      if (this.props.onOpenMention) this.props.onOpenMention(link.dataset.lib);
    };
    return view;
  }
  // Where in the note's text a click on its shown text lands (model/doc.js noteOffset); null when it cannot be told.
  noteCaret(view, m, ev) {
    const r = typeof document.caretRangeFromPoint === 'function' ? document.caretRangeFromPoint(ev.clientX, ev.clientY) : null;
    if (!r || !view.contains(r.startContainer)) return null;
    let node = r.startContainer;
    if (node === view) return r.startOffset ? noteOffset(m.note, r.startOffset - 1, Infinity) : 0; // between two pieces
    while (node.parentNode !== view) node = node.parentNode;
    return noteOffset(m.note, [...view.childNodes].indexOf(node), node === r.startContainer && node.nodeType === Node.TEXT_NODE ? r.startOffset : Infinity);
  }
  // The note's field in place of its text, with the keyboard and the caret at `at` (the end when null). The note typed
  // in until now is left first, as a click away from it leaves it: an empty one goes, a written one shows as text.
  editNote(m, page, at) {
    const host = this.host.current, active = document.activeElement;
    if (host && active && active.tagName === 'TEXTAREA' && active.dataset.mark && host.contains(active)) active.blur();
    this.editing = m.id;
    this.renderMarks(page);
    const ta = this.find1(`textarea[data-mark="${m.id}"]`);
    if (!ta) return;
    ta.focus({ preventScroll: true });
    const pos = at == null ? ta.value.length : Math.max(0, Math.min(at, ta.value.length));
    ta.setSelectionRange(pos, pos);
  }
  // The keyboard left a note's field. Empty, the note goes (a highlight keeps its mark); written, it shows as text a frame
  // later, so a click that moved the keyboard to another field on the page is not undone by drawing the page again. A
  // field taken out to be drawn again was not left; the app going to the background leaves it as it is.
  leaveNote(ta, m, page) {
    if (this.redrawing || !ta.isConnected) return;
    if (this.state.mention && this.state.mention.markId === m.id) this.closeMention();
    if (!ta.value.trim()) {
      if (this.editing === m.id) this.editing = null;
      const list = this.marks[page] || [], at = list.indexOf(m);
      if (m.rects.length) m.note = null; else if (at >= 0) list.splice(at, 1);
      this.renderMarks(page);
      this.scheduleSave();
      return;
    }
    if (document.activeElement === ta) return;
    if (this.editing === m.id) this.editing = null;
    if (this.showsNotes()) requestAnimationFrame(() => { if (this.editing !== m.id) this.renderMarks(page); });
  }

  // The @ menu in a note (as in a follow-up field, DocEditor followMention): open while an `@word` stands before the caret.
  noteMention(ta, m, page) {
    const found = typeof this.props.mentionItems === 'function' ? mentionAt(ta.value, ta.selectionStart) : null;
    if (found) this.setState({ mention: { markId: m.id, page, query: found.query, start: found.start, anchor: fieldCaret(ta) }, mentionIdx: 0 });
    else this.closeMention();
  }
  closeMention() { if (this.state.mention) this.setState({ mention: null }); }
  // A note that can ask Bart (MATH-27): one on a highlight, with somewhere to send the question. A free note has no passage.
  asksFrom(m) { return typeof this.props.onAsk === 'function' && !!m && Array.isArray(m.rects) && m.rects.length > 0; }
  pageOf(m) { for (const [page, list] of Object.entries(this.marks || {})) if ((list || []).includes(m)) return Number(page); return 0; }
  // The menu's rows: library items, and Bart where it can ask (MATH-27): a highlight's note, at its start. A note does not
  // ask the other agents, make a note, name a workspace or a page the library does not hold.
  mentionList() {
    const open = this.state.mention;
    if (!open || typeof this.props.mentionItems !== 'function') return [];
    const m = ((this.marks || {})[open.page] || []).find((x) => x && x.id === open.markId);
    const bart = this.asksFrom(m) && !String((m && m.note) || '').slice(0, open.start).trim();
    return (this.props.mentionItems(open.query.toLowerCase()) || []).filter((r) => r && ((r.kind === 'item' && r.row && r.row.id) || (bart && r.kind === 'verb' && r.verb === 'bart')));
  }
  // Keys in a note's field: the menu's first while it is open (↑ ↓ move, Enter or Tab picks, Escape closes it alone),
  // then Enter in a highlight's note that starts with @bart asks (Shift+Enter is a new line), then Escape leaves the note.
  // None reaches the page or the Stage.
  noteKey(ev, ta, m, page) {
    ev.stopPropagation();
    const items = this.state.mention && this.state.mention.markId === m.id ? this.mentionList() : [];
    if (items.length) {
      const n = items.length;
      if (ev.key === 'ArrowDown') { ev.preventDefault(); this.setState({ mentionIdx: (this.state.mentionIdx + 1) % n }); return; }
      if (ev.key === 'ArrowUp') { ev.preventDefault(); this.setState({ mentionIdx: (this.state.mentionIdx - 1 + n) % n }); return; }
      if ((ev.key === 'Enter' || ev.key === 'Tab') && !ev.isComposing) { ev.preventDefault(); this.pickMention(items[this.state.mentionIdx] || items[0]); return; }
      if (ev.key === 'Escape') { ev.preventDefault(); this.closeMention(); return; }
    }
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && this.asksFrom(m)) {
      const question = noteQuestion(ta.value);
      if (question != null) {
        ev.preventDefault();
        if (question) this.askFrom(ta, m, page || this.pageOf(m), question);
        return;
      }
    }
    if (ev.key === 'Escape') ta.blur();
  }
  // Bart asked from a highlight's note: the passage (all of it, when the highlight is part of a selection across pages),
  // the note as it stands and the question go up (the Stage adds which pdf), with the mark's earlier answers as the turns,
  // deleted ones too while their session lasts (./canvas.js exchangeOf), so a follow-up within half an hour resumes the
  // same session. The note keeps what was typed and shows as text; the answer's box comes under it.
  askFrom(ta, m, page, question) {
    m.note = ta.value;
    this.flushSave(this.props.onMarksChange);
    this.closeMention();
    this.props.onAsk({ markId: m.id, page, quote: passageOf(this.marks, m), note: m.note, question, turns: turnsOf(m) });
    if (this.editing === m.id) this.editing = null;
    ta.blur();
  }
  // A row picked: its token takes the place of `@query`, then a space (one there already is stepped over), and the note
  // keeps the keyboard. The item is only mentioned: nothing is added to the workspace. Bart's row writes `@Bart `.
  pickMention(r) {
    const open = this.state.mention;
    this.closeMention();
    const bart = !!r && r.kind === 'verb' && r.verb === 'bart';
    if (!open || !r || (!bart && (!r.row || !r.row.id))) return;
    const ta = this.find1(`textarea[data-mark="${open.markId}"]`), m = ((this.marks || {})[open.page] || []).find((x) => x.id === open.markId);
    if (!ta || !m) return;
    if (document.activeElement !== ta) ta.focus({ preventScroll: true });
    const end = ta.selectionStart, found = mentionAt(ta.value, end), start = found ? found.start : open.start;
    if (start > end) return;
    if (bart) {
      ta.setRangeText('@Bart ', start, end, 'end');
      if (ta.value.charAt(ta.selectionEnd) === ' ') ta.setRangeText('', ta.selectionEnd, ta.selectionEnd + 1, 'end');
      m.note = ta.value;
      this.fitNote(ta);
      this.scheduleSave();
      return;
    }
    ta.setRangeText(libMention(r.name, r.row.id), start, end, 'end');
    if (ta.value.charAt(ta.selectionEnd) === ' ') ta.setSelectionRange(ta.selectionEnd + 1, ta.selectionEnd + 1);
    else ta.setRangeText(' ', ta.selectionEnd, ta.selectionEnd, 'end');
    m.note = ta.value;
    this.fitNote(ta);
    this.scheduleSave();
  }

  /* ---------------------------------------------------------------- render */
  render() {
    const { title } = this.props;
    const { note, page, pages, pct } = this.state, off = this.state.off || NO_OFF;
    return (
      <div ref={this.root} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: title ? 12 : 0 }}>
        <style>{LAYER_CSS}</style>
        {title ? (
          <>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, padding: '14px 20px 0' }}>
              <h3 style={{ margin: 0, font: '600 15px/1.4 var(--font-sans)', color: '#171717', textWrap: 'pretty' }}>{title}</h3>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }} />
          </>
        ) : null}
        <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div ref={this.host} data-pdf="1" style={{ flex: 1, minHeight: 0, overflow: 'auto', border: 0, borderTop: title ? '1px solid #eaeaea' : 0, borderRadius: 0, background: '#fafafa', padding: 0 }} />
          {note
            ? <span style={{ position: 'absolute', left: 0, right: 0, top: 14, textAlign: 'center', font: '12px/1.5 var(--font-sans)', color: '#8f8f8f', pointerEvents: 'none' }}>{note}</span>
            : null}
          {!note && SIDES.map((side) => (off[side] ? <div key={`fade-${side}`} data-fade={side} style={fadeStyle(side)} /> : null))}
          {!note && SIDES.map((side) => (off[side] ? (
            <button key={`chip-${side}`} type="button" data-chip={side} className="hov-wash" style={chipStyle(side)} onMouseDown={(e) => e.preventDefault()} onClick={() => this.reveal(side)}>{chipLabel(off[side], side)}</button>
          ) : null))}
          {this.state.mention && this.state.mention.anchor ? (
            <MentionMenu items={this.mentionList()} index={this.state.mentionIdx} anchor={this.state.mention.anchor} onPick={(r) => this.pickMention(r)} onHover={(i) => this.setState({ mentionIdx: i })} />
          ) : null}
          {!note && pages > 0 ? (
            <div style={BAR} title="pinch, or ⌘ or ⌃ scroll, to zoom" onMouseDown={(e) => e.preventDefault()}>
              <span style={{ color: '#171717', minWidth: `${String(pages).length}ch`, textAlign: 'right' }}>{page}</span>
              <span style={{ margin: '0 4px', color: '#8f8f8f' }}>of {pages}</span>
              <span style={{ flex: 'none', width: 1, height: 16, margin: '0 6px', background: '#eaeaea' }} />
              <button type="button" className="hov-wash" aria-label="Zoom out" style={BAR_STEP} onClick={() => this.zoomStepBy(-1)}>−</button>
              <button type="button" className="hov-wash" title="100% = fit width" style={BAR_PCT} onClick={() => this.togglePct()}>{pct}%</button>
              <button type="button" className="hov-wash" aria-label="Zoom in" style={BAR_STEP} onClick={() => this.zoomStepBy(1)}>+</button>
              <span style={{ flex: 'none', width: 1, height: 16, margin: '0 4px', background: '#eaeaea' }} />
              <button type="button" className="hov-wash" title="The page in view, whole" style={BAR_FIT} onClick={() => this.fitPage(false)}>Fit page</button>
              <button type="button" className="hov-wash" title="The page in view and every note and answer beside it" style={BAR_FIT} onClick={() => this.fitPage(true)}>Fit page + notes</button>
            </div>
          ) : null}
        </div>
      </div>
    );
  }
}
