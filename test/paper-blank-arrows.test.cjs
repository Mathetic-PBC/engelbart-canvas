'use strict';

// Typing anywhere (src/renderer/pdf/PaperView.jsx, the annotations round, 2026-10-16; as before MATH-27): a click on the
// page or the desk beside it, anywhere but its printed words, writes a note there with the caret in it, and a click that
// puts something away (a pending selection, the highlight in focus, a note being typed in) writes nothing; a press on a
// note's words moved a few px drags its card, one let go puts the caret there. From MATH-27's follow-up (2026-10-06): a
// free note left empty goes when it loses the keyboard and is never saved; @bart at the start of a note is the document's
// blue label, shown and in its field's backdrop. (A drag from blank space panned and a double-click wrote, 2026-10-06 to
// 2026-10-16.) PaperView lays out one page of a small fake DOM here (no pdf.js, no rough.js): the page's text is a few
// spans placed by hand.

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
  constructor(tag) { this.tagName = tag.toUpperCase(); this.nodeName = this.tagName; this.nodeType = 1; this.children = []; this.parentNode = null; this.dataset = {}; this.attrs = {}; this.style = styleOf(); this.html = ''; this.scrollHeight = 21; this.scrollTop = 0; this.rect = null; const classes = new Set(); this.classList = { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) }; }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return !!n.root; }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { return this.children[this.children.length - 1] || null; }
  get offsetWidth() { return parseFloat(this.style.width) || parseFloat(this.style.maxWidth) || 0; }
  get offsetHeight() { return this.dataset.box === 'card' ? cardHeight(this) : 0; }
  get offsetLeft() { return 0; }
  get offsetTop() { return 0; }
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

// One page 612 × 792 pt in a pane 612px wide: at 100% the page is the pane (G = 0); at 50% it is 306px wide in the
// middle of it (G = 153). The view is not scrolled, so a point's client px are its sheet px.
const W = 612, H = 700;
const pdfPage = { getViewport: ({ scale }) => ({ width: 612 * scale, height: 792 * scale }), render: () => ({ promise: Promise.resolve(), cancel() {} }), getTextContent: () => Promise.resolve({ items: [] }) };
const tick = () => new Promise((r) => setTimeout(r, 1));

async function viewer(marks = {}, props = {}, zoom = 1) {
  globalThis.document = fakeDocument();
  const frames = [];
  globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
  globalThis.cancelAnimationFrame = () => {};
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.getSelection = () => ({ isCollapsed: true, rangeCount: 0 });
  const host = new El('div');
  host.root = true; host.clientWidth = W; host.clientHeight = H; host.clientLeft = 0; host.clientTop = 0; host.scrollLeft = 0; host.scrollTop = 0;
  host.rect = { left: 0, top: 0, right: W, bottom: H, width: W, height: H };
  const all = { marks, ...props };
  const view = new PaperView(all);
  view.props = all;
  view.setState = (patch) => Object.assign(view.state, typeof patch === 'function' ? patch(view.state) : patch);
  view.host = { current: host };
  view.doc = { numPages: 1, getPage: async () => pdfPage };
  view.zoom = zoom;
  await view.layout();
  view.drawSoon();
  for (let i = 0; i < 200 && view.pumping; i += 1) await tick();
  const s = view.sheets[1], g = view.geo[1];
  s.wrap.rect = { left: 0, top: 0, right: W, bottom: g.pageH, width: W, height: g.pageH };
  // The page's text: two lines near its top, 12px tall, 4px apart (page px 50–450 across, 100–112 and 116–128 down at
  // 100%), as spans and as the text runs pdf.js gives (textBoxes).
  view.textRects.set(1, [100, 116].map((t) => ({ l: 50 / 612, t: t / 612, r: 450 / 612, b: (t + 12) / 612 })));
  for (const top of [100, 116]) {
    const span = new El('span');
    span.rect = { left: g.G + 50 * g.k, top: top * g.k, right: g.G + 450 * g.k, bottom: (top + 12) * g.k, width: 400 * g.k, height: 12 * g.k };
    s.tl.appendChild(span);
  }
  const flush = () => { while (frames.length) frames.shift()(); };
  return { view, host, s, g, flush };
}
test.afterEach(() => { for (const name of ['document', 'requestAnimationFrame', 'cancelAnimationFrame', 'window', 'getSelection']) delete globalThis[name]; });

const event = (target, x, y, more = {}) => ({ button: 0, target, clientX: x, clientY: y, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...more });
// A click at sheet px (x, y) on `target`, as the paper hears it: its press, then its release.
function click(view, target, x, y) { const e = event(target, x, y); view.onDown(e); view.pdfMouseUp(e); return e; }
const free = (view) => (view.marks[1] || []).filter((m) => !(m.rects || []).length);

/* ------------------------------------------------------------------------------------------------ typing anywhere */

test('a click on the page away from its printed words writes a note there, as wide as the room to its right, with the caret in it', async () => {
  const { freeNoteWidth } = await loadCanvas();
  const { view, s } = await viewer();
  click(view, s.tl, 300, 600);
  const [m] = free(view);
  assert.ok(m, 'a note');
  assert.ok(Math.abs(m.pos.x - 300 / 612) < 1e-9 && Math.abs(m.pos.y - 600 / 612) < 1e-9, 'where it was clicked');
  assert.equal(m.w, freeNoteWidth(300, Infinity, 612), 'as wide as the room to the pane\'s edge, at most NOTE_W');
  const ta = s.notes.querySelector(`textarea[data-mark="${m.id}"]`);
  assert.ok(ta, 'drawn as its field');
  assert.equal(document.activeElement, ta, 'with the keyboard at once, not a frame later');
  // Beside a line of text, it runs up to the text and wraps there.
  ta.value = 'x'; ta.oninput(); ta.blur();
  click(view, s.tl, 10, 100);
  const [, beside] = free(view);
  assert.equal(beside.w, freeNoteWidth(10, 50, 612), 'up to the printed words after it (FREE_MIN at the least)');
});

test('a click on the printed words, or one that puts something away, writes no note; the next click does', async () => {
  const marks = { 1: [{ id: 'h', rects: [{ x: 50 / 612, y: 300 / 612, w: 100 / 612, h: 12 / 612 }], side: 'left', y: 300 / 612, note: null, text: 'x' }] };
  const { view, s } = await viewer(marks);
  click(view, s.tl.children[0], 200, 105);
  assert.equal(free(view).length, 0, 'on a word: the browser\'s, to select');
  // The highlight in focus: the click puts it away.
  view.focusMark('h');
  click(view, s.tl, 300, 600);
  assert.equal(view.focusId, null);
  assert.equal(free(view).length, 0);
  // A pending selection: put away unkept (2026-10-16, later; Hudson: "I should have to hit enter for it to save"), and
  // no note written.
  view.pendingSel = { parts: [{ page: 1, rects: [{ x: 300, y: 400, w: 80, h: 12 }], width: 612, text: 'gone words', u: 612 }], text: 'gone words' };
  click(view, s.tl, 300, 600);
  assert.equal(view.pendingSel, null);
  assert.equal(view.marks[1].find((m) => m.text === 'gone words'), undefined, 'not kept: Enter or a note keeps it');
  assert.equal(free(view).length, 0);
  // Nothing to put away: this one writes.
  click(view, s.tl, 300, 600);
  assert.equal(free(view).length, 1);
  // A note being typed in: the click leaves it, and writes nothing.
  const ta = s.notes.querySelector('textarea');
  ta.value = 'kept'; ta.oninput();
  const e = event(s.tl, 300, 650);
  view.onDown(e); ta.blur(); view.pdfMouseUp(e);
  assert.equal(free(view).length, 1, 'only the note that was being typed in');
  assert.equal(free(view)[0].note, 'kept');
});

test('a click on a highlight puts it in focus, in the gap between two of its words too (one band, 2026-10-16)', async () => {
  // Two words on one line with a gap of 12px, a line 12px tall: one band (BAND_GAP 1.6 lines), though no merge joined them.
  const marks = { 1: [{ id: 'h', rects: [{ x: 50 / 612, y: 300 / 612, w: 60 / 612, h: 12 / 612 }, { x: 122 / 612, y: 300 / 612, w: 60 / 612, h: 12 / 612 }], side: 'left', y: 300 / 612, note: null, text: 'two words' }] };
  const { view, s } = await viewer(marks);
  click(view, s.tl, 116, 306);
  assert.equal(view.focusId, 'h', 'the gap is the highlight');
  assert.equal(free(view).length, 0);
  click(view, s.tl, 300, 600);
  assert.equal(view.focusId, null);
});

test('zoomed out, the desk beside the page takes a note too, as wide as the room that shows', async () => {
  const { NOTE_W } = await loadCanvas();
  const { view, s, g } = await viewer({}, {}, 0.5);
  assert.deepEqual([g.G, g.pageW], [153, 306]);
  click(view, s.wrap, 40, 200);
  const [m] = free(view);
  assert.ok(m.pos.x < 0, 'left of the page');
  assert.ok(Math.abs(m.pos.x - (40 - 153) / 306) < 1e-9);
  assert.equal(m.w, NOTE_W, 'the whole desk to its right showed: as wide as a note gets');
  // Near the pane's right edge, it starts far enough left to show whole.
  const ta = s.notes.querySelector('textarea');
  ta.value = 'on the desk'; ta.oninput(); ta.blur();
  click(view, s.wrap, 605, 300);
  const [, edge] = free(view);
  // Its handwriting at NOTE_FLOOR there (a 306 px page): w note px are w × 10/24 on screen.
  assert.ok(153 + edge.pos.x * 306 + edge.w * 10 / 24 <= 612 - 8 + 1, 'its right edge within the pane (EDGE_PAD in)');
  assert.ok(edge.pos.x * 306 + 153 < 605, 'begun left of where it was clicked');
});

test('a free note left empty is gone after a click away or Escape, and never saved', async (t) => {
  const saved = [];
  const { view, s } = await viewer({}, { onMarksChange: (marks) => saved.push(marks) });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  click(view, s.tl, 300, 600);
  assert.equal(view.dirty, false, 'nothing saved for a note with nothing in it');
  let out = null;
  view.emit((marks) => { out = marks; });
  assert.deepEqual(out, {}, 'and should anything else be saved meanwhile, not it');
  // A click away takes the keyboard from it: it goes.
  s.notes.querySelector('textarea').blur();
  assert.deepEqual(view.marks[1], [], 'gone');
  assert.equal(s.notes.querySelectorAll('textarea').length, 0);
  t.mock.timers.tick(400);
  assert.ok(saved.every((marks) => !(marks[1] || []).length), 'never saved');
  // Escape leaves it the same way; one written in is kept and saved.
  click(view, s.tl, 300, 600);
  let ta = s.notes.querySelector('textarea');
  view.noteKey({ key: 'Escape', stopPropagation() {}, preventDefault() {} }, ta, view.marks[1][0], 1);
  assert.deepEqual(view.marks[1], []);
  click(view, s.tl, 300, 600);
  ta = s.notes.querySelector('textarea');
  ta.value = 'kept'; ta.oninput();
  ta.blur();
  assert.deepEqual(view.marks[1].map((m) => m.note), ['kept']);
  t.mock.timers.tick(400);
  assert.deepEqual(saved.at(-1)[1].map((m) => m.note), ['kept']);
});

test('a press on a note\'s words moved a few px drags its card (no grip); let go before that, the caret goes in', async () => {
  const marks = { 1: [{ id: 'f', rects: [], side: null, y: 0.5, note: 'move me', text: '', pos: { x: 0.2, y: 0.5 }, w: 150 }] };
  const { view, s, flush } = await viewer(marks, { onOpenMention() {} });
  const shown = s.notes.querySelector('[data-note-view="f"]');
  assert.ok(shown, 'shown as text');
  assert.equal(s.notes.querySelectorAll('[data-grip]').length, 0, 'no grip');
  const card = s.notes.querySelector('[data-box]');
  card.rect = { left: 0.2 * 612, top: 0.5 * 612 - 11, width: 150, height: 44 };
  // Pressed and let go where it was: the field, with the keyboard.
  shown.onmousedown(event(shown, 140, 300));
  view.pressUp(event(shown, 140, 300));
  flush();
  const ta = s.notes.querySelector('textarea[data-mark="f"]');
  assert.ok(ta && document.activeElement === ta, 'a click edits it');
  ta.blur(); flush();
  // Pressed and moved 60px right and 30 down: moved, and saved where it was let go.
  const again = s.notes.querySelector('[data-note-view="f"]');
  s.notes.querySelector('[data-box]').rect = card.rect;
  again.onmousedown(event(again, 140, 300));
  view.pressMove({ clientX: 142, clientY: 301 });
  assert.equal(view.drag, null, 'under PRESS_MOVE: still a click');
  view.pressMove({ clientX: 200, clientY: 330 });
  assert.ok(view.drag && view.drag.moved, 'dragging');
  assert.equal(view.focusId, 'f', 'its mark in focus: Delete would remove it');
  view.endDrag();
  const m = view.marks[1][0];
  assert.ok(Math.abs(m.pos.x - (0.2 + 60 / 612)) < 1e-9 && Math.abs(m.pos.y - (0.5 + 30 / 612)) < 1e-9, 'moved by the pointer\'s way');
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
