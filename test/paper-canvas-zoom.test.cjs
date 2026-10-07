'use strict';

// A true canvas (src/renderer/pdf/PaperView.jsx and canvas.js, MATH-27 follow-up, 2026-10-06): boxes and
// the lines joining them are laid out in desk px and each page's layer of them is scaled by its zoom, so a box keeps its
// place, size and gap against the page at 50%, 100% and 200%, moved or not, and a pinch that settles leaves every box
// where the pinch put it. PaperView lays out a twelve-point stand-in of a page here: a small fake DOM (no pdf.js, no
// rough.js), whose boxes measure as wide as their style says and a fixed height a kind. Since 2026-10-06 a highlight's
// note and its answers are one card (no lines join anything): a card is as tall as what it holds.

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
  get offsetWidth() { return parseFloat(this.style.width) || 0; }
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
// 612 desk px at every zoom.
const W = 612, H = 700;
const pdfPage = { getViewport: ({ scale }) => ({ width: 612 * scale, height: 792 * scale }), render: () => ({ promise: Promise.resolve(), cancel() {} }), getTextContent: () => Promise.resolve({ items: [] }) };
const MARKS = {
  1: [
    // A highlight's note beside the page, not moved, and an answer in its card.
    { id: 'm1', rects: [{ x: 0.1, y: 0.2, w: 0.5, h: 0.015 }], side: 'right', y: 0.2, note: 'beside', text: 'a', asks: [{ id: 'a1', question: 'why?', answer: 'Because.', pos: null }] },
    // One on the left, moved past the desk's right edge, with two answers in its card: one moved past the left on its own
    // before cards, which is in the card all the same.
    { id: 'm2', rects: [{ x: 0.2, y: 0.5, w: 0.4, h: 0.015 }], side: 'left', y: 0.5, note: 'moved', text: 'b', pos: { x: 1.3, y: 0.45 }, asks: [{ id: 'a2', question: 'and?', answer: 'Then.', pos: null }, { id: 'a3', question: 'so?', answer: 'So.', pos: { x: -0.9, y: 0.8 } }] },
    // A free note on the page.
    { id: 'm3', rects: [], side: null, y: 0.9, note: 'free', text: '', pos: { x: 0.2, y: 0.9 } },
  ],
};

function viewer(marks = MARKS) {
  globalThis.document = fakeDocument();
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  const host = new El('div');
  host.root = true; host.clientWidth = W; host.clientHeight = H; host.clientLeft = 0; host.clientTop = 0; host.scrollLeft = 0; host.scrollTop = 0;
  const view = new PaperView({ marks });
  view.setState = (patch) => Object.assign(view.state, typeof patch === 'function' ? patch(view.state) : patch);
  view.host = { current: host };
  view.doc = { numPages: 1, getPage: async () => pdfPage };
  return { view, host };
}
test.afterEach(() => { for (const name of ['document', 'requestAnimationFrame', 'cancelAnimationFrame', 'window']) delete globalThis[name]; });

const scaleOf = (el) => { const m = String(el.style.transform || '').match(/^scale\(([\d.e+-]+)\)$/); return m ? Number(m[1]) : 1; };

// Every card on page 1 as the screen shows it against the page's top-left (layout px times a pinch's CSS zoom):
// { [markId]: { left, top, width, height } }.
function onScreen(view) {
  const s = view.sheets[1], g = view.geo[1], css = Number(view.inner.style.zoom) || 1, k = scaleOf(s.notes);
  const G = parseFloat(s.bg.style.left);
  assert.equal(G, g.G, 'the page starts where the desk ends');
  const boxes = {};
  for (const el of s.notes.querySelectorAll('[data-box]')) {
    boxes[el.dataset.boxMark] = { left: (parseFloat(el.style.left) * k - G) * css, top: parseFloat(el.style.top) * k * css, width: el.offsetWidth * k * css, height: el.offsetHeight * k * css };
  }
  return { boxes, k, css, g, sheetW: g.G + g.pageW + g.R };
}
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} ≈ ${b}`);
function sameScaled(at, base, f, tol, what) {
  assert.deepEqual(Object.keys(at.boxes).sort(), Object.keys(base.boxes).sort(), `${what}: the same boxes`);
  for (const [id, r] of Object.entries(base.boxes)) for (const key of ['left', 'top', 'width', 'height']) near(at.boxes[id][key], r[key] * f, tol, `${what} ${id}.${key}`);
}

test('at 50% and 200% every card\'s left, top, width and height against the page are its 100% values times the zoom', async () => {
  const { view } = viewer();
  view.zoom = 1;
  await view.layout(null);
  const base = onScreen(view);
  assert.equal(base.k, 1);
  assert.deepEqual(Object.keys(base.boxes).sort(), ['m1', 'm2', 'm3'], 'one card a mark: its note and its answers');
  assert.equal(base.boxes.m1.width, 320, 'today\'s sizes at 100%: ASK_W, the note and its answer alike');
  assert.equal(base.boxes.m1.height, 44 + 120);
  assert.equal(base.boxes.m2.height, 44 + 2 * 120, 'the answer moved on its own before is in the card');
  assert.equal(base.boxes.m1.left, 612 + 12, 'SIDE_GAP from the page\'s edge');
  near(base.boxes.m2.left, 1.3 * 612, 1e-9, 'the card where the mark was moved');
  assert.equal(view.sheets[1].wrap.querySelectorAll('line').length, 0, 'nothing joins anything');
  for (const f of [0.5, 2]) {
    view.zoomTo(f * 100);
    await view.layout(undefined);
    const at = onScreen(view);
    assert.equal(at.k, f, `the boxes' layer is scaled ${f}×`);
    assert.equal(at.g.pageW, 612 * f);
    sameScaled(at, base, f, 1e-6, `${f * 100}%`);
  }
});

test('the desk scales too: at least DESK desk px a side, and as wide as a moved box needs, so none is cut off at its edge', async () => {
  const { DESK } = await loadCanvas();
  const { view } = viewer();
  for (const f of [0.5, 1, 2]) {
    view.zoom = f;
    await view.layout(undefined);
    const at = onScreen(view);
    assert.ok(at.g.G >= DESK * f && at.g.R >= DESK * f, `${f * 100}%: the desk is ${DESK}·${f} a side at least`);
    for (const [id, r] of Object.entries(at.boxes)) {
      assert.ok(at.g.G + r.left >= 0, `${f * 100}% ${id} inside the desk's left edge`);
      assert.ok(at.g.G + r.left + r.width <= at.sheetW, `${f * 100}% ${id} inside its right edge`);
    }
  }
});

test('a pinch that settles draws every box where, and as big as, the pinch left it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { view } = viewer();
  view.zoom = 1;
  await view.layout(null);
  const wheel = { ctrlKey: true, deltaY: -25, deltaMode: 0, clientX: 300, clientY: 200, preventDefault() {} };
  view.pinch(wheel);
  view.pinch(wheel);
  const live = view.live;
  assert.ok(live > 1.6 && live < 1.7);
  const during = onScreen(view);
  assert.ok(Math.abs(during.css - live) < 1e-9, 'the drawing is CSS-zoomed while the pinch is under way');
  const before = onScreen((view.inner.style.zoom = '', view));
  view.inner.style.zoom = String(live);
  sameScaled(during, before, live, 1e-6, 'during the pinch'); // what the pinch shows: the boxes grown with the page
  let settled = null;
  const layout = view.layout.bind(view);
  view.layout = (...args) => (settled = layout(...args));
  t.mock.timers.tick(180);
  assert.ok(settled, 'the pinch settled and the pages are laid out again');
  await settled;
  const after = onScreen(view);
  assert.equal(after.css, 1, 'no CSS zoom left');
  assert.equal(after.k, live, 'drawn at the zoom the pinch ended on');
  // The page is drawn a whole number of px wide (612·live rounded), so a box may land within a px of where it was.
  sameScaled(after, during, 1, 1, 'settled');
});

test('a box dropped at 200% is where it was dropped at 100% and 50%: `pos` keeps its meaning', async () => {
  const { view } = viewer({ 1: [{ id: 'm1', rects: [{ x: 0.1, y: 0.2, w: 0.5, h: 0.015 }], side: 'right', y: 0.2, note: 'n', text: 'a' }] });
  view.zoom = 2;
  await view.layout(null);
  // Dragged by its grip 100 screen px right and 40 down (the view at 200%, no pinch).
  const b = view.drawn[1].boxes[0], startLeft = b.left, startTop = b.top;
  const el = b.el;
  el.getBoundingClientRect = () => ({ left: startLeft * 2, top: startTop * 2 }); // the sheet's top-left is the screen's
  view.startDrag({ button: 0, clientX: startLeft * 2 + 10, clientY: startTop * 2 + 5, preventDefault() {}, stopPropagation() {} }, el, 1);
  view.drag.at = { x: startLeft * 2 + 110, y: startTop * 2 + 45 };
  view.dragTo();
  view.endDrag();
  const m = view.marks[1][0];
  const G1 = view.geo[1].G / 2;
  assert.ok(Math.abs(m.pos.x - (startLeft + 50 - G1) / 612) < 1e-9, 'moved 50 desk px: 100 screen px at 200%');
  assert.ok(Math.abs(m.pos.y - (startTop + 20 + 11) / 612) < 1e-9);
  const at200 = onScreen(view).boxes.m1;
  view.zoom = 0.5;
  await view.layout(undefined);
  const at50 = onScreen(view).boxes.m1;
  for (const key of ['left', 'top', 'width', 'height']) near(at50[key], at200[key] / 4, 1e-6, key);
});

test('one card a highlight: its note, then each answer and each answer being written under a thin divider; an answer\'s question shows only when the note does not ask it now', async () => {
  const { ASK_W } = await loadCanvas();
  const { view } = viewer({
    1: [{ id: 'm1', rects: [{ x: 0.1, y: 0.2, w: 0.5, h: 0.015 }], side: 'right', y: 0.2, note: '@bart and then?', text: 'a', asks: [
      { id: 'a1', question: 'why?', answer: 'Because.', meta: { name: 'Sonnet', effort: 'high' }, pos: { x: -2, y: 0.9 } },
      { id: 'a2', question: 'and then?', answer: 'Then.', pos: null },
    ] }],
  });
  view.props.pendingAsks = [{ askId: 'h1', markId: 'm1', page: 1, question: 'and then?' }];
  view.zoom = 1;
  await view.layout(null);
  const cards = view.sheets[1].notes.querySelectorAll('[data-box]');
  assert.equal(cards.length, 1, 'one card');
  const [card] = cards;
  assert.equal(card.style.width, `${ASK_W}px`, 'one width throughout');
  const [grip, note, a1, a2, run] = card.children;
  assert.ok(grip.dataset.grip && !grip.querySelector('[data-act="remove"]'), 'the handle row, with no trash button (gone 2026-10-07)');
  assert.ok(note.dataset.cardNote, 'the note at the top');
  assert.deepEqual([a1.dataset.ask, a2.dataset.ask, run.dataset.askRun], ['a1', 'a2', 'h1'], 'the answers in order, then the one being written');
  for (const sec of [a1, a2, run]) assert.equal(sec.style.borderTop, '1px solid #ececec', 'a thin divider over each');
  assert.equal(note.style.borderTop, undefined);
  assert.match(a1.innerHTML, />why\?</, 'an earlier question of the thread is shown');
  assert.doesNotMatch(a1.innerHTML, /Sonnet/, 'the model is kept (meta) but not shown (MATH-70 build 3)');
  assert.doesNotMatch(a2.innerHTML, />and then\?</, 'the note asks it now: not shown again');
  assert.equal(run.querySelector('[data-run-question]').style.display, 'none', 'nor over the answer being written');
  // The card is where its mark would be beside the page: a1's own place from before cards is not read.
  assert.equal(view.drawn[1].boxes.length, 1);
  assert.equal(view.drawn[1].boxes[0].left, view.desk(1).G + view.desk(1).pageW + 12);
});
