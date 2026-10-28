'use strict';

// Cards on the paper (src/renderer/pdf/PaperView.jsx and canvas.js). Until 2026-10-16 (later) a page's layer of cards was
// scaled by its zoom, so a note was as small as the page at 15%. Then a card was the same size on screen at every zoom;
// since the third round it is drawn at noteScale, the size of the page's text, never under NOTE_FLOOR (Hudson: "it
// should be roughly constant to what the font size of the pdf is at 100%", "shrinking may actually be more natural"),
// and it is always in the pane beside
// the part of the page that shows ("i should be able to see all annotations if i can see any vertical position y at all
// times, irrespective of zoom and position it was left x"): where it sits follows the page (its highlight's height and the
// text's edge, or its `pos`), and the pane's sides move it in, narrower if need be (./canvas.js fitWidth). A zoom draws no
// card again, it lays them out again; a pinch is one CSS transform about the pane's middle line, which the cards are
// scaled back from; and there is no desk to scroll onto. PaperView lays out a stand-in of a page here: a small fake DOM
// (no pdf.js, no rough.js), whose boxes measure as wide as their style says and a fixed height a kind. A highlight's
// note and its answers are one card: a card is as tall as what it holds.
// Since 2026-10-27 (David: "Readable card width", the screenshots of a card squeezed into a 61 px margin) a highlight's
// card is CARD_W note px wide whatever room its margin has, against the text and never over it, and the sheet is widened
// each side for the whole of every card (a desk again, columnGeometry's reach), the page still in its middle; a card is
// never hidden or moved in from the pane's sides, it is panned to. A moved or typed card stays at its `pos`.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const { buildSync } = require('esbuild');

const loadCanvas = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/pdf/canvas.js')).href);

function loadView() {
  globalThis.document = { baseURI: 'file:///app/index.html' };
  const filename = path.join(__dirname, '__PaperView-canvas-zoom-unit.cjs');
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/pdf/PaperView.jsx')], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom', 'pdfjs-dist', 'roughjs'], loader: { '.css': 'empty' } });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  const stubs = { 'pdfjs-dist': { GlobalWorkerOptions: {} }, roughjs: { __esModule: true, default: null } };
  compiled.require = (id) => (id in stubs ? stubs[id] : Module.prototype.require.call(compiled, id));
  compiled._compile(bundled.outputFiles[0].text, filename);
  delete globalThis.document;
  return compiled.exports;
}
const { default: PaperView } = loadView();

/* ------------------------------------------------------------------------------------------------ a fake DOM */

// A card's height in its own (desk) px, at any zoom: its note, and 120 an answer and 90 an answer being written in it.
const cardHeight = (el) => 44 + el.children.filter((c) => c.dataset.ask != null).length * 120 + el.children.filter((c) => c.dataset.askRun != null).length * 90;
const camel = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
function styleOf() {
  const style = { setProperty(k, v) { style[k] = v; } };
  Object.defineProperty(style, 'cssText', {
    set(text) {
      for (const decl of String(text).split(';')) {
        const at = decl.indexOf(':');
        if (at > 0) style[camel(decl.slice(0, at).trim())] = decl.slice(at + 1).trim();
      }
    },
    get() { return ''; },
  });
  return style;
}
// `tag[data-name="value"]`, `[data-name]`, `tag`: all the selectors the view asks of these pages.
function matches(el, sel) {
  const m = String(sel).match(/^([a-z]+)?(?:\[data-([\w-]+)(?:="([^"]*)")?\])?$/i);
  if (!m || (!m[1] && !m[2])) return false;
  if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
  if (m[2]) { const v = el.dataset[camel(m[2])]; if (v == null || (m[3] != null && String(v) !== m[3])) return false; }
  return true;
}
class El {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.nodeName = this.tagName; this.nodeType = 1; this.children = []; this.parentNode = null; this.dataset = {}; this.attrs = {}; this.style = styleOf(); this.html = ''; this.scrollHeight = 21; }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return !!n.root; }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { return this.children[this.children.length - 1] || null; }
  get offsetWidth() { return parseFloat(this.style.width) || parseFloat(this.style.maxWidth) || 0; }
  get offsetHeight() { return this.dataset.box === 'card' ? cardHeight(this) : 0; }
  set innerHTML(v) { for (const c of this.children) c.parentNode = null; this.children = []; this.html = String(v); }
  get innerHTML() { return this.html; }
  appendChild(c) { if (c.parentNode) c.remove(); c.parentNode = this; this.children.push(c); return c; }
  append(...cs) { for (const c of cs) this.appendChild(c); }
  prepend(c) { if (c.parentNode) c.remove(); c.parentNode = this; this.children.unshift(c); }
  insertBefore(c, ref) { if (c.parentNode) c.remove(); c.parentNode = this; const i = this.children.indexOf(ref); this.children.splice(i < 0 ? this.children.length : i, 0, c); return c; }
  replaceChildren(...cs) { for (const c of this.children) c.parentNode = null; this.children = []; this.append(...cs); }
  replaceWith(n) { const p = this.parentNode; if (!p) return; if (n.parentNode) n.remove(); p.children[p.children.indexOf(this)] = n; n.parentNode = p; this.parentNode = null; }
  remove() { const p = this.parentNode; if (p) { p.children.splice(p.children.indexOf(this), 1); this.parentNode = null; } }
  contains(n) { for (; n; n = n.parentNode) if (n === this) return true; return false; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  getContext() { return {}; }
  querySelectorAll(sel) { const out = []; const walk = (el) => { for (const c of el.children) { if (matches(c, sel)) out.push(c); walk(c); } }; walk(this); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
const fakeDocument = () => ({ baseURI: 'file:///app/index.html', activeElement: null, body: new El('body'), createElement: (tag) => new El(tag), createElementNS: (_, tag) => new El(tag) });

// One page 612 × 792 pt in a pane 612px wide: 100% draws it 612px wide, 50% 306, 200% 1224, so its width at 100% is
// 612 desk px at every zoom. Its text column runs from 10% to 90% of the page (61.2 desk px of margin each side).
const W = 612, H = 700;
const pdfPage = { getViewport: ({ scale }) => ({ width: 612 * scale, height: 792 * scale }), render: () => ({ promise: Promise.resolve(), cancel() {} }), getTextContent: () => Promise.resolve({ items: [] }) };
const MARKS = {
  1: [
    // A highlight's note beside the page, not moved, and an answer in its card.
    { id: 'm1', rects: [{ x: 0.1, y: 0.2, w: 0.5, h: 0.015 }], side: 'right', y: 0.2, note: 'beside', text: 'a', asks: [{ id: 'a1', question: 'why?', answer: 'Because.', pos: null }] },
    // One moved (by its grip, before 2026-10-16), with two answers in its card: one moved on its own before cards, which is
    // in the card all the same.
    { id: 'm2', rects: [{ x: 0.2, y: 0.5, w: 0.4, h: 0.015 }], side: 'left', y: 0.5, note: 'moved', text: 'b', pos: { x: 0.7, y: 0.45 }, asks: [{ id: 'a2', question: 'and?', answer: 'Then.', pos: null }, { id: 'a3', question: 'so?', answer: 'So.', pos: { x: -0.9, y: 0.8 } }] },
    // A note typed on the page.
    { id: 'm3', rects: [], side: null, y: 0.9, note: 'free', text: '', pos: { x: 0.2, y: 0.9 }, w: 150 },
  ],
};

function viewer(marks = MARKS, width = W) {
  globalThis.document = fakeDocument();
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  const host = new El('div');
  host.root = true; host.clientWidth = width; host.clientHeight = H; host.clientLeft = 0; host.clientTop = 0; host.scrollLeft = 0; host.scrollTop = 0;
  const view = new PaperView({ marks });
  view.setState = (patch) => Object.assign(view.state, typeof patch === 'function' ? patch(view.state) : patch);
  view.host = { current: host };
  view.doc = { numPages: 1, getPage: async () => pdfPage };
  view.cols.set(1, { l: 0.1, r: 0.9 });
  return { view, host };
}
test.afterEach(() => { for (const name of ['document', 'requestAnimationFrame', 'cancelAnimationFrame', 'window']) delete globalThis[name]; });

// The sheets made and every page drawn: its drawing, its text and its marks (drawPages runs a page a turn).
async function open(view) {
  await view.layout();
  view.cols.set(1, { l: 0.1, r: 0.9 });
  view.drawSoon();
  for (let i = 0; i < 200 && view.pumping; i += 1) await new Promise((r) => setTimeout(r, 1));
}


// Every card on page 1 in the sheet's px, as laid out (a pinch's transform not counted): { [markId]: { left, top, width,
// height } }, the sheet's width S and the pane's span now.
function laidOut(view, host) {
  const s = view.sheets[1], g = view.geo[1];
  assert.equal(parseFloat(s.notes.style.left), 0, 'the cards\' layer is the sheet\'s');
  assert.equal(s.notes.style.transform, '', 'and never scaled with the page');
  // On screen a card is its laid-out size times its layer's --ns (BOX_LOOK).
  const boxes = {}, ns = Number(s.notes.style['--ns']) || 1;
  for (const el of s.notes.querySelectorAll('[data-box]')) boxes[el.dataset.boxMark] = { left: parseFloat(el.style.left), top: parseFloat(el.style.top), width: el.offsetWidth * ns, height: el.offsetHeight * ns, hidden: el.style.visibility === 'hidden' };
  return { boxes, g, ns, S: view.sheetW, vL: host.scrollLeft, vR: host.scrollLeft + host.clientWidth };
}
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} ≈ ${b}`);
// Every card wholly on the sheet, DESK_PAD note px of it past the farthest: none cut off, each reachable by panning.
const onSheet = (at, pad, what) => { for (const [id, b] of Object.entries(at.boxes)) assert.ok(b.left >= -1e-6 && b.left + b.width <= at.S + 1e-6, `${what} ${id} on the sheet: ${b.left}..${b.left + b.width} within 0..${at.S}`); };
// The text from `l` to `r` of the page, its edges on the sheet.
const textEdges = (at, l, r) => ({ L: at.g.G + l * at.g.pageW, R: at.g.G + r * at.g.pageW });
// No card laid out by itself (not moved, not typed) over the text's span across.
const offText = (at, ids, l, r, what) => { const { L, R } = textEdges(at, l, r); for (const id of ids) { const b = at.boxes[id]; assert.ok(b.left + b.width <= L + 1e-6 || b.left >= R - 1e-6, `${what} ${id} off the text: ${b.left}..${b.left + b.width}, the text ${L}..${R}`); } };
// How many times page 1's marks were drawn from here on.
function countDraws(view) { const out = { n: 0 }, was = view.renderMarks.bind(view); view.renderMarks = (page) => { out.n += 1; return was(page); }; return out; }

test('at 50%, 100% and 200% a highlight\'s card is CARD_W at the page\'s note scale beside the text, a moved or typed one at its place, and none is drawn again', async () => {
  const { CARD_W, SIDE_GAP, POS_DY, noteScale } = await loadCanvas();
  const { view, host } = viewer();
  view.zoom = 1;
  await open(view);
  const base = laidOut(view, host);
  near(base.ns, 612 / 1050, 1e-9, 'a page 612 px wide draws its notes at 612/NOTE_REF');
  assert.deepEqual(Object.keys(base.boxes).sort(), ['m1', 'm2', 'm3'], 'one card a mark: its note and its answers');
  // Margins of 61 px (the text from 10% to 90%): far narrower than the card, which keeps its width all the same.
  near(base.boxes.m1.width, CARD_W * base.ns, 1e-9, 'CARD_W, not narrowed to the margin');
  near(base.boxes.m1.height, (44 + 120) * base.ns, 1e-9, 'its note and its answer');
  near(base.boxes.m2.height, (44 + 2 * 120) * base.ns, 1e-9, 'the answer moved on its own before is in the card');
  near(base.boxes.m3.width, 150 * base.ns, 1e-9, 'a typed note keeps the width it was written with');
  const cards = view.sheets[1].notes.querySelectorAll('[data-box]'), draws = countDraws(view);
  const share = {};
  for (const f of [0.5, 2, 1]) {
    view.zoomTo(f * 100);
    const at = laidOut(view, host), { G, pageW } = at.g, what = `${f * 100}%`;
    assert.equal(pageW, 612 * f);
    near(at.ns, noteScale(pageW), 1e-9, `${what}: drawn at the page's note scale`);
    near(at.boxes.m1.width, CARD_W * at.ns, 1e-9, `${what}: CARD_W`);
    near(at.boxes.m1.left, G + 0.9 * pageW + SIDE_GAP * at.ns, 1e-9, `${what}: right of the text, SIDE_GAP off it`);
    assert.ok(at.boxes.m1.top >= 0.2 * pageW - 8 * at.ns - 1e-9, `${what}: a highlight's note no higher than its highlight`);
    near(at.boxes.m1.height, (44 + 120) * at.ns, 1e-9, `${what}: its height at that scale`);
    near(at.boxes.m2.left, G + 0.7 * pageW, 1e-9, `${what}: a moved one where it was put`);
    near(at.boxes.m2.top, 0.45 * pageW - POS_DY, 1e-9, `${what}: and at its height`);
    near(at.boxes.m3.left, G + 0.2 * pageW, 1e-9, `${what}: a typed note where it was typed`);
    near(at.boxes.m3.top, 0.9 * pageW - POS_DY, 1e-9, `${what}: at its place's height`);
    onSheet(at, 16, what);
    offText(at, ['m1'], 0.1, 0.9, what);
    for (const b of Object.values(at.boxes)) assert.ok(!b.hidden, `${what}: none hidden`);
    share[f] = { w: at.boxes.m1.width / pageW, x: (at.boxes.m1.left - G) / pageW, y: at.boxes.m1.top / pageW };
  }
  // Above NOTE_FLOOR the card goes with the page: the same share of it across and down at 100% and 200%.
  for (const k of ['w', 'x', 'y']) near(share[2][k], share[1][k], 1e-9, `200% as 100%: ${k}`);
  assert.equal(draws.n, 0, 'a zoom draws no card again');
  assert.deepEqual(view.sheets[1].notes.querySelectorAll('[data-box]'), cards, 'the very same cards');
});

test('a sideways scroll lays out no card again and moves none: they lie on the desk beside the page', async () => {
  const { view, host } = viewer();
  view.zoom = 1;
  await open(view);
  view.zoomTo(200);
  const before = laidOut(view, host).boxes, draws = countDraws(view);
  for (const x of [0, 306, view.sheetW - W]) {
    host.scrollLeft = x;
    view.onScroll(); // what a scroll does
    assert.deepEqual(laidOut(view, host).boxes, before, `scrolled to ${x}`);
  }
  assert.equal(draws.n, 0);
});

test('the desk: as wide as the page and each side the farthest any card reaches, the page in its middle; with no card the sheet is the pane', async () => {
  const { CARD_W, SIDE_GAP, DESK_PAD, noteScale } = await loadCanvas();
  const { view, host } = viewer();
  view.zoom = 1;
  await open(view);
  const sheet = () => ({ inner: parseFloat(view.inner.style.width), wrap: parseFloat(view.sheets[1].wrap.style.width), G: view.geo[1].G, pageW: view.geo[1].pageW, left: host.scrollLeft });
  // m1 beside the text's right edge (90%): CARD_W, SIDE_GAP before it and DESK_PAD after, past the page's edge.
  const reach = (pageW) => Math.ceil(-0.1 * pageW + (SIDE_GAP + CARD_W + DESK_PAD) * noteScale(pageW));
  const at = (pageW) => { const S = Math.max(612, pageW + 2 * reach(pageW)); return { inner: S, wrap: S, G: (S - pageW) / 2, pageW }; };
  const one = sheet();
  assert.deepEqual({ ...one, left: undefined }, { ...at(612), left: undefined }, '100%: the page and a desk each side for m1');
  near(one.left, one.G, 1, '100%: the view on the page');
  view.zoomTo(50);
  assert.deepEqual({ ...sheet(), left: undefined }, { ...at(306), left: undefined }, '50%: the pane is room enough');
  view.zoomTo(200);
  const two = sheet();
  assert.deepEqual({ ...two, left: undefined }, { ...at(1224), left: undefined }, '200%');
  near(two.left, (two.inner - W) / 2, 1, '200%: the view on the page\'s middle');
  const lone = viewer({});
  lone.view.zoom = 1;
  await open(lone.view);
  assert.equal(parseFloat(lone.view.inner.style.width), 612, 'no card: no desk');
  assert.equal(lone.view.geo[1].G, 0);
});

test('a pinch is one transform about the pane\'s middle line, the cards scaled back to their size; once it settles they are laid out at its zoom', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { CARD_W } = await loadCanvas();
  const { view, host } = viewer();
  view.zoom = 1;
  view.layout().then(() => view.drawSoon());
  for (let i = 0; i < 50; i += 1) { await Promise.resolve(); t.mock.timers.tick(1); }
  assert.ok(view.drawn[1], 'drawn');
  const sheets = view.sheets.slice(), draws = countDraws(view), before = laidOut(view, host);
  host.getBoundingClientRect = () => ({ left: 0, top: 0, right: W, bottom: H, width: W, height: H });
  const wheel = { ctrlKey: true, deltaY: -25, deltaMode: 0, clientX: 100, clientY: 200, preventDefault() {} };
  const middle = host.scrollLeft + W / 2;
  view.pinch(wheel);
  view.pinch(wheel);
  const live = view.live;
  assert.ok(live > 1.6 && live < 1.7);
  assert.equal(view.inner.style.transform, `scale(${live})`, 'the paper scaled whole, by the compositor');
  assert.equal(view.inner.style.transformOrigin, `${middle}px 200px`, 'about the pane\'s middle across, wherever the pointer is, and its height');
  assert.equal(view.inner.style.willChange, 'transform');
  assert.equal(view.sheets[1].notes.style['--inv'], '', 'its cards scaled with the paper (above NOTE_FLOOR), as its text is');
  t.mock.timers.tick(180);
  assert.equal(view.live, null, 'settled');
  assert.equal(view.inner.style.transform, '', 'no transform left');
  assert.equal(view.inner.style.willChange, '');
  assert.equal(view.sheets[1].notes.style['--inv'], '', 'nor any scale on the cards');
  const after = laidOut(view, host);
  near(after.g.pageW, 612 * live, 1, 'laid out at the zoom the pinch ended on');
  near(after.boxes.m1.height, before.boxes.m1.height * after.g.pageW / before.g.pageW, 1e-6, 'grown with the page');
  near(after.boxes.m1.width, CARD_W * after.ns, 1e-6, 'and as wide');
  onSheet(after, 16, 'settled');
  assert.equal(draws.n, 0, 'no card drawn again');
  assert.deepEqual(view.sheets, sheets, 'nor any page made again');
  near(host.scrollLeft, (view.sheetW - W) / 2, 1, 'centered');
});

test('a card dropped at 200% keeps its place on the page at 100% and 50%, and after the paper is opened again: `pos` keeps its meaning', async () => {
  const { view, host } = viewer({ 1: [{ id: 'm1', rects: [{ x: 0.1, y: 0.2, w: 0.5, h: 0.015 }], side: 'right', y: 0.2, note: 'n', text: 'a' }] });
  view.zoom = 2;
  await open(view);
  // Pressed on its words and moved 100 px left and 40 down (no pinch); the cards' layer's top-left is the screen's here.
  const b = view.drawn[1].boxes[0], startLeft = b.left, startTop = b.top, width = b.w, G = view.geo[1].G;
  b.el.getBoundingClientRect = () => ({ left: startLeft, top: startTop });
  assert.equal(view.startDrag({ clientX: startLeft + 10, clientY: startTop + 5 }, b.el, 1), true);
  assert.equal(view.focusId, 'm1', 'its mark in focus: Delete would remove it');
  view.drag.at = { x: startLeft - 90, y: startTop + 45 };
  view.dragTo();
  view.endDrag();
  const m = view.marks[1][0];
  near(m.pos.x, (startLeft - 100 - G) / 1224, 1e-9, 'moved 100 px at 200%, from the page\'s left edge');
  near(m.pos.y, (startTop + 40 + 11) / 1224, 1e-9);
  assert.equal(m.w, width, 'it keeps the width it was moved at (note px)');
  near(laidOut(view, host).boxes.m1.left - view.geo[1].G, startLeft - 100 - G, 1e-9, 'dropped where it was let go, on the page, whatever the desk did');
  for (const f of [1, 0.5]) {
    view.zoomTo(f * 100);
    const at = laidOut(view, host), { pageW } = at.g;
    near(at.boxes.m1.left, at.g.G + m.pos.x * pageW, 1e-9, `${f * 100}%: at its place across`);
    near(at.boxes.m1.top, m.pos.y * pageW - 11, 1e-9, `${f * 100}%: at its place's height`);
  }
  // Saved and read back: the same place.
  const again = viewer(JSON.parse(JSON.stringify(view.marks)));
  again.view.zoom = 0.5;
  await open(again.view);
  const at = laidOut(again.view, again.host);
  near(at.boxes.m1.left, at.g.G + m.pos.x * at.g.pageW, 1e-9, 'opened again: at its place across');
  near(at.boxes.m1.top, m.pos.y * at.g.pageW - 11, 1e-9, 'and down');
});

test('margins too narrow for a card: each keeps CARD_W against the text, off it, the desk widened for it; in a narrow pane too', async () => {
  const { CARD_W, SIDE_GAP, NOTE_FLOOR } = await loadCanvas();
  const marks = { 1: [
    { id: 'r', rects: [{ x: 0.5, y: 0.2, w: 0.3, h: 0.015 }], side: 'right', y: 0.2, note: 'right margin', text: 'a' },
    { id: 'l', rects: [{ x: 0.1, y: 0.4, w: 0.3, h: 0.015 }], side: 'left', y: 0.4, note: 'left margin', text: 'b' },
  ] };
  for (const pane of [612, 320]) {
    const { view, host } = viewer(marks, pane);
    view.zoom = 1;
    await open(view);
    for (const f of [0.5, 1, 2]) {
      view.zoomTo(f * 100);
      const at = laidOut(view, host), what = `pane ${pane}, ${f * 100}%`, { L, R } = textEdges(at, 0.1, 0.9);
      for (const id of ['r', 'l']) near(at.boxes[id].width, CARD_W * at.ns, 1e-9, `${what} ${id}: CARD_W, never squeezed`);
      near(at.boxes.r.left, R + SIDE_GAP * at.ns, 1e-9, `${what}: right of the text`);
      near(at.boxes.l.left + at.boxes.l.width, L - SIDE_GAP * at.ns, 1e-9, `${what}: left of it`);
      offText(at, ['r', 'l'], 0.1, 0.9, what);
      onSheet(at, 16, what);
    }
  }
  // Zoomed far out the card is held at NOTE_FLOOR, still CARD_W and still against the text.
  const { view, host } = viewer(marks);
  view.zoom = 1;
  await open(view);
  view.zoomTo(30);
  const at = laidOut(view, host);
  assert.equal(at.ns, NOTE_FLOOR, 'at 30% held at NOTE_FLOOR');
  near(at.boxes.r.width, CARD_W * at.ns, 1e-9, 'CARD_W');
  near(at.boxes.r.left, at.g.G + 0.9 * at.g.pageW + SIDE_GAP * at.ns, 1e-9, 'still against the text');
});

test('one card a highlight: its note, then each answer and each answer being written, each under a hairline; an answer\'s question shows only when the note does not ask it now', async () => {
  const { view } = viewer({
    1: [{ id: 'm1', rects: [{ x: 0.1, y: 0.2, w: 0.5, h: 0.015 }], side: 'right', y: 0.2, note: '@bart and then?', text: 'a', asks: [
      { id: 'a1', question: 'why?', answer: 'Because.', meta: { name: 'Sonnet', effort: 'high' }, pos: { x: -2, y: 0.9 } },
      { id: 'a2', question: 'and then?', answer: 'Then.', pos: null },
    ] }],
  });
  view.props.pendingAsks = [{ askId: 'h1', markId: 'm1', page: 1, question: 'and then?' }];
  view.zoom = 1;
  await open(view);
  const cards = view.sheets[1].notes.querySelectorAll('[data-box]');
  assert.equal(cards.length, 1, 'one card');
  const [card] = cards;
  // 2026-10-27: a card apart from the paper (it had no edge or fill from 2026-10-16).
  assert.equal(card.style.background, '#fff', 'a solid ground');
  assert.match(String(card.style.border), /^1px solid #/, 'a faint edge');
  assert.ok(parseFloat(card.style.padding) > 0, 'room inside it');
  const [note, a1, a2, run] = card.children;
  assert.ok(note.dataset.cardNote, 'the note at the top, no grip over it');
  assert.equal(card.querySelectorAll('[data-grip]').length, 0);
  assert.deepEqual([a1.dataset.ask, a2.dataset.ask, run.dataset.askRun], ['a1', 'a2', 'h1'], 'the answers in order, then the one being written');
  for (const sec of [a1, a2, run]) assert.match(String(sec.style.borderTop), /^1px solid #/, 'under a hairline');
  assert.match(a1.innerHTML, />why\?</, 'an earlier question of the thread is shown');
  assert.doesNotMatch(a1.innerHTML, /Sonnet/, 'the model is kept (meta) but not shown (MATH-70 build 3)');
  assert.doesNotMatch(a2.innerHTML, />and then\?</, 'the note asks it now: not shown again');
  assert.equal(run.querySelector('[data-run-question]').style.display, 'none', 'nor over the answer being written');
  // The card is beside the page's text: a1's own place from before cards is not read.
  assert.equal(view.drawn[1].boxes.length, 1);
  assert.ok(view.drawn[1].boxes[0].left >= view.geo[1].G + 0.9 * 612);
});

test('the pdf card\'s type: the app\'s, not handwriting; words wrap between words and break only when longer than a line; a web page\'s card is as it was', async () => {
  const look = await import(pathToFileURL(path.join(__dirname, '../src/renderer/pdf/paper-look.js')).href);
  const web = await import(pathToFileURL(path.join(__dirname, '../src/renderer/pdf/card-look.js')).href);
  assert.match(look.PDF_NOTE_TYPE, /var\(--font-sans\)/);
  assert.doesNotMatch(look.PDF_NOTE_TYPE, /Caveat/);
  assert.equal(look.PDF_WRAP, 'overflow-wrap:break-word;word-break:normal', 'not `anywhere`, which broke short words');
  assert.match(web.NOTE_TYPE, /Caveat/, 'the web card keeps its own look (card-look.js unchanged)');
  const { view } = viewer();
  view.zoom = 1;
  await open(view);
  const card = view.sheets[1].notes.querySelector('[data-box-mark="m1"]');
  const answer = card.querySelector('[data-ask]');
  assert.doesNotMatch(String(answer.innerHTML), /overflow-wrap:anywhere/, 'an answer wraps between words');
});

test('highlights are flat tints, not scribbles: a kept one, the one in focus (a tint more and a line under it) and a selection pending its note, each apart', async () => {
  const look = await import(pathToFileURL(path.join(__dirname, '../src/renderer/pdf/paper-look.js')).href);
  const { view, host } = viewer();
  view.zoom = 1;
  await open(view);
  const bands = host.querySelectorAll('[data-band]');
  assert.ok(bands.length >= 2, 'a band a highlight\'s line');
  for (const b of bands) { assert.equal(b.tagName, 'RECT', 'a rect, not a rough.js path'); assert.equal(b.attrs.fill, look.HL_SAVED); }
  view.paintFocus('m1');
  const focus = host.querySelectorAll('[data-focus]');
  assert.ok(focus.some((r) => r.attrs.fill === look.HL_FOCUS), 'a tint over it');
  assert.ok(focus.some((r) => r.attrs.fill === look.HL_FOCUS_LINE), 'and a line under it');
  assert.notEqual(look.HL_PENDING, look.HL_SAVED, 'pending apart from kept');
  assert.notEqual(look.HL_FOCUS_LINE, look.HL_SAVED);
});

test('a card has a move handle at its lower right; a press on it drags the card (2026-10-16, later)', async () => {
  const { view, host } = viewer({ 1: [{ id: 'f', rects: [], side: null, y: 0.5, note: 'typed', text: '', pos: { x: 0.3, y: 0.5 }, w: 150 }] });
  view.zoom = 1;
  await open(view);
  const b = view.drawn[1].boxes[0], grip = b.el.querySelector('[data-move]');
  assert.ok(grip, 'the handle');
  assert.equal(b.el.lastElementChild, grip, 'after what the card holds');
  assert.match(grip.innerHTML, /<svg/);
  const startLeft = b.left, startTop = b.top;
  b.el.getBoundingClientRect = () => ({ left: startLeft, top: startTop });
  grip.onmousedown({ button: 0, clientX: startLeft + 140, clientY: startTop + 40, stopPropagation() {}, preventDefault() {} });
  assert.ok(view.drag, 'dragging');
  view.drag.at = { x: startLeft + 140 - 60, y: startTop + 40 + 30 };
  view.dragTo();
  view.endDrag();
  const at = laidOut(view, host).boxes.f;
  near(at.left, startLeft - 60, 1e-9, 'moved with the pointer');
  near(at.top, startTop + 30, 1e-9);
});

test('a pinch out near the paper\'s top keeps page 1 at the pane\'s top: no white band above it, no jump when it settles', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { view, host } = viewer();
  view.zoom = 1;
  view.layout().then(() => view.drawSoon());
  for (let i = 0; i < 50; i += 1) { await Promise.resolve(); t.mock.timers.tick(1); }
  host.getBoundingClientRect = () => ({ left: 0, top: 0, right: W, bottom: H, width: W, height: H });
  const out = { ctrlKey: true, deltaY: 40, deltaMode: 0, clientX: 300, clientY: 400, preventDefault() {} };
  for (let i = 0; i < 4; i += 1) view.pinch(out);
  const c = view.css;
  assert.ok(c < 0.8, `zoomed out (${c})`);
  const m = String(view.inner.style.transform).match(/^translateY\(([-\d.e]+)px\) scale\(([\d.e]+)\)$/);
  assert.ok(m, `moved up as well as scaled: ${view.inner.style.transform}`);
  near(Number(m[1]), -(400 * (1 - c)), 1e-6, 'by as much as the scale about the pointer\'s height pulled page 1\'s top down');
  t.mock.timers.tick(180);
  assert.equal(host.scrollTop, 0, 'settled at the top');
});

/* ----------------------------------------------------------------- third round (2026-10-16): notes the paper's size */

test('pointing at a card fades no other card (Hudson: "all the other highlights grey out")', async () => {
  const { view } = viewer();
  view.zoom = 1;
  await open(view);
  view.paintFocus('m1');
  for (const el of view.sheets[1].notes.querySelectorAll('[data-box]')) assert.ok(!el.style.opacity, `${el.dataset.boxMark} not faded`);
});

test('a highlight\'s card keeps its own side when that margin is narrow: the desk widens there', async () => {
  const { CARD_W, SIDE_GAP } = await loadCanvas();
  // Text from 10% to 60%: the left margin 61 px, the right 245.
  const { view, host } = viewer({ 1: [{ id: 'l', rects: [{ x: 0.1, y: 0.3, w: 0.3, h: 0.015 }], side: 'left', y: 0.3, note: 'wants the left', text: 'a' }] });
  view.zoom = 1;
  view.cols.set(1, { l: 0.1, r: 0.6 });
  await open(view);
  view.cols.set(1, { l: 0.1, r: 0.6 });
  view.renderMarks(1);
  const at = laidOut(view, host);
  near(at.boxes.l.left + at.boxes.l.width, at.g.G + 0.1 * 612 - SIDE_GAP * at.ns, 1e-9, 'left of the text, not over it');
  near(at.boxes.l.width, CARD_W * at.ns, 1e-9);
  onSheet(at, 16, 'left');
});

test('a note typed in a margin, or against the text\'s edge, stays where it was put, as wide as it was written', async () => {
  for (const [x, w, col] of [[150 / 612, 300, { l: 0.3, r: 0.9 }], [0.66, 240, { l: 0.1, r: 0.7 }]]) {
    const { view, host } = viewer({ 1: [{ id: 'f', rects: [], side: null, y: 0.3, note: 'put here', text: '', pos: { x, y: 0.3 }, w }] });
    view.zoom = 1;
    await open(view);
    view.cols.set(1, col);
    view.renderMarks(1);
    const at = laidOut(view, host);
    near(at.boxes.f.left, at.g.G + x * 612, 1e-9, `typed at ${x}: there`);
    near(at.boxes.f.width, w * at.ns, 1e-9, 'its width');
    onSheet(at, 16, 'typed');
  }
});

test('a pinch out holds the cards at NOTE_FLOOR, and no further: above it they go with the paper', async () => {
  const { NOTE_FLOOR } = await loadCanvas();
  const { view } = viewer();
  view.zoom = 1;
  await open(view);
  const ns = view.boxScale(1);
  view.cardsInverse(0.9);
  assert.equal(view.sheets[1].notes.style['--inv'], '', '0.9 × 0.58 is still above the floor');
  view.cardsInverse(0.3);
  near(ns * 0.3 * Number(view.sheets[1].notes.style['--inv']), NOTE_FLOOR, 1e-9, 'drawn at NOTE_FLOOR');
  view.cardsInverse(1);
  assert.equal(view.sheets[1].notes.style['--inv'], '');
});

test('zoomed in on the text alone no card is hidden: those beside the page are off the pane, a pan away', async () => {
  const { view, host } = viewer();
  view.zoom = 1;
  await open(view);
  view.zoomTo(200); // the view on the page's middle: neither margin shows
  let at = laidOut(view, host);
  for (const [id, b] of Object.entries(at.boxes)) assert.ok(!b.hidden, `${id} not hidden`);
  assert.ok(at.boxes.m1.left >= at.vR, 'm1 right of the pane');
  host.scrollLeft = view.sheetW - W; view.onScroll(); // panned to the sheet's right edge
  at = laidOut(view, host);
  assert.ok(at.boxes.m1.left >= at.vL && at.boxes.m1.left + at.boxes.m1.width <= at.vR, 'm1 in the pane');
});
