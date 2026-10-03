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
// page and zoom; a pinch (or ⌃ scroll) zooms around the pointer.
// `target` (2026-09-30): a passage a link asked for. Once every page is drawn it is found from page 1, scrolled to and
// painted as find's match in front, and told through onFind and onTarget(text, result); once per target, until the
// prop is cleared and given again. Nothing matching leaves the scroll where it is. `targetTo` (@discover round 2): the
// first words of the section after it; the stretch from the passage to just before them, up to six pages on, is tinted
// (SECTION) until find stops. Never ink.
import React from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import rough from 'roughjs';
import { mergeLineRects, placeHighlight, sideOf, boxSeed } from './marks.js';
import { nextFind, createTargetGate, sectionSpans, paintSection, clearFind, FIND, FIND_ACTIVE, SECTION } from '../model/find.js';

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
/** Side space that centers a page of width pageW in a pane of width W (0 once the page is wider). */
export const sideSpace = (W, pageW) => Math.max(0, Math.floor((W - pageW) / 2));
/** Canvas pixels per CSS px: 2×, capped so one page's canvas stays near 4 million device pixels. */
export const canvasScale = (cssW, cssH) => Math.min(2, Math.sqrt(4e6 / Math.max(1, cssW * cssH)));
const PINCH_SETTLE_MS = 180;

// pdf.js 6 positions text-layer spans through CSS custom properties (--font-height,
// --scale-x, --rotate, --total-scale-factor); these rules mirror pdf_viewer.css for the
// design's .pdf-text container so selection rectangles line up with the printed text.
const LAYER_CSS = `
[data-pdf] .pdf-text{color-scheme:only light;overflow:clip;opacity:1;letter-spacing:normal;word-spacing:normal;caret-color:CanvasText;z-index:0;--min-font-size:1;--text-scale-factor:calc(var(--total-scale-factor) * var(--min-font-size));--min-font-size-inv:calc(1 / var(--min-font-size))}
[data-pdf] .pdf-text :is(span,br){color:transparent;position:absolute;white-space:pre;cursor:text;transform-origin:0% 0%;user-select:text}
[data-pdf] .pdf-text > :not(.markedContent),[data-pdf] .pdf-text .markedContent span:not(.markedContent){z-index:1;--font-height:0;font-size:calc(var(--text-scale-factor) * var(--font-height));--scale-x:1;--rotate:0deg;transform:rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv))}
[data-pdf] .pdf-text .markedContent{display:contents}
[data-pdf] .pdf-text .endOfContent{display:none}
[data-pdf] .pdf-text span[role="img"]{user-select:none;cursor:default}
::highlight(pdf-section){background-color:rgba(255,196,0,.13)}
::highlight(pdf-find){background-color:rgba(255,196,0,.35)}
::highlight(pdf-find-active){background-color:rgba(255,140,0,.6)}
`;

// The page-and-zoom bar (Stage design).
const BAR = { position: 'absolute', left: '50%', bottom: 16, transform: 'translateX(-50%)', display: 'flex', alignItems: 'center', gap: 2, height: 34, boxSizing: 'border-box', padding: '0 4px 0 12px', background: '#fff', border: '1px solid #eaeaea', borderRadius: 8, font: '400 12.5px/1 var(--font-sans)', fontVariantNumeric: 'tabular-nums', color: '#4d4d4d', whiteSpace: 'nowrap', zIndex: 5 };
const BAR_STEP = { flex: 'none', width: 26, height: 26, padding: 0, borderRadius: 6, border: 0, background: 'transparent', font: '400 14px/1 var(--font-sans)', color: '#4d4d4d', cursor: 'pointer' };
const BAR_PCT = { flex: 'none', minWidth: 48, height: 26, padding: '0 6px', borderRadius: 6, border: 0, background: 'transparent', font: '500 12.5px/1 var(--font-sans)', fontVariantNumeric: 'tabular-nums', color: '#171717', cursor: 'pointer' };

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
const markId = () => 'm' + Date.now() + Math.random().toString(36).slice(2, 6);
const isEditable = (t) => !!(t && t.closest && t.closest('input,textarea,[contenteditable="true"]'));
const SVG = 'http://www.w3.org/2000/svg';

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
    this.state = { note: 'Opening the paper…', page: 0, pages: 0, pct: 100 };
    this.host = React.createRef();
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
    this.onDown = (e) => {
      if (!(e.target.closest && e.target.closest('[data-pdf] [data-page]'))) return;
      this.pdfDown = { x: e.clientX, y: e.clientY };
      if (!e.target.closest('textarea')) this.clearPending();
    };
    this.onUp = (e) => this.pdfMouseUp(e);
    this.onKeyCapture = (e) => { if (this.pendingSelKey(e)) e.stopPropagation(); };
    this.onWheel = (e) => this.pinch(e);
    this.onScroll = () => {
      if (this.scrollRaf) return;
      this.scrollRaf = requestAnimationFrame(() => { this.scrollRaf = 0; this.syncBar(); });
    };
    this.findQuery = '';
    this.findAt = -1;
    this.findRanges = [];
    this.findSpots = []; // where each of findRanges is: { page, from, to } in its page's text
    this.section = null; // { text, to }: a link's section, while find shows its passage
    this.gate = createTargetGate();
    this.gate.set(targetKey(props.target, props.targetTo));
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
  }

  componentDidMount() {
    const host = this.host.current;
    host.addEventListener('mousedown', this.onDown);
    host.addEventListener('mouseup', this.onUp);
    host.addEventListener('wheel', this.onWheel, { passive: false });
    host.addEventListener('scroll', this.onScroll, { passive: true });
    window.addEventListener('keydown', this.onKeyCapture, true);
    this.ro = new ResizeObserver(() => this.onResize());
    this.ro.observe(host);
    this.load();
  }

  componentDidUpdate(prev) {
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
      // was edited here in the meantime.
      this.marks = clone(this.props.marks || {});
      this.renderAllMarks();
    }
  }

  componentWillUnmount() {
    const host = this.host.current;
    if (host) {
      host.removeEventListener('mousedown', this.onDown);
      host.removeEventListener('mouseup', this.onUp);
      host.removeEventListener('wheel', this.onWheel);
      host.removeEventListener('scroll', this.onScroll);
    }
    window.removeEventListener('keydown', this.onKeyCapture, true);
    if (this.ro) this.ro.disconnect();
    clearTimeout(this.resizeTimer);
    clearTimeout(this.pinchTimer);
    if (this.scrollRaf) cancelAnimationFrame(this.scrollRaf);
    this.flushSave(this.props.onMarksChange);
    this.gen += 1;
    this.cancelLayout();
    this.stopFind();
    if (this.doc) { const d = this.doc; this.doc = null; destroyDoc(d); }
  }

  // In this viewer only: the Paper pane and a pdf in the Browser pane can both be open, with the same page numbers.
  find1(selector) { const host = this.host.current; return host ? host.querySelector(selector) : null; }

  // A page's drawn geometry (falls back to page 1's before the first layout).
  geom(page) { return this.geo[page] || { G: this.pdfG || 0, pageW: this.pageW || 1 }; }

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
    const out = {};
    for (const [page, list] of Object.entries(this.marks)) if (list && list.length) out[page] = clone(list);
    cb(out);
  }

  /* ---------------------------------------------------------------- loading */
  async load() {
    const gen = ++this.gen;
    this.cancelLayout();
    clearTimeout(this.pinchTimer); this.pinchTimer = null;
    if (this.doc) { const d = this.doc; this.doc = null; destroyDoc(d); }
    const host = this.host.current;
    if (host) host.replaceChildren();
    this.resetGeometry();
    this.pdfW = null;
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

  // Trackpad pinch (and ⌃ scroll) arrive as wheel events with ctrlKey. The drawn sheets are scaled
  // with CSS zoom at once (scroll geometry stays real), and laid out again once the pinch settles.
  pinch(e) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    if (!this.doc || !this.inner) return;
    // A mouse wheel notch is ~100px (or 3 lines); limit one event to about ×1.65 so ⌃ + wheel stays usable.
    const dy = clamp(e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY, -50, 50);
    const from = this.live != null ? this.live : this.zoom;
    const to = clamp(from * Math.exp(-dy * 0.01), ZOOM_MIN, ZOOM_MAX);
    if (to !== from) {
      const a = this.anchorAt(e.clientX, e.clientY);
      this.live = to;
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
    for (let n = 1; n < this.geo.length; n += 1) {
      const g = this.geo[n], s = this.sheets[n];
      if (!g || !s) continue;
      g.G = sideSpace(W, g.pageW);
      this.place(n);
    }
    if (this.geo[1]) this.pdfG = this.geo[1].G;
    this.renderAllMarks();
  }

  /* ---------------------------------------------------------------- layout */
  // Everything about a sheet that depends on its geometry (side space, page size).
  place(n) {
    const g = this.geo[n], s = this.sheets[n];
    const { G, pageW, pageH } = g, sheetW = pageW + 2 * G;
    s.wrap.style.width = `${sheetW}px`;
    s.wrap.style.height = `${pageH}px`;
    if (s.canvas) s.canvas.style.cssText = `position:absolute;left:${G}px;top:0;width:${pageW}px;height:${pageH}px;background:#fff`;
    s.hl.setAttribute('width', pageW); s.hl.setAttribute('height', pageH); s.hl.setAttribute('viewBox', `0 0 ${pageW} ${pageH}`);
    s.hl.style.cssText = `position:absolute;left:${G}px;top:0;width:${pageW}px;height:${pageH}px;pointer-events:none;overflow:visible`;
    s.tl.style.left = `${G}px`; s.tl.style.top = '0'; s.tl.style.width = `${pageW}px`; s.tl.style.height = `${pageH}px`;
    s.ar.setAttribute('width', sheetW); s.ar.setAttribute('height', pageH); s.ar.setAttribute('viewBox', `0 0 ${sheetW} ${pageH}`);
  }

  /* paper — drawn page by page. Each page is one white sheet, centered in the pane: the side
     space G on both sides makes the sheet at least as wide as the pane, so the whole sheet is
     writable. Sheets stack with a 1px rule between them so page breaks still read. All sheets
     are laid out at their final size first (so the scroll position can be kept), showing the
     previous drawing stretched, then drawn starting from the page in view. `anchor` is a client
     point to keep fixed; undefined keeps the top of the view, null starts at the top. */
  async layout(anchor) {
    const host = this.host.current, doc = this.doc;
    if (!host || !doc || host.clientWidth < 40) return;
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
    const pt = anchor === undefined ? this.hostPoint('top') : anchor, at = pt ? this.anchorAt(pt.x, pt.y) : null;
    const focused = document.activeElement && host.contains(document.activeElement) && document.activeElement.dataset.mark
      ? { id: document.activeElement.dataset.mark, a: document.activeElement.selectionStart, b: document.activeElement.selectionEnd } : null;
    const z = clamp(this.zoom, ZOOM_MIN, ZOOM_MAX), unit = this.unit(W);
    this.zoom = z;

    const geo = [], sheets = [], tops = [];
    const inner = document.createElement('div');
    inner.style.cssText = 'position:relative;width:max-content;min-width:100%;margin:0 auto;display:flex;flex-direction:column;align-items:flex-start';
    let top = 0;
    for (let n = 1; n <= N; n += 1) {
      const v0 = this.v0[n], pageW = Math.max(1, Math.round(v0.width * unit * z)), scale = pageW / v0.width;
      geo[n] = { G: sideSpace(W, pageW), pageW, pageH: v0.height * scale, scale };
      tops.push(top);
      top += geo[n].pageH + (n > 1 ? 1 : 0);
      const wrap = document.createElement('div');
      wrap.dataset.page = n;
      wrap.style.cssText = `position:relative;flex:none;margin:0 auto;background:#fff;${n > 1 ? 'border-top:1px solid #eaeaea;' : ''}box-sizing:content-box`;
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
      const notes = document.createElement('div');
      notes.dataset.notes = n; notes.style.cssText = 'position:absolute;inset:0;pointer-events:none';
      const ar = document.createElementNS(SVG, 'svg');
      ar.dataset.arrows = n;
      ar.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:visible';
      if (old) wrap.append(old);
      wrap.append(hl, tl, ar, notes);
      sheets[n] = { wrap, canvas: old || null, hl, tl, ar, notes };
      inner.appendChild(wrap);
    }

    host.replaceChildren(inner);
    const oldGeo = this.geo;
    this.inner = inner; this.geo = geo; this.sheets = sheets; this.tops = tops;
    this.renderedZoom = z; this.css = 1;
    for (let n = 1; n <= N; n += 1) this.place(n);
    if (this.live != null) this.setCss(this.live / z);
    this.pdfW = W; this.pdfG = geo[1].G; this.pageW = geo[1].pageW;
    if (at) this.restoreAnchor(at); else if (anchor === null) { host.scrollTop = 0; host.scrollLeft = 0; }

    // A pending selection is kept in pixels of the layout it was made in; carry it over.
    const p = this.pendingSel;
    if (p && geo[p.page]) {
      const was = p.u || (oldGeo[p.page] && oldGeo[p.page].pageW) || geo[p.page].pageW, k = geo[p.page].pageW / was;
      p.rects = p.rects.map((r) => ({ x: r.x * k, y: r.y * k, w: r.w * k, h: r.h * k }));
      p.y *= k; p.u = geo[p.page].pageW;
    }
    this.renderAllMarks();
    if (focused) {
      const ta = this.find1(`textarea[data-mark="${focused.id}"]`);
      if (ta) { ta.focus({ preventScroll: true }); try { ta.setSelectionRange(focused.a, focused.b); } catch { /* not a text field */ } }
    }
    this.syncBar();

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
          const textLayer = new pdfjsLib.TextLayer({ textContentSource: await page.getTextContent(), container: s.tl, viewport: vp });
          if (gen !== this.layoutGen) return;
          this.textLayer = textLayer;
          await textLayer.render();
          this.textLayer = null;
        } catch (err) { /* a page without a text layer is still readable */ }
        if (gen !== this.layoutGen) return;
        // Free notes size themselves around the printed text, which only now exists.
        if ((this.marks[n] || []).some((m) => m.pos && m.note != null)) this.renderMarks(n);
      }
      if (this.findQuery) this.report(this.find(this.findQuery, 0, { scroll: false }));
      if (this.section) this.paintSection(); // the text layer was drawn again: the section's ranges are new too
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
    if (fresh && this.section) { this.section = null; const h = highlights(); if (h) h.delete(SECTION); }
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

  // A link's passage, every page drawn: found from page 1 and scrolled to (`target`), and its section tinted (`targetTo`).
  applyTarget(key) {
    const [text, to = ''] = String(key).split('\n');
    const result = this.find(text, 0, { scroll: true, fromStart: true });
    this.section = to && result.matches ? { text, to } : null;
    if (this.section) this.paintSection();
    this.report(result);
    if (typeof this.props.onTarget === 'function') this.props.onTarget(text, result);
  }

  // The section from the passage (the first match from page 1) to just before the first match of `to` after it, one range
  // a page (../model/find.js sectionSpans). `to` nowhere after it, or too far on: nothing is tinted, the passage shows alone.
  paintSection() {
    const h = highlights();
    if (!h) return;
    const s = this.section, start = s && this.findQuery === s.text ? this.findSpots[0] : null;
    const pages = start ? this.pageTexts() : [];
    const spans = start ? sectionSpans(start, this.matchSpots(s.to, pages)) : null;
    paintSection(h, spans ? spans.map((span) => this.rangeIn(pages, span.page, span.from, span.to)).filter(Boolean) : [], Highlight);
  }

  stopFind() {
    this.findQuery = '';
    this.findAt = -1;
    this.findRanges = [];
    this.findSpots = [];
    this.section = null;
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
    const host = this.host.current;
    if (!scroll || !active || !host) return;
    const box = host.getBoundingClientRect(), r = active.getBoundingClientRect();
    if (r.top < box.top + 24 || r.bottom > box.bottom - 24) host.scrollTop += r.top - box.top - host.clientHeight / 3;
    if (r.left < box.left || r.right > box.left + host.clientWidth) host.scrollLeft += r.left - box.left - host.clientWidth / 3;
  }

  /* ---------------------------------------------------------------- selection → marks */
  // Client rects are divided by this.css so geometry is in the layout's own pixels mid-pinch too. A fully selected span
  // gives its own box and its text's (they differ in height), and spans can overlap, so the rects are merged into one
  // box per stretch of a line (./marks.js) before anything is drawn or stored.
  pdfMouseUp(e) {
    const wrap = e.target.closest && e.target.closest('[data-pdf] [data-page]');
    if (!wrap) return;
    if (e.target.closest('textarea')) return;
    const sel = getSelection(), tl = wrap.querySelector('[data-text-layer]'), css = this.css || 1;
    if (sel && !sel.isCollapsed && sel.rangeCount) {
      const range = sel.getRangeAt(0);
      if (!tl || !tl.contains(range.startContainer) || !tl.contains(range.endContainer)) { this.clearPending(); return; }
      const box = tl.getBoundingClientRect();
      const rects = mergeLineRects([...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1)
        .map((r) => ({ x: (r.left - box.left) / css, y: (r.top - box.top) / css, w: r.width / css, h: r.height / css })));
      if (!rects.length) return;
      const page = Number(tl.dataset.textLayer);
      this.pendingSel = { page, rects, side: sideOf(rects, box.width / css), y: Math.min(...rects.map((r) => r.y)), text: sel.toString(), u: this.geom(page).pageW };
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
    const { G, pageW } = this.geom(page), tl = this.find1(`[data-text-layer="${page}"]`);
    if (!tl) return 160;
    let right = pageW + 2 * G - 8;
    for (const s of tl.querySelectorAll('span')) {
      const l = s.offsetLeft + G, t = s.offsetTop, b = t + s.offsetHeight;
      if (b < y || t > y + h) continue;
      if (l > x && l < right) right = l - 6;
    }
    return Math.max(70, right - x);
  }

  pendingSelKey(e) {
    const p = this.pendingSel; if (!p) return false;
    if (isEditable(e.target)) return false;
    if (e.key === 'Escape') { this.clearPending(); return true; }
    if (e.key === 'Enter') { e.preventDefault(); this.addMark(p, null); this.clearPending(); return true; }
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const m = this.addMark(p, e.key); this.clearPending();
      requestAnimationFrame(() => { const ta = this.find1(`textarea[data-mark="${m.id}"]`); if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } });
      return true;
    }
    return false;
  }

  // The pending selection (merged boxes, see pdfMouseUp), drawn into the page's highlight layer until a note is typed or
  // it is dismissed. Over an existing highlight it is drawn on top of it.
  showPending() {
    const p = this.pendingSel; if (!p) return; this.hidePending();
    const hl = this.find1(`[data-hl="${p.page}"]`); if (!hl) return;
    const g = document.createElementNS(SVG, 'g'); g.dataset.pending = '1';
    for (const r of p.rects) {
      const el = document.createElementNS(SVG, 'rect');
      el.setAttribute('x', r.x); el.setAttribute('y', r.y); el.setAttribute('width', r.w); el.setAttribute('height', r.h); el.setAttribute('fill', 'rgba(0,112,243,.22)');
      g.appendChild(el);
    }
    hl.appendChild(g);
  }
  hidePending() { const host = this.host.current; if (host) host.querySelectorAll('[data-pending]').forEach((n) => n.remove()); }
  clearPending() { this.pendingSel = null; this.hidePending(); }

  // p carries pixel geometry from the current layout; the stored mark is in page units. A selection highlight is placed
  // among the page's marks (./marks.js placeHighlight): inside one already there it adds nothing, and overlapping ones
  // without notes become one. Answers the mark that holds it, whose note a caller may focus.
  addMark(p, note, pos) {
    const { G, pageW } = this.geom(p.page), u = pageW || 1;
    let m = {
      id: markId(),
      rects: p.rects.map((r) => ({ x: r.x / u, y: r.y / u, w: r.w / u, h: r.h / u })),
      side: p.side, y: p.y / u, note, text: p.text,
      pos: pos ? { x: (pos.x - G) / u, y: pos.y / u } : null,
    };
    const list = this.marks[p.page] || [];
    if (m.rects.length) { const placed = placeHighlight(list, m); this.marks[p.page] = placed.list; m = placed.mark; }
    else this.marks[p.page] = [...list, m];
    this.renderMarks(p.page);
    this.scheduleSave();
    return m;
  }

  renderAllMarks() {
    const host = this.host.current; if (!host) return;
    for (const wrap of host.querySelectorAll('[data-page]')) this.renderMarks(Number(wrap.dataset.page));
  }

  // Highlights are drawn once a page: every mark's rects merged (./marks.js mergeLineRects), one zigzag a box, seeded by
  // where the box is so it keeps its shape between renders and zooms. Marks overlapping each other, or saved with
  // doubled rects, draw no darker. Notes and arrows go by each mark's own rects.
  renderMarks(page) {
    const hl = this.find1(`[data-hl="${page}"]`), notes = this.find1(`[data-notes="${page}"]`), ar = this.find1(`[data-arrows="${page}"]`);
    if (!hl || !notes) return;
    const { G, pageW } = this.geom(page), u = pageW, sheetW = pageW + 2 * G;
    const PM = Math.round(pageW * 0.085);
    hl.innerHTML = ''; notes.innerHTML = ''; if (ar) ar.innerHTML = '';
    const rc = rough ? rough.svg(hl) : null, ra = rough && ar ? rough.svg(ar) : null;
    const list = (this.marks || {})[page] || [];
    for (const b of mergeLineRects(list.flatMap((m) => m.rects || []))) {
      const r = { x: b.x * u, y: b.y * u, w: b.w * u, h: b.h * u };
      if (rc) hl.appendChild(rc.rectangle(r.x, r.y + r.h * 0.15, r.w, r.h * 0.7, { fill: 'rgba(0,112,243,.14)', fillStyle: 'zigzag', fillWeight: 1.2, hachureGap: 2.6, hachureAngle: -4, stroke: 'none', roughness: 0.9, seed: boxSeed(page, b) }));
      else { const d = document.createElementNS(SVG, 'rect'); d.setAttribute('x', r.x); d.setAttribute('y', r.y); d.setAttribute('width', r.w); d.setAttribute('height', r.h); d.setAttribute('fill', 'rgba(0,112,243,.12)'); hl.appendChild(d); }
    }
    let k = 0;
    for (const m of list) {
      k++;
      const rects = m.rects.map((r) => ({ x: r.x * u, y: r.y * u, w: r.w * u, h: r.h * u }));
      const my = m.y * u, pos = m.pos ? { x: m.pos.x * u + G, y: m.pos.y * u } : null;
      if (m.note == null) continue;
      const ta = document.createElement('textarea');
      ta.dataset.mark = m.id; ta.value = m.note; ta.rows = 1; ta.spellcheck = false;
      let left, top, width;
      if (pos) { left = pos.x; top = pos.y - 11; width = Math.min(this.freeWidth(page, pos.x, pos.y, 22), G + pageW * .6); }
      else {
        // Side notes sit in the side space plus the page's own margin; with little or no side
        // space they keep a usable width and stay on the sheet (the box is width + 12px of padding).
        width = Math.max(80, G + PM - 16);
        left = m.side === 'left' ? 8 : Math.max(0, Math.min(G + pageW - PM + 8, sheetW - width - 16));
        top = Math.max(0, my - 6);
      }
      ta.style.cssText = `position:absolute;left:${left}px;top:${top}px;width:${width}px;pointer-events:auto;padding:0 6px;border:0;background:transparent;resize:none;overflow:hidden;font:500 17px/1.25 'Caveat',cursive;color:#171717;outline:none`;
      const fit = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
      ta.oninput = () => { m.note = ta.value; fit(); this.scheduleSave(); };
      ta.onblur = () => {
        if (!ta.value.trim()) {
          const list = this.marks[page];
          if (m.rects.length) m.note = null; else list.splice(list.indexOf(m), 1);
          this.renderMarks(page);
          this.scheduleSave();
        }
      };
      ta.onkeydown = (ev) => { ev.stopPropagation(); if (ev.key === 'Escape') ta.blur(); };
      ta.onmousedown = (ev) => ev.stopPropagation();
      notes.appendChild(ta); fit();
      if (ra && rects.length && !pos) {
        const r = rects[0], ax = m.side === 'left' ? G + r.x - 3 : G + r.x + r.w + 3, ay = r.y + r.h / 2;
        const nx = m.side === 'left' ? left + width - 4 : left + 2, ny = top + 11;
        const mx = (ax + nx) / 2, my2 = (ay + ny) / 2 + (m.side === 'left' ? -6 : 6);
        const opts = { stroke: 'rgba(0,112,243,.35)', strokeWidth: 1.1, roughness: 1.4, bowing: 1.2, seed: page * 13 + k };
        ar.appendChild(ra.curve([[ax, ay], [mx, my2], [nx, ny]], opts));
        const dx = nx - mx, dy = ny - my2, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len, hx = nx - ux * 7, hy = ny - uy * 7;
        ar.appendChild(ra.line(nx, ny, hx - uy * 3.5, hy + ux * 3.5, opts));
        ar.appendChild(ra.line(nx, ny, hx + uy * 3.5, hy - ux * 3.5, opts));
      }
    }
    // Clearing the highlight layer took the pending selection with it.
    if (this.pendingSel && this.pendingSel.page === page) this.showPending();
  }

  /* ---------------------------------------------------------------- render */
  render() {
    const { title } = this.props;
    const { note, page, pages, pct } = this.state;
    return (
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: title ? 12 : 0 }}>
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
          <div ref={this.host} data-pdf="1" style={{ flex: 1, minHeight: 0, overflow: 'auto', border: 0, borderTop: title ? '1px solid #eaeaea' : 0, borderRadius: 0, background: '#fff', padding: 0 }} />
          {note
            ? <span style={{ position: 'absolute', left: 0, right: 0, top: 14, textAlign: 'center', font: '12px/1.5 var(--font-sans)', color: '#8f8f8f', pointerEvents: 'none' }}>{note}</span>
            : null}
          {!note && pages > 0 ? (
            <div style={BAR} title="pinch or ⌃ scroll to zoom" onMouseDown={(e) => e.preventDefault()}>
              <span style={{ color: '#171717', minWidth: `${String(pages).length}ch`, textAlign: 'right' }}>{page}</span>
              <span style={{ margin: '0 4px', color: '#8f8f8f' }}>of {pages}</span>
              <span style={{ flex: 'none', width: 1, height: 16, margin: '0 6px', background: '#eaeaea' }} />
              <button type="button" className="hov-wash" aria-label="Zoom out" style={BAR_STEP} onClick={() => this.zoomStepBy(-1)}>−</button>
              <button type="button" className="hov-wash" title="100% = fit width" style={BAR_PCT} onClick={() => this.togglePct()}>{pct}%</button>
              <button type="button" className="hov-wash" aria-label="Zoom in" style={BAR_STEP} onClick={() => this.zoomStepBy(1)}>+</button>
            </div>
          ) : null}
        </div>
      </div>
    );
  }
}
