'use strict';

// Drawing a pdf's pages (src/renderer/pdf/PaperView.jsx and src/renderer/model/paper-draw.js, MATH-71, 2026-10-07):
// a page drawn for the first time goes over its white sheet, not under it (it was blank until a zoom); the pages in view
// are drawn first and a scroll while drawing moves what comes next; a page far from the view gives its drawing back and
// is drawn again when it comes near; a drawing that fails keeps what was there and does not stop the rest. PaperView
// lays out a twenty-page stand-in here, in a small fake DOM (no pdf.js, no rough.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const { buildSync } = require('esbuild');

const loadDraw = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/paper-draw.js')).href);

function loadView() {
  globalThis.document = { baseURI: 'file:///app/index.html' };
  const filename = path.join(__dirname, '__PaperView-draw-unit.cjs');
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
  get offsetWidth() { return parseFloat(this.style.width) || 0; }
  get offsetHeight() { return 0; }
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
  getContext() { return { canvas: this }; }
  querySelectorAll(sel) { const out = []; const walk = (el) => { for (const c of el.children) { if (matches(c, sel)) out.push(c); walk(c); } }; walk(this); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
const fakeDocument = () => ({ baseURI: 'file:///app/index.html', activeElement: null, body: new El('body'), createElement: (tag) => new El(tag), createElementNS: (_, tag) => new El(tag) });

// Twenty pages 612 × 792 pt in a pane 612 × 700: at 100% a page is 612 × 792 px, so one page fills the view.
const W = 612, H = 700, N = 20;

// Pages whose drawings are recorded: `hold` makes each drawing wait until released, `fail` the pages that cannot be drawn.
function pdf({ hold = false, fail = [] } = {}) {
  const calls = [], waiting = [];
  const page = (n) => ({
    getViewport: ({ scale }) => ({ width: 612 * scale, height: 792 * scale }),
    getTextContent: () => Promise.resolve({ items: [] }),
    render: ({ canvasContext }) => {
      calls.push(n);
      let done, failed;
      const promise = new Promise((res, rej) => { done = res; failed = rej; });
      const go = () => (fail.includes(n) ? failed(new Error('bad page')) : done());
      if (hold) waiting.push({ n, go }); else go();
      canvasContext.canvas.page = n;
      return { promise, cancel: () => failed(Object.assign(new Error('cancelled'), { name: 'RenderingCancelledException' })) };
    },
  });
  return { calls, waiting, doc: { numPages: N, getPage: async (n) => page(n) } };
}

function viewer(fake) {
  globalThis.document = fakeDocument();
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  const host = new El('div');
  host.root = true; host.clientWidth = W; host.clientHeight = H; host.clientLeft = 0; host.clientTop = 0; host.scrollLeft = 0; host.scrollTop = 0;
  const view = new PaperView({ marks: {} });
  view.setState = (patch) => Object.assign(view.state, typeof patch === 'function' ? patch(view.state) : patch);
  view.host = { current: host };
  view.doc = fake.doc;
  return { view, host };
}
test.afterEach(() => { for (const name of ['document', 'requestAnimationFrame', 'cancelAnimationFrame', 'window']) delete globalThis[name]; });

const drawnPages = (view) => view.sheets.map((s, n) => (s && s.canvas ? n : 0)).filter(Boolean);
const tick = () => new Promise((r) => setImmediate(r));
async function settle(view) { for (let i = 0; i < 50 && view.pumping; i += 1) await tick(); }
const scrollTo = (view, host, n) => { host.scrollTop = view.tops[n - 1] + 10; view.drawSoon(); };

/* ------------------------------------------------------------------------------------------------ the order */

test('nearOrder: the pages in view from the middle outward, then the ones beside them, below first', async () => {
  const { nearOrder, allOrder, tooFar } = await loadDraw();
  assert.deepEqual(nearOrder(1, 1, 1, 20, 2), [1, 2, 3]);
  assert.deepEqual(nearOrder(5, 7, 6, 20, 2), [6, 7, 5, 8, 4, 9, 3]);
  assert.deepEqual(nearOrder(19, 20, 20, 20, 2), [20, 19, 18, 17]);
  assert.deepEqual(nearOrder(1, 1, 1, 0), []);
  assert.deepEqual(allOrder(3, 3, 3, 5).sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  assert.equal(allOrder(3, 3, 3, 5)[0], 3);
  assert.equal(tooFar(1, 10, 10, 5), true);
  assert.equal(tooFar(5, 10, 10, 5), false);
  assert.equal(tooFar(16, 10, 10, 5), true);
});

/* ------------------------------------------------------------------------------------------------ PaperView */

test('a page drawn for the first time goes over its white sheet and under its highlights', async () => {
  const fake = pdf();
  const { view } = viewer(fake);
  await view.layout(null);
  const s = view.sheets[1], kids = s.wrap.children;
  assert.ok(s.canvas, 'page 1 is drawn');
  assert.ok(kids.indexOf(s.canvas) > kids.indexOf(s.bg), 'the drawing is after (over) the white page');
  assert.ok(kids.indexOf(s.canvas) < kids.indexOf(s.hl), 'and before (under) the highlights');
});

test('only the pages near the view are drawn; every page gets its text', async () => {
  const fake = pdf();
  const { view } = viewer(fake);
  await view.layout(null);
  assert.deepEqual(drawnPages(view), [1, 2, 3]);
  assert.deepEqual(fake.calls, [1, 2, 3]);
  for (let n = 1; n <= N; n += 1) assert.equal(view.sheets[n].texted, true, `page ${n} has its text`);
});

test('a scroll draws the pages it brings near and gives back the drawings it leaves far behind', async () => {
  const fake = pdf();
  const { view, host } = viewer(fake);
  await view.layout(null);
  const first = view.sheets[1].canvas;
  scrollTo(view, host, 15);
  await settle(view);
  assert.deepEqual(drawnPages(view), [13, 14, 15, 16, 17]);
  assert.deepEqual(fake.calls.slice(3), [15, 16, 14, 17, 13], 'the page in view first');
  assert.equal(first.width, 0, 'a drawing given back lets its memory go');
  assert.equal(first.parentNode, null);
  scrollTo(view, host, 1);
  await settle(view);
  assert.deepEqual(drawnPages(view), [1, 2, 3], 'back at the top: drawn again, the far ones given back');
  for (const n of [1, 2, 3]) assert.ok(view.sheets[n].wrap.children.indexOf(view.sheets[n].canvas) > view.sheets[n].wrap.children.indexOf(view.sheets[n].bg));
});

test('a scroll while a page is being drawn: the page now in view is next, and the one left behind is stopped', async () => {
  const fake = pdf({ hold: true });
  const { view, host } = viewer(fake);
  const laid = view.layout(null);
  for (let i = 0; i < 20 && !fake.waiting.length; i += 1) await tick();
  assert.deepEqual(fake.calls, [1]);
  scrollTo(view, host, 12);
  await tick(); await tick();
  assert.equal(view.sheets[1].canvas, null, 'page 1 was stopped, not drawn');
  for (let i = 0; i < 40 && fake.calls.length < 2; i += 1) await tick();
  assert.equal(fake.calls[1], 12, 'the page in view comes next');
  for (let i = 0; i < 200; i += 1) { const w = fake.waiting.shift(); if (w) w.go(); await tick(); if (!view.pumping) break; }
  await laid;
  assert.deepEqual(drawnPages(view), [10, 11, 12, 13, 14]);
});

test('a page that cannot be drawn keeps what was there and the rest are drawn', async () => {
  const fake = pdf({ fail: [2] });
  const { view } = viewer(fake);
  await view.layout(null);
  assert.deepEqual(drawnPages(view), [1, 3]);
  assert.equal(view.sheets[2].failed, true);
  assert.equal(view.sheets[2].texted, true, 'its text is there all the same');
  assert.equal(view.pumping, 0, 'drawing ended');
});

test('a zoom carries the drawings over, stretched, and draws the pages in view again', async () => {
  const fake = pdf();
  const { view } = viewer(fake);
  await view.layout(null);
  const old = view.sheets[1].canvas;
  view.zoom = 1.5;
  await view.layout(undefined);
  const s = view.sheets[1];
  assert.notEqual(s.canvas, old, 'drawn again at the new zoom');
  assert.ok(s.wrap.children.indexOf(s.canvas) > s.wrap.children.indexOf(s.bg));
  assert.equal(old.width, 0, 'the stretched drawing let go once replaced');
});
