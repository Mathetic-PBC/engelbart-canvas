'use strict';

// MATH-27 follow-up (src/renderer/pdf/PaperView.jsx, canvas.js and src/renderer/model/doc.js, 2026-10-06): a drag from
// blank space pans and one from text selects; a click on blank space writes no note, a double-click does; a free note left
// empty goes when it loses the keyboard and is never saved; a highlight's card has no arrow (taken out again the same
// day); @bart at the start of a note is the document's blue
// label, shown and in its field's backdrop. PaperView lays out one page of a small fake DOM here (no pdf.js, no rough.js):
// the page's text is a few spans placed by hand.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const { buildSync } = require('esbuild');

const loadCanvas = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/pdf/canvas.js')).href);
const loadDoc = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);

function loadView() {
  globalThis.document = { baseURI: 'file:///app/index.html' };
  const filename = path.join(__dirname, '__PaperView-blank-arrows-unit.cjs');
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

const cardHeight = (el) => 44 + el.children.filter((c) => c.dataset.ask != null).length * 120;
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
// One simple selector: `tag`, `[data-name]`, `[data-name="v"]`, `tag[data-name...]`, `.class`, `a[href]`; of a list or a
// descendant chain, any one and its last part.
function matchOne(el, sel) {
  const last = sel.trim().split(/\s+/).pop();
  if (last.startsWith('.')) return String(el.className || '').split(/\s+/).includes(last.slice(1));
  const m = last.match(/^([a-z]+)?(?:\[(data-)?([\w-]+)(?:="([^"]*)")?\])?$/i);
  if (!m || (!m[1] && !m[3])) return false;
  if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
  if (m[3]) {
    const v = m[2] ? el.dataset[camel(m[3])] : el.attrs[m[3]];
    if (v == null || (m[4] != null && String(v) !== m[4])) return false;
  }
  return true;
}
const matches = (el, sel) => String(sel).split(',').some((one) => matchOne(el, one));
const ZERO = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
class El {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.nodeName = this.tagName; this.nodeType = 1; this.children = []; this.parentNode = null; this.dataset = {}; this.attrs = {}; this.style = styleOf(); this.html = ''; this.scrollHeight = 21; this.scrollTop = 0; this.rect = null; }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return !!n.root; }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { return this.children[this.children.length - 1] || null; }
  get offsetWidth() { return parseFloat(this.style.width) || 0; }
  get offsetHeight() { return this.dataset.box === 'card' ? cardHeight(this) : 0; }
  get offsetLeft() { return 0; }
  get offsetTop() { return 0; }
  set innerHTML(v) { for (const c of this.children) c.parentNode = null; this.children = []; this.html = String(v); }
  get innerHTML() { return this.html; }
  appendChild(c) { if (c.parentNode) c.remove(); c.parentNode = this; this.children.push(c); return c; }
  append(...cs) { for (const c of cs) this.appendChild(c); }
  prepend(c) { if (c.parentNode) c.remove(); c.parentNode = this; this.children.unshift(c); }
  replaceChildren(...cs) { for (const c of this.children) c.parentNode = null; this.children = []; this.append(...cs); }
  replaceWith(n) { const p = this.parentNode; if (!p) return; if (n.parentNode) n.remove(); p.children[p.children.indexOf(this)] = n; n.parentNode = p; this.parentNode = null; }
  remove() { const p = this.parentNode; if (p) { p.children.splice(p.children.indexOf(this), 1); this.parentNode = null; } }
  contains(n) { for (; n; n = n.parentNode) if (n === this) return true; return false; }
  closest(sel) { for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (matches(n, sel)) return n; return null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  getBoundingClientRect() { return this.rect || ZERO; }
  getContext() { return {}; }
  querySelectorAll(sel) { const out = []; const walk = (el) => { for (const c of el.children) { if (matches(c, sel)) out.push(c); walk(c); } }; walk(this); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  // A field's keyboard, as a textarea's.
  focus() { globalThis.document.activeElement = this; if (this.onfocus) this.onfocus(); }
  blur() { if (globalThis.document.activeElement !== this) return; globalThis.document.activeElement = globalThis.document.body; if (this.onblur) this.onblur(); }
  setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; }
}
function fakeDocument() {
  const body = new El('body');
  return { baseURI: 'file:///app/index.html', body, activeElement: body, createElement: (tag) => new El(tag), createElementNS: (_, tag) => new El(tag) };
}

// One page 612 × 792 pt in a pane 612px wide at 100%: the page is 612px wide, with 400px of desk each side (G = 400). The
// view is scrolled 300px across, so the sheet starts at client x −300 and the page at client x 100.
const W = 612, H = 700, SCROLL = 300, G = 400;
const pdfPage = { getViewport: ({ scale }) => ({ width: 612 * scale, height: 792 * scale }), render: () => ({ promise: Promise.resolve(), cancel() {} }), getTextContent: () => Promise.resolve({ items: [] }) };
const at = (x, y) => ({ x: x - SCROLL, y }); // client px of a point at (x, y) in the sheet's px (sheet px 300–912 are in view)

async function viewer(marks = {}, props = {}) {
  globalThis.document = fakeDocument();
  const frames = [];
  globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
  globalThis.cancelAnimationFrame = () => {};
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.getSelection = () => ({ isCollapsed: true, rangeCount: 0 });
  const host = new El('div');
  host.root = true; host.clientWidth = W; host.clientHeight = H; host.clientLeft = 0; host.clientTop = 0; host.scrollLeft = SCROLL; host.scrollTop = 0;
  host.rect = { left: 0, top: 0, right: W, bottom: H, width: W, height: H };
  const all = { marks, ...props };
  const view = new PaperView(all);
  view.props = all;
  view.setState = (patch) => Object.assign(view.state, typeof patch === 'function' ? patch(view.state) : patch);
  view.host = { current: host };
  view.doc = { numPages: 1, getPage: async () => pdfPage };
  view.zoom = 1;
  await view.layout(null);
  host.scrollLeft = SCROLL; host.scrollTop = 0; // layout centered page 1; the tests read the view from here
  const s = view.sheets[1], g = view.geo[1];
  assert.equal(g.G, G);
  s.wrap.rect = { left: -SCROLL, top: 0, right: g.G + g.pageW + g.R - SCROLL, bottom: g.pageH, width: g.G + g.pageW + g.R, height: g.pageH };
  view.inner.rect = s.wrap.rect;
  // The page's text: two lines near its top, 12px tall, 4px apart (sheet px 450–850, 100–112 and 116–128).
  for (const top of [100, 116]) {
    const span = new El('span');
    const c = at(450, top);
    span.rect = { left: c.x, top: c.y, right: c.x + 400, bottom: c.y + 12, width: 400, height: 12 };
    s.tl.appendChild(span);
  }
  const flush = () => { while (frames.length) frames.shift()(); };
  return { view, host, s, g, flush };
}
test.afterEach(() => { for (const name of ['document', 'requestAnimationFrame', 'cancelAnimationFrame', 'window', 'getSelection']) delete globalThis[name]; });

const press = (target, x, y, more = {}) => {
  const c = at(x, y);
  return { button: 0, target, clientX: c.x, clientY: c.y, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...more };
};
const moveTo = (x, y) => { const c = at(x, y); return { clientX: c.x, clientY: c.y }; };

/* ------------------------------------------------------------------------------------------------ blank space */

test('blankAt: off the page, or on it further than a line from every span, is blank; on or near text is not', async () => {
  const { blankAt, rectDistance, LINE } = await loadCanvas();
  const page = { left: 400, top: 0, right: 1012, bottom: 792 };
  const spans = [{ left: 450, top: 100, right: 850, bottom: 112 }, { left: 450, top: 116, right: 850, bottom: 128 }];
  assert.equal(LINE, 14);
  assert.equal(rectDistance(spans[0], 500, 106), 0);
  assert.equal(blankAt(page, spans, 200, 106, LINE), true, 'the desk beside the page');
  assert.equal(blankAt(page, spans, 500, 700, LINE), true, 'the empty end of the page');
  assert.equal(blankAt(page, spans, 425, 106, LINE * 2), false, 'within a line at 200%');
  assert.equal(blankAt(page, spans, 420, 106, LINE), true, 'the margin, 30px from the text at 100%');
  assert.equal(blankAt(page, spans, 500, 114, LINE), false, 'between two lines');
  assert.equal(blankAt(page, spans, 860, 106, LINE), false, 'just past a line\'s end');
  assert.equal(blankAt(page, [], 500, 106, LINE), true, 'a page with no text drawn yet is blank');
  assert.equal(blankAt(page, [{ left: 500, top: 500, right: 500, bottom: 500 }], 500, 500, LINE), true, 'an empty rect counts for nothing');
});

test('pointAt: the desk and the page away from its text are blank, the text and the gaps in it are text, a highlight is a mark', async () => {
  const marks = { 1: [{ id: 'h', rects: [{ x: 50 / 612, y: 100 / 612, w: 100 / 612, h: 12 / 612 }], side: 'left', y: 100 / 612, note: null, text: 'x' }] };
  const { view, s } = await viewer(marks);
  const span = s.tl.children[0];
  const kind = (target, x, y) => { const c = at(x, y); return view.pointAt(target, c.x, c.y).kind; };
  assert.equal(kind(s.wrap, 350, 300), 'blank', 'the desk');
  assert.equal(kind(s.tl, 700, 600), 'blank', 'the page\'s empty lower half');
  assert.equal(kind(s.tl, 420, 300), 'blank', 'its margin');
  assert.equal(kind(span, 600, 105), 'text');
  assert.equal(kind(s.tl, 600, 114), 'text', 'between the lines');
  assert.equal(kind(s.tl, 600, 138), 'text', 'within a line under the last one');
  assert.equal(kind(s.tl, 470, 106), 'mark', 'a highlight: a click focuses it');
  assert.equal(view.pointAt(s.tl, W + 2, 300).kind, 'card', 'the scrollbar is no blank space');
});

test('a drag from blank space pans the view; one from text is left to select', async () => {
  const { view, host, s } = await viewer();
  const down = press(s.tl, 700, 600);
  view.onPanDown(down);
  assert.ok(down.prevented && down.stopped, 'taken: no selection starts');
  assert.equal(host.dataset.panning, undefined, 'not a pan until it moves');
  view.onPanMove(moveTo(702, 601));
  assert.equal(host.scrollLeft, SCROLL, 'under PRESS_MOVE px: still a click');
  view.onPanMove(moveTo(660, 550));
  assert.equal(host.dataset.panning, '1');
  assert.deepEqual([host.scrollLeft, host.scrollTop], [SCROLL + 40, 50], 'the view follows the pointer, both ways');
  view.onPanUp();
  assert.equal(host.dataset.panning, undefined);
  assert.equal(view.pan, null);
  // From the desk too.
  const desk = press(s.wrap, 350, 300);
  view.onPanDown(desk);
  view.onPanMove(moveTo(450, 300));
  assert.equal(host.scrollLeft, SCROLL + 40 - 100);
  view.onPanUp();
  // From text, or near it: not taken, so the browser selects as before.
  for (const [target, x, y] of [[s.tl.children[0], 600, 105], [s.tl, 600, 114]]) {
    const ev = press(target, x, y);
    view.onPanDown(ev);
    assert.equal(ev.prevented, false, `(${x}, ${y}): a selection may start`);
    assert.equal(view.pan, null);
  }
});

test('a click on blank space writes no note: it puts the focus and a pending selection away; a double-click writes one, with the caret in it', async () => {
  const marks = { 1: [{ id: 'h', rects: [{ x: 50 / 612, y: 100 / 612, w: 100 / 612, h: 12 / 612 }], side: 'left', y: 100 / 612, note: 'n', text: 'x' }] };
  const { view, s, flush } = await viewer(marks);
  view.focusMark('h');
  view.pendingSel = { parts: [], text: 'x' };
  view.onPanDown(press(s.tl, 700, 600));
  view.onPanUp();
  assert.deepEqual(view.marks[1].map((m) => m.id), ['h'], 'no note');
  assert.equal(view.focusId, null, 'the focus put away');
  assert.equal(view.pendingSel, null, 'and the pending selection');
  // Old behaviour gone: a click on the page away from a span, through the page's own mouseup, writes nothing either.
  view.pdfDown = at(700, 600);
  view.pdfMouseUp(press(s.tl, 700, 600));
  assert.equal(view.marks[1].length, 1);
  // A double-click on the page's blank space.
  const dbl = press(s.tl, 700, 600);
  view.onDbl(dbl);
  assert.ok(dbl.prevented);
  const free = view.marks[1].find((m) => m.id !== 'h');
  assert.ok(free, 'a free note');
  assert.deepEqual(free.rects, []);
  assert.ok(Math.abs(free.pos.x - 300 / 612) < 1e-9 && Math.abs(free.pos.y - 600 / 612) < 1e-9, 'where it was double-clicked');
  flush();
  const ta = s.notes.querySelector(`textarea[data-mark="${free.id}"]`);
  assert.ok(ta, 'drawn as its field');
  assert.equal(document.activeElement, ta, 'with the keyboard');
  // On the desk too; never on text.
  view.onDbl(press(s.wrap, 350, 300));
  assert.equal(view.marks[1].filter((m) => !m.rects.length).length, 2);
  view.onDbl(press(s.tl.children[0], 600, 105));
  assert.equal(view.marks[1].length, 3, 'a double-click on text selects a word, as it did');
});

test('a free note left empty is gone after a click away or Escape, and never saved', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const saved = [];
  const { view, s, flush } = await viewer({}, { onMarksChange: (marks) => saved.push(marks) });
  view.onDbl(press(s.tl, 700, 600));
  flush();
  assert.equal(view.dirty, false, 'nothing saved for a note with nothing in it');
  let out = null;
  view.emit((marks) => { out = marks; });
  assert.deepEqual(out, {}, 'and should anything else be saved meanwhile, not it');
  // A click away on blank space takes the keyboard from it: it goes.
  view.onPanDown(press(s.wrap, 350, 300));
  view.onPanUp();
  assert.deepEqual(view.marks[1], [], 'gone');
  assert.equal(s.notes.querySelectorAll('textarea').length, 0);
  t.mock.timers.tick(400);
  assert.ok(saved.every((marks) => !(marks[1] || []).length), 'never saved');
  // Escape leaves it the same way; one written in is kept and saved.
  view.onDbl(press(s.tl, 700, 600));
  flush();
  let ta = s.notes.querySelector('textarea');
  view.noteKey({ key: 'Escape', stopPropagation() {}, preventDefault() {} }, ta, view.marks[1][0], 1);
  assert.deepEqual(view.marks[1], []);
  view.onDbl(press(s.tl, 700, 600));
  flush();
  ta = s.notes.querySelector('textarea');
  ta.value = 'kept'; ta.oninput();
  view.onPanDown(press(s.wrap, 350, 300));
  view.onPanUp();
  assert.deepEqual(view.marks[1].map((m) => m.note), ['kept']);
  t.mock.timers.tick(400);
  assert.deepEqual(saved.at(-1)[1].map((m) => m.note), ['kept']);
});

test('keptMarks drops a free note with nothing in it, never a highlight or a note with words', async () => {
  const { keptMarks, emptyFree } = await loadCanvas();
  const list = [{ id: 'e', rects: [], note: '  ', pos: { x: 0, y: 0 } }, { id: 'f', rects: [], note: 'x', pos: { x: 0, y: 0 } }, { id: 'h', rects: [{}], note: '' }];
  assert.deepEqual(keptMarks(list).map((m) => m.id), ['f', 'h']);
  assert.equal(emptyFree(list[0]), true);
  assert.equal(emptyFree({ rects: [], note: '', asks: [{ id: 'a' }] }), false, 'one with an answer is no empty note');
});

/* ------------------------------------------------------------------------------------------------ @bart in notes */

test('noteHtml: with agents, a note\'s leading @bart is the document\'s label; library mentions and the rest as before', async () => {
  const { noteHtml, noteInkHtml, noteParts, noteOffset, inlineHtml } = await loadDoc();
  const doc = inlineHtml('@bart');
  assert.match(doc, /color:#0070f3;font-weight:500/, 'the document\'s label');
  const shown = noteHtml('@bart why @[P](lib:x)?', { agents: true, libName: () => 'Paper' });
  assert.match(shown, /^<span data-agent="bart" [^>]*>@bart<span aria-hidden="true" style="[^"]*color:#0070f3;font:500 [^"]*var\(--font-sans\)[^"]*">@bart<\/span><\/span> why <span data-mention="Paper" data-lib="x"/);
  assert.equal(noteHtml('@bart why', {}), '@bart why', 'without agents it reads as typed');
  assert.equal(noteHtml('why @bart', { agents: true }), 'why @bart', 'only at the start');
  assert.equal(noteHtml('@barty', { agents: true }), '@barty');
  assert.doesNotMatch(noteHtml('@[bart](lib:x)', { agents: true }), /data-agent/, 'a library mention stays one');
  assert.deepEqual(noteParts(' @Bart q', { agents: true }), [' ', '@Bart', ' q'], 'a piece of its own, as the shown note\'s nodes are');
  assert.equal(noteOffset('@bart q', 1, 1, { agents: true }), 6);
  assert.equal(noteInkHtml('@Bart <q> @[P](lib:x)').replace(/<span[\s\S]*<\/span><\/span>/, 'LABEL'), 'LABEL &lt;q&gt; @[P](lib:x)', 'the field\'s backdrop: its text exactly as typed');
  assert.match(noteInkHtml('@Bart q'), /data-agent="bart"/);
});

test('a highlight\'s note starting with @bart shows the label, both shown and in its field while being typed in', async () => {
  const marks = { 1: [{ id: 'h', rects: [{ x: 0.1, y: 0.2, w: 0.5, h: 0.02 }], side: 'right', y: 0.2, note: '@bart why?', text: 'x' }] };
  const { view, s } = await viewer(marks, { onOpenMention() {}, onAsk() {} });
  const shown = s.notes.querySelector('[data-note-view="h"]');
  assert.ok(shown, 'shown as text');
  assert.match(shown.innerHTML, /data-agent="bart"[\s\S]*color:#0070f3/);
  view.editNote(view.marks[1][0], 1, null);
  const ta = s.notes.querySelector('textarea[data-mark="h"]'), ink = s.notes.querySelector('[data-note-ink="h"]');
  assert.ok(ta && ink, 'a field over a backdrop');
  assert.equal(ta.parentNode, ink.parentNode);
  assert.equal(ta.style.color, 'transparent', 'the field\'s own text is transparent');
  assert.equal(ta.style.caretColor, '#1f2633', 'its caret is not');
  assert.equal(ink.style.pointerEvents, 'none');
  assert.match(ink.innerHTML, /^<span data-agent="bart"[\s\S]*<\/span><\/span> why\?$/);
  ta.value = '@bart why? see @[P](lib:x)'; ta.oninput();
  assert.match(ink.innerHTML, / why\? see @\[P\]\(lib:x\)$/, 'kept as typed while typing');
  ta.value = 'no agent'; ta.oninput();
  assert.equal(ink.innerHTML, 'no agent');
  // A free note asks no one: no backdrop, no label.
  const free = await viewer({ 1: [{ id: 'f', rects: [], side: null, y: 0.5, note: '@bart hi', text: '', pos: { x: 0.1, y: 0.5 } }] }, { onOpenMention() {}, onAsk() {} });
  assert.doesNotMatch(free.s.notes.querySelector('[data-note-view="f"]').innerHTML, /data-agent/);
});
