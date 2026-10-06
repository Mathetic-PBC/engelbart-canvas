'use strict';

// Removing a highlight or a note in a pdf (src/renderer/pdf/PaperView.jsx, MATH-66, 2026-10-06): Backspace / Delete on the
// highlight in focus while nothing has the keyboard, or a card's trash button, takes the mark away (every part of a
// selection across pages with it), an answer still being written on it is stopped first, and ⌘Z or the toast's Undo
// brings it back whole. No pdf here: the viewer, its cards and its keys are stand-ins (pdf.js and rough.js are not loaded).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');

function load() {
  globalThis.document = { baseURI: 'file:///app/index.html' };
  const filename = path.join(__dirname, '__PaperView-remove-unit.cjs');
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/pdf/PaperView.jsx')], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom', 'pdfjs-dist', 'roughjs'], loader: { '.css': 'empty' } });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  const stubs = { 'pdfjs-dist': { GlobalWorkerOptions: {} }, roughjs: { __esModule: true, default: null } };
  compiled.require = (id) => (id in stubs ? stubs[id] : Module.prototype.require.call(compiled, id));
  compiled._compile(bundled.outputFiles[0].text, filename);
  delete globalThis.document;
  return compiled.exports;
}

const PaperView = load().default;

// A few lines of the DOM a card is made of (PaperView cardBox): elements with their dataset, style, children, text and
// attributes, and querySelector / closest by a data attribute. innerHTML is kept as given.
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase(); this.dataset = {}; this.children = []; this.parentNode = null; this.attrs = {};
    this.text = ''; this.html = ''; this.title = ''; this.value = ''; this.scrollTop = 0;
    const style = {};
    Object.defineProperty(style, 'cssText', { get: () => '', set: (css) => { for (const decl of String(css).split(';')) { const at = decl.indexOf(':'); if (at > 0) style[decl.slice(0, at).trim().replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = decl.slice(at + 1).trim(); } } });
    this.style = style;
  }
  appendChild(el) { el.parentNode = this; this.children.push(el); return el; }
  append(...els) { for (const el of els) this.appendChild(el); }
  replaceChildren(...els) { for (const c of this.children) c.parentNode = null; this.children = []; this.append(...els); }
  get textContent() { return this.children.length ? this.children.map((c) => c.textContent).join('') : this.text; }
  set textContent(value) { this.replaceChildren(); this.text = String(value); }
  get innerHTML() { return this.html; }
  set innerHTML(value) { this.replaceChildren(); this.html = String(value); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  matches(sel) {
    const m = String(sel).match(/^\[data-([\w-]+)(?:="([^"]*)")?\]$/);
    if (!m) return false;
    const k = m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    return k in this.dataset && (m[2] == null || this.dataset[k] === m[2]);
  }
  querySelector(sel) { for (const c of this.children) { if (c.matches(sel)) return c; const deep = c.querySelector(sel); if (deep) return deep; } return null; }
  closest(sel) { for (let el = this; el; el = el.parentNode) if (el.matches(sel)) return el; return null; }
}

const views = [];
/** A viewer with marks `marks` ({ [page]: Mark[] }); renderMarks and the save are counted, not done. */
function viewer(marks, props = {}) {
  const drawn = [], stopped = [];
  const all = { mentionItems: () => [], onOpenMention: () => {}, onAsk: () => {}, onStopAsk: (id) => stopped.push(id), ...props };
  const view = new PaperView(all);
  view.props = all;
  view.setState = (patch) => Object.assign(view.state, typeof patch === 'function' ? patch(view.state) : patch);
  view.marks = marks;
  view.find1 = () => null;
  view.renderMarks = (page) => drawn.push(page);
  let saves = 0;
  view.scheduleSave = () => { saves += 1; };
  globalThis.document = { activeElement: null, createElement: (tag) => new El(tag) };
  globalThis.requestAnimationFrame = () => 0;
  views.push(view);
  return { view, drawn, stopped, saves: () => saves };
}
const highlight = (id, more = {}) => ({ id, rects: [{ x: 0.1, y: 0.2, w: 0.5, h: 0.015 }], side: 'right', y: 0.2, note: null, text: 'Cohen\'s κ was 0.79 overall', ...more });
const freeNote = (id, more = {}) => ({ id, rects: [], side: null, y: 0.1, note: 'check this', text: '', pos: { x: 0.1, y: 0.1 }, ...more });

/** The paper's host, a note's field in it, something of the paper's that is no control, and the document's body. */
function keyboard(view) {
  const body = { nodeName: 'BODY' };
  const inside = { closest: () => null };
  const ta = { tagName: 'TEXTAREA', closest: (sel) => (sel.includes('textarea') ? ta : null) };
  const held = new Set([ta, inside]);
  view.host.current = { dataset: {}, contains: (t) => held.has(t), querySelectorAll: () => [] };
  view.root.current = { contains: (t) => held.has(t) };
  globalThis.document.body = body;
  view.onPointerDown({ target: inside }); // the last press was on the paper
  return { body, inside, ta };
}
const keyEv = (target, more = {}) => ({ target, key: '', code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...more });
const click = (target) => ({ target, button: 0, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } });
/** The element in a React tree whose props hold `key`. */
function findEl(node, key) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) { for (const n of node) { const hit = findEl(n, key); if (hit) return hit; } return null; }
  if (node.props && key in node.props) return node;
  return node.props ? findEl(node.props.children, key) : null;
}

test.afterEach(() => {
  for (const view of views.splice(0)) view.hideRemoved();
  delete globalThis.document; delete globalThis.requestAnimationFrame;
});

test('Delete (or Backspace) on a focused highlight removes it and its card, saves, and says so', () => {
  const m = highlight('m1', { note: 'a note' }), other = highlight('m2', { y: 0.5 });
  const { view, drawn, saves } = viewer({ 2: [m, other] });
  const { body } = keyboard(view);
  view.focusMark('m1');
  const ev = keyEv(body, { key: 'Delete' });
  view.onKeyCapture(ev);
  assert.ok(ev.prevented && ev.stopped);
  assert.deepEqual(view.marks[2].map((x) => x.id), ['m2'], 'its mark is gone: its card is not drawn again');
  assert.deepEqual(drawn, [2], 'its page drawn again');
  assert.equal(saves(), 1);
  assert.equal(view.focusId, null);
  assert.equal(view.state.removed.label, 'Highlight removed');
  view.focusMark('m2');
  const back = keyEv(body, { key: 'Backspace' });
  view.onKeyCapture(back);
  assert.ok(back.prevented);
  assert.deepEqual(view.marks[2], []);
});

test('Delete while typing in a note only edits the text; with nothing in focus, a press elsewhere or a modifier, the key is not the paper\'s', () => {
  const m = highlight('m1', { note: 'a note' });
  const { view, drawn } = viewer({ 2: [m] });
  const { body, ta } = keyboard(view);
  view.focusMark('m1'); // a highlight's note takes the focus as it is typed in (noteField onfocus)
  for (const k of ['Delete', 'Backspace']) {
    const ev = keyEv(ta, { key: k });
    view.onKeyCapture(ev);
    assert.ok(!ev.prevented && !ev.stopped, `${k} is the note's`);
  }
  for (const ev of [keyEv(body, { key: 'Delete', metaKey: true }), keyEv(body, { key: 'Backspace', altKey: true }), keyEv(body, { key: 'x' })]) {
    view.onKeyCapture(ev);
    assert.ok(!ev.prevented);
  }
  view.onPointerDown({ target: { nodeName: 'DIV' } }); // a press outside the pane
  const away = keyEv(body, { key: 'Delete' });
  view.onKeyCapture(away);
  assert.ok(!away.prevented, 'the last press was not on the paper');
  keyboard(view); // a press on the paper again
  view.focusMark(null);
  const none = keyEv(body, { key: 'Delete' });
  view.onKeyCapture(none);
  assert.ok(!none.prevented, 'no mark in focus');
  assert.deepEqual(view.marks[2], [m]);
  assert.deepEqual(drawn, []);
});

test('the trash button in the handle row removes a free note and a highlight; a press on it is no drag and keeps the keyboard', () => {
  const note = freeNote('n1'), hl = highlight('m1', { note: 'why so high?' });
  const { view, saves } = viewer({ 2: [note, hl] });
  const card = view.cardBox(note, [], [], 2), grip = card.querySelector('[data-grip]'), trash = card.querySelector('[data-act="remove"]');
  assert.ok(grip && trash && trash.parentNode === grip, 'in the handle row');
  assert.equal(trash.getAttribute('aria-label'), 'Remove note');
  view.drawn[2] = { boxes: [{ el: card, m: note }], units: [] };
  const press = click(trash);
  trash.onmousedown(press);
  assert.ok(press.prevented && press.stopped, 'the keyboard stays where it is');
  view.startDrag(click(trash), card, 2);
  assert.equal(view.drag, null, 'the grip does not drag from it');
  trash.onclick(click(trash));
  assert.deepEqual(view.marks[2].map((x) => x.id), ['m1']);
  assert.equal(view.state.removed.label, 'Note removed');
  const hlCard = view.cardBox(hl, [], [], 2), hlTrash = hlCard.querySelector('[data-act="remove"]');
  assert.equal(hlTrash.getAttribute('aria-label'), 'Remove highlight');
  hlTrash.onclick(click(hlTrash));
  assert.deepEqual(view.marks[2], []);
  assert.equal(view.state.removed.label, 'Highlight removed');
  assert.equal(saves(), 2);
});

test('a highlight across pages goes whole and ⌘Z brings it back whole, each part where it stood', () => {
  const first = highlight('m1', { group: 'g1', note: 'the claim' }), second = highlight('m2', { group: 'g1', y: 0.05, text: 'across 480 students' });
  const before = highlight('m0', { y: 0.01 }), after = highlight('m3', { y: 0.6 }), elsewhere = highlight('m4', { group: 'g2' });
  const { view, drawn } = viewer({ 2: [first], 3: [before, second, after], 4: [elsewhere] });
  const { body } = keyboard(view);
  view.focusMark('m1');
  view.onKeyCapture(keyEv(body, { key: 'Delete' }));
  assert.deepEqual(view.marks[2], []);
  assert.deepEqual(view.marks[3].map((x) => x.id), ['m0', 'm3']);
  assert.deepEqual(view.marks[4].map((x) => x.id), ['m4'], 'another selection stays');
  assert.deepEqual(drawn.sort(), [2, 3]);
  assert.equal(view.undos.length, 2, 'one a part');
  const z = keyEv(body, { key: 'z', metaKey: true });
  view.onKeyCapture(z);
  assert.ok(z.prevented && z.stopped);
  assert.deepEqual(view.marks[2], [first]);
  assert.deepEqual(view.marks[3], [before, second, after], 'back at its index');
  assert.deepEqual(view.undos, []);
  assert.equal(view.state.removed, null, 'the toast goes with it');
});

test('⌘Z and the toast\'s Undo bring the mark back with its answers and place; the last thing taken comes back first', () => {
  const asks = [{ id: 'a1', question: 'why?', answer: 'Because.', meta: {}, at: 'x', pos: null, collapsed: false }, { id: 'a2', question: 'and?', answer: 'Then.', meta: {}, at: 'x' }];
  const m = highlight('m1', { note: '@bart why?', asks, pos: { x: 1.1, y: 0.3 } });
  const { view, saves } = viewer({ 2: [m] });
  const { body } = keyboard(view);
  const act = { dataset: { act: 'delete' }, textContent: '', isConnected: true };
  view.askClick({ target: { closest: (sel) => (sel === '[data-act]' ? act : null) }, preventDefault() {} }, m, asks[1], 2); // an answer deleted first
  view.removeMark(2, m);
  assert.deepEqual(view.marks[2], []);
  view.onKeyCapture(keyEv(body, { key: 'z', metaKey: true }));
  const back = view.marks[2][0];
  assert.equal(back, m);
  assert.deepEqual([back.note, back.asks.map((a) => a.id), back.pos], ['@bart why?', ['a1', 'a2'], { x: 1.1, y: 0.3 }]);
  assert.ok(back.asks[1].deleted, 'the mark first; the answer deleted before it is still to come');
  view.onKeyCapture(keyEv(body, { key: 'z', metaKey: true }));
  assert.ok(!('deleted' in back.asks[1]));
  // The toast's Undo.
  view.removeMark(2, m);
  assert.equal(view.state.removed.label, 'Highlight removed');
  const undo = findEl(view.render(), 'data-removed-undo');
  assert.ok(undo, 'the toast shows Undo');
  undo.props.onClick();
  assert.deepEqual(view.marks[2], [m]);
  assert.deepEqual(m.asks.map((a) => a.id), ['a1', 'a2']);
  assert.deepEqual(m.pos, { x: 1.1, y: 0.3 });
  assert.equal(view.state.removed, null);
  assert.equal(findEl(view.render(), 'data-removed-undo'), null);
  assert.ok(saves() >= 4, 'each removal and each undo saved');
});

test('the toast goes by itself after about 5 seconds; ⌘Z still brings the mark back', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const m = freeNote('n1');
  const { view } = viewer({ 2: [m] });
  const { body } = keyboard(view);
  view.removeMark(2, m);
  assert.equal(view.state.removed.label, 'Note removed');
  t.mock.timers.tick(4900);
  assert.ok(view.state.removed);
  t.mock.timers.tick(200);
  assert.equal(view.state.removed, null);
  view.onKeyCapture(keyEv(body, { key: 'z', metaKey: true }));
  assert.deepEqual(view.marks[2], [m]);
});

test('an answer still being written on the mark is stopped before it goes, as its Stop button does; nothing lands on it after', () => {
  const m = highlight('m1', { group: 'g1', note: '@bart why?' }), part = highlight('m2', { group: 'g1' });
  const pendingAsks = [
    { askId: 'h1', markId: 'm1', page: 2, question: 'why?' },
    { askId: 'h2', markId: 'm2', page: 3, question: 'how?' },
    { askId: 'h3', markId: 'other', page: 2, question: 'what?' },
    { askId: 'h4', markId: 'm1', page: 2, question: 'when?', error: 'The CLI quit.' },
  ];
  const seen = [];
  const { view } = viewer({ 2: [m, highlight('other')], 3: [part] }, { pendingAsks, onStopAsk: (id) => seen.push([id, view.marks[2].includes(m)]) });
  view.removeMark(2, m);
  assert.deepEqual(seen, [['h1', true], ['h2', true]], 'stopped while the mark was still there; a failed one has nothing to stop');
  assert.equal(view.addAsk(2, 'm1', { id: 'a9', question: 'why?', answer: 'Late.' }), false, 'an answer that comes anyway lands on nothing');
});
