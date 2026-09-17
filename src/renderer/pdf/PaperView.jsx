// PaperView — the "Paper" pane: a PDF drawn page by page with pdf.js, each page one white
// sheet with wide gutters, rough.js zigzag highlights, Caveat handwritten notes and faint
// rough.js arrows. Port of the design's syncPdf / pdfMouseUp / freeWidth / pendingSelKey /
// addMark / renderMarks (design/goal-canvas/Goal Canvas.dc.html lines 516–602), with two
// changes: marks are stored in page units (fractions of the page width) so they survive a
// re-layout at another width, and the document is parsed once and only re-laid-out on resize.
import React from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import rough from 'roughjs';

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
`;

const clone = (v) => JSON.parse(JSON.stringify(v));
const markId = () => 'm' + Date.now() + Math.random().toString(36).slice(2, 6);
const isEditable = (t) => !!(t && t.closest && t.closest('input,textarea,[contenteditable="true"]'));

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
    this.state = { note: 'Opening the paper…' };
    this.host = React.createRef();
    this.marks = clone(props.marks || {}); // { [page]: Mark[] }, geometry in page units
    this.doc = null;
    this.gen = 0; // document generation
    this.layoutGen = 0; // page-layout generation
    this.renderTask = null;
    this.textLayer = null;
    this.pdfG = 150;
    this.pdfW = null;
    this.pageW = null;
    this.pendingSel = null;
    this.pdfDown = null;
    this.dirty = false;
    this.saveTimer = null;
    this.resizeTimer = null;
    this.onDown = (e) => {
      if (!(e.target.closest && e.target.closest('[data-pdf] [data-page]'))) return;
      this.pdfDown = { x: e.clientX, y: e.clientY };
      if (!e.target.closest('textarea')) this.clearPending();
    };
    this.onUp = (e) => this.pdfMouseUp(e);
    this.onKeyCapture = (e) => { if (this.pendingSelKey(e)) e.stopPropagation(); };
  }

  componentDidMount() {
    const host = this.host.current;
    host.addEventListener('mousedown', this.onDown);
    host.addEventListener('mouseup', this.onUp);
    window.addEventListener('keydown', this.onKeyCapture, true);
    this.ro = new ResizeObserver(() => this.onResize());
    this.ro.observe(host);
    this.load();
  }

  componentDidUpdate(prev) {
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
    }
    window.removeEventListener('keydown', this.onKeyCapture, true);
    if (this.ro) this.ro.disconnect();
    clearTimeout(this.resizeTimer);
    this.flushSave(this.props.onMarksChange);
    this.gen += 1;
    this.cancelLayout();
    if (this.doc) { const d = this.doc; this.doc = null; destroyDoc(d); }
  }

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

  /* ---------------------------------------------------------------- loading + layout */
  async load() {
    const gen = ++this.gen;
    this.cancelLayout();
    if (this.doc) { const d = this.doc; this.doc = null; destroyDoc(d); }
    const host = this.host.current;
    if (host) { host.innerHTML = ''; host.style.alignItems = 'center'; }
    this.pdfW = null;
    const data = toBytes(this.props.bytes);
    if (!data) { this.setState({ note: 'No paper to open.' }); return; }
    this.setState({ note: 'Opening the paper…' });
    try {
      const doc = await pdfjsLib.getDocument({ data, isEvalSupported: false, ...ASSETS }).promise;
      if (gen !== this.gen) { destroyDoc(doc); return; }
      this.doc = doc;
      this.setState({ note: '' });
      await this.layout();
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

  onResize() {
    clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      const host = this.host.current;
      if (!host || !this.doc) return;
      const W = host.clientWidth - 2;
      if (this.pdfW != null && Math.abs(W - this.pdfW) < 8) return;
      this.layout();
    }, 200);
  }

  /* paper — drawn page by page. Each page is one white sheet: the printed page sits inside
     a gutter G on both sides, so the whole sheet (gutter and the page's own white space) is
     writable. Sheets stack with a 1px rule between them so page breaks still read. */
  async layout() {
    const host = this.host.current, doc = this.doc;
    if (!host || !doc || host.clientWidth < 40) return;
    this.cancelLayout();
    const gen = this.layoutGen;
    const W = host.clientWidth - 2, G = W < 330 ? Math.max(24, Math.round(W * .12)) : clamp(Math.round(W * .2), 64, 150);
    const pageW = Math.max(120, W - 2 * G);
    this.pdfG = G; this.pdfW = W; this.pageW = pageW;
    host.innerHTML = ''; host.style.alignItems = 'flex-start';
    try {
      for (let n = 1; n <= doc.numPages; n++) {
        if (gen !== this.layoutGen) return;
        const page = await doc.getPage(n);
        if (gen !== this.layoutGen) return;
        const v0 = page.getViewport({ scale: 1 }), scale = pageW / v0.width, vp = page.getViewport({ scale }), vp2 = page.getViewport({ scale: scale * 2 });
        const pageH = vp.height, wrap = document.createElement('div');
        wrap.dataset.page = n;
        wrap.style.cssText = `position:relative;flex:none;width:${pageW + 2 * G}px;height:${pageH}px;margin:0 auto;background:#fff;${n > 1 ? 'border-top:1px solid #eaeaea;' : ''}box-sizing:content-box`;
        const c = document.createElement('canvas');
        c.width = vp2.width; c.height = vp2.height;
        c.style.cssText = `position:absolute;left:${G}px;top:0;width:${pageW}px;height:${pageH}px;background:#fff`;
        const hl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        hl.dataset.hl = n; hl.setAttribute('width', pageW); hl.setAttribute('height', pageH); hl.setAttribute('viewBox', `0 0 ${pageW} ${pageH}`);
        hl.style.cssText = `position:absolute;left:${G}px;top:0;width:${pageW}px;height:${pageH}px;pointer-events:none;overflow:visible`;
        const tl = document.createElement('div');
        tl.className = 'pdf-text'; tl.dataset.textLayer = n;
        tl.style.cssText = `left:${G}px;top:0;width:${pageW}px;height:${pageH}px`;
        tl.style.setProperty('--scale-factor', String(scale));
        tl.style.setProperty('--user-unit', '1');
        tl.style.setProperty('--total-scale-factor', String(scale));
        tl.style.setProperty('--scale-round-x', '1px');
        tl.style.setProperty('--scale-round-y', '1px');
        const notes = document.createElement('div');
        notes.dataset.notes = n; notes.style.cssText = 'position:absolute;inset:0;pointer-events:none';
        const ar = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        ar.dataset.arrows = n; ar.setAttribute('width', pageW + 2 * G); ar.setAttribute('height', pageH); ar.setAttribute('viewBox', `0 0 ${pageW + 2 * G} ${pageH}`);
        ar.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:visible';
        wrap.append(c, hl, tl, ar, notes);
        host.appendChild(wrap);
        const task = page.render({ canvasContext: c.getContext('2d'), viewport: vp2 });
        this.renderTask = task;
        try { await task.promise; } catch (err) { if (gen !== this.layoutGen) return; }
        this.renderTask = null;
        if (gen !== this.layoutGen) return;
        try {
          const textLayer = new pdfjsLib.TextLayer({ textContentSource: await page.getTextContent(), container: tl, viewport: vp });
          if (gen !== this.layoutGen) return;
          this.textLayer = textLayer;
          await textLayer.render();
          this.textLayer = null;
        } catch (err) { /* a page without a text layer is still readable */ }
        if (gen !== this.layoutGen) return;
        this.renderMarks(n);
      }
    } catch (err) {
      if (gen === this.layoutGen) this.setState({ note: 'Could not draw the paper — ' + ((err && err.message) || err) });
    }
  }

  /* ---------------------------------------------------------------- selection → marks */
  pdfMouseUp(e) {
    const wrap = e.target.closest && e.target.closest('[data-pdf] [data-page]');
    if (!wrap) return;
    if (e.target.closest('textarea')) return;
    const sel = getSelection(), tl = wrap.querySelector('[data-text-layer]');
    if (sel && !sel.isCollapsed && sel.rangeCount) {
      const range = sel.getRangeAt(0);
      if (!tl || !tl.contains(range.startContainer) || !tl.contains(range.endContainer)) { this.clearPending(); return; }
      const box = tl.getBoundingClientRect(), seen = new Set();
      const rects = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1)
        .map((r) => ({ x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height }))
        .filter((r) => { const k = [r.x, r.y, r.w, r.h].map((v) => v.toFixed(1)).join(','); if (seen.has(k)) return false; seen.add(k); return true; });
      if (!rects.length) return;
      const cx = rects.reduce((a, r) => a + r.x + r.w / 2, 0) / rects.length;
      this.pendingSel = { page: Number(tl.dataset.textLayer), rects, side: cx / box.width < .45 ? 'left' : 'right', y: Math.min(...rects.map((r) => r.y)), text: sel.toString() };
      this.showPending(); sel.removeAllRanges();
      return;
    }
    if (this.pdfDown && Math.hypot(e.clientX - this.pdfDown.x, e.clientY - this.pdfDown.y) < 4 && !e.target.closest('.pdf-text span')) {
      const box = wrap.getBoundingClientRect(), x = e.clientX - box.left, y = e.clientY - box.top, page = Number(wrap.dataset.page);
      const m = this.addMark({ page, rects: [], side: null, y, text: '' }, '', { x, y });
      requestAnimationFrame(() => { const ta = document.querySelector(`textarea[data-mark="${m.id}"]`); if (ta) ta.focus(); });
    }
  }

  // Width available for a free-placed note at (x, y): stops before the next printed text on
  // that line, so notes wrap instead of running over the page.
  freeWidth(page, x, y, h) {
    const G = this.pdfG || 150, tl = document.querySelector(`[data-text-layer="${page}"]`), wrap = tl && tl.parentElement;
    if (!tl) return 160;
    const W = wrap.offsetWidth; let right = W - 8;
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
      requestAnimationFrame(() => { const ta = document.querySelector(`textarea[data-mark="${m.id}"]`); if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } });
      return true;
    }
    return false;
  }

  // The pending selection, drawn into the page's highlight layer until a note is typed or it is dismissed.
  showPending() {
    const p = this.pendingSel; if (!p) return; this.hidePending();
    const host = this.host.current, hl = host && host.querySelector(`[data-hl="${p.page}"]`); if (!hl) return;
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g'); g.dataset.pending = '1';
    for (const r of p.rects) {
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      el.setAttribute('x', r.x); el.setAttribute('y', r.y); el.setAttribute('width', r.w); el.setAttribute('height', r.h); el.setAttribute('fill', 'rgba(0,112,243,.22)');
      g.appendChild(el);
    }
    hl.appendChild(g);
  }
  hidePending() { const host = this.host.current; if (host) host.querySelectorAll('[data-pending]').forEach((n) => n.remove()); }
  clearPending() { this.pendingSel = null; this.hidePending(); }

  // p carries pixel geometry from the current layout; the stored mark is in page units.
  addMark(p, note, pos) {
    const u = this.pageW || 1, G = this.pdfG || 150;
    const m = {
      id: markId(),
      rects: p.rects.map((r) => ({ x: r.x / u, y: r.y / u, w: r.w / u, h: r.h / u })),
      side: p.side, y: p.y / u, note, text: p.text,
      pos: pos ? { x: (pos.x - G) / u, y: pos.y / u } : null,
    };
    (this.marks[p.page] = this.marks[p.page] || []).push(m);
    this.renderMarks(p.page);
    this.scheduleSave();
    return m;
  }

  renderAllMarks() {
    const host = this.host.current; if (!host) return;
    for (const wrap of host.querySelectorAll('[data-page]')) this.renderMarks(Number(wrap.dataset.page));
  }

  renderMarks(page) {
    const hl = document.querySelector(`[data-hl="${page}"]`), notes = document.querySelector(`[data-notes="${page}"]`), ar = document.querySelector(`[data-arrows="${page}"]`);
    if (!hl || !notes) return;
    const G = this.pdfG || 150, pageW = this.pageW || hl.getBoundingClientRect().width, u = pageW;
    const PM = Math.round(pageW * 0.085);
    hl.innerHTML = ''; notes.innerHTML = ''; if (ar) ar.innerHTML = '';
    const rc = rough ? rough.svg(hl) : null, ra = rough && ar ? rough.svg(ar) : null;
    let k = 0;
    for (const m of (this.marks || {})[page] || []) {
      k++;
      const rects = m.rects.map((r) => ({ x: r.x * u, y: r.y * u, w: r.w * u, h: r.h * u }));
      const my = m.y * u, pos = m.pos ? { x: m.pos.x * u + G, y: m.pos.y * u } : null;
      rects.forEach((r, ri) => {
        if (rc) hl.appendChild(rc.rectangle(r.x, r.y + r.h * 0.15, r.w, r.h * 0.7, { fill: 'rgba(0,112,243,.14)', fillStyle: 'zigzag', fillWeight: 1.2, hachureGap: 2.6, hachureAngle: -4, stroke: 'none', roughness: 0.9, seed: ri + 7 }));
        else { const d = document.createElementNS('http://www.w3.org/2000/svg', 'rect'); d.setAttribute('x', r.x); d.setAttribute('y', r.y); d.setAttribute('width', r.w); d.setAttribute('height', r.h); d.setAttribute('fill', 'rgba(0,112,243,.12)'); hl.appendChild(d); }
      });
      if (m.note == null) continue;
      const ta = document.createElement('textarea');
      ta.dataset.mark = m.id; ta.value = m.note; ta.rows = 1; ta.spellcheck = false;
      let left, top, width;
      if (pos) { left = pos.x; top = pos.y - 11; width = Math.min(this.freeWidth(page, pos.x, pos.y, 22), G + pageW * .6); }
      else { left = m.side === 'left' ? 8 : G + pageW - PM + 8; top = Math.max(0, my - 6); width = G + PM - 16; }
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
  }

  /* ---------------------------------------------------------------- render */
  render() {
    const { title } = this.props;
    return (
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <style>{LAYER_CSS}</style>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, padding: '14px 20px 0' }}>
          <h3 style={{ margin: 0, font: '600 15px/1.4 var(--font-sans)', color: '#171717', textWrap: 'pretty' }}>{title}</h3>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }} />
        <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div ref={this.host} data-pdf="1" style={{ flex: 1, minHeight: 0, overflow: 'auto', border: 0, borderTop: '1px solid #eaeaea', borderRadius: 0, background: '#fff', padding: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0 }} />
          {this.state.note
            ? <span style={{ position: 'absolute', left: 0, right: 0, top: 14, textAlign: 'center', font: '12px/1.5 var(--font-sans)', color: '#8f8f8f', pointerEvents: 'none' }}>{this.state.note}</span>
            : null}
        </div>
      </div>
    );
  }
}
