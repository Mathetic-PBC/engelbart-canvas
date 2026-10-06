'use strict';

// @bart in a PDF highlight's note (src/renderer/pdf/PaperView.jsx, MATH-27 phase 1, 2026-10-06): the @ menu offers Bart at
// the start of a highlight's note, Enter in a note that starts with @bart asks (Shift+Enter is a new line) with the
// passage, the note and the mark's earlier answers as the turns, and a finished answer from the Stage joins its mark. No
// pdf here: the viewer and its note's field are stand-ins (pdf.js and rough.js are not loaded).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');

function load() {
  globalThis.document = { baseURI: 'file:///app/index.html' };
  const filename = path.join(__dirname, '__PaperView-ask-unit.cjs');
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

const ROWS = [
  { kind: 'verb', verb: 'bart', key: 'verb:bart', name: 'Bart' },
  { kind: 'verb', verb: 'note', key: 'verb:note', name: 'Note' },
  { kind: 'item', key: 'r1', row: { id: 'r1', name: 'TutorTrace' }, name: 'TutorTrace' },
];

function field(value) {
  return {
    value, selectionStart: value.length, selectionEnd: value.length, style: {}, scrollHeight: 21, dataset: { mark: 'm1' }, isConnected: true, blurred: 0,
    getBoundingClientRect: () => ({ left: 10, top: 20, bottom: 41, right: 110 }),
    focus() { globalThis.document.activeElement = this; },
    blur() { this.blurred += 1; if (globalThis.document.activeElement === this) globalThis.document.activeElement = null; },
    setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; },
    setRangeText(text, a, b) { this.value = this.value.slice(0, a) + text + this.value.slice(b); this.selectionStart = this.selectionEnd = a + text.length; },
  };
}

/** A viewer with one mark on page 2 whose note holds `typed`: a highlight unless `free`, its field focused. */
function viewer(typed, { free = false, asks, props = {} } = {}) {
  const asked = [], drawn = [];
  const all = { mentionItems: () => ROWS, onOpenMention: () => {}, onAsk: (ask) => asked.push(ask), ...props };
  for (const key of Object.keys(all)) if (all[key] === undefined) delete all[key];
  const view = new PaperView(all);
  view.props = all;
  view.setState = (patch) => Object.assign(view.state, typeof patch === 'function' ? patch(view.state) : patch);
  const m = { id: 'm1', rects: free ? [] : [{ x: 0.1, y: 0.2, w: 0.5, h: 0.015 }], side: 'right', y: 0.2, note: typed, text: 'Cohen\'s κ was 0.79 overall', pos: free ? { x: 0.1, y: 0.1 } : null, ...(asks ? { asks } : {}) };
  view.marks = { 2: [m] };
  const ta = field(typed);
  view.find1 = (sel) => (sel === 'textarea[data-mark="m1"]' ? ta : null);
  view.renderMarks = (page) => drawn.push(page);
  let saves = 0, flushed = 0;
  view.scheduleSave = () => { saves += 1; };
  view.flushSave = () => { flushed += 1; };
  globalThis.document = { activeElement: ta };
  globalThis.requestAnimationFrame = () => 0;
  return { view, m, ta, asked, drawn, saves: () => saves, flushed: () => flushed };
}
const key = (k, more = {}) => ({ key: k, shiftKey: false, isComposing: false, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...more });

test.afterEach(() => { delete globalThis.document; delete globalThis.requestAnimationFrame; });

test('the @ menu offers Bart at the start of a highlight\'s note, and library items as before', () => {
  const { view, m, ta } = viewer('@ba');
  view.noteMention(ta, m, 2);
  assert.deepEqual(view.mentionList().map((r) => r.key), ['verb:bart', 'r1'], 'Bart, and items; not Note');
  const later = viewer('see @ba');
  later.view.noteMention(later.ta, later.m, 2);
  assert.deepEqual(later.view.mentionList().map((r) => r.key), ['r1'], 'not in the middle of a note: it could not ask from there');
  const free = viewer('@ba', { free: true });
  free.view.noteMention(free.ta, free.m, 2);
  assert.deepEqual(free.view.mentionList().map((r) => r.key), ['r1'], 'a free note has no passage to ask about');
  const none = viewer('@ba', { props: { onAsk: undefined } });
  none.view.noteMention(none.ta, none.m, 2);
  assert.deepEqual(none.view.mentionList().map((r) => r.key), ['r1'], 'nor one with nowhere to send it');
});

test('Bart picked writes @Bart and a space, and the note is saved', () => {
  const { view, m, ta, saves } = viewer('@ba');
  view.noteMention(ta, m, 2);
  view.noteKey(key('Enter'), ta, m, 2);
  assert.equal(ta.value, '@Bart ');
  assert.equal(m.note, '@Bart ');
  assert.equal(saves(), 1);
});

test('Enter in a highlight\'s note that starts with @bart asks: the passage, the note, the question, no turns yet; the note shows as text', () => {
  const { view, m, ta, asked, flushed } = viewer('@bart why is κ = 0.79 good?');
  view.editing = 'm1';
  const enter = key('Enter');
  view.noteKey(enter, ta, m, 2);
  assert.ok(enter.prevented && enter.stopped);
  assert.deepEqual(asked, [{ markId: 'm1', page: 2, quote: 'Cohen\'s κ was 0.79 overall', note: '@bart why is κ = 0.79 good?', question: 'why is κ = 0.79 good?', turns: [] }]);
  assert.equal(flushed(), 1, 'what the note says is saved first');
  assert.equal(ta.blurred, 1);
  assert.equal(view.editing, null);
  assert.equal(m.note, '@bart why is κ = 0.79 good?', 'the note keeps what was typed');
});

test('a second @bart on the same mark sends its answers as the turns; the page is found when the caller does not say', () => {
  const asks = [{ id: 'a1', question: 'why?', answer: 'Because.', meta: {}, at: 'x', pos: null, collapsed: false }];
  const { view, m, ta, asked } = viewer('@Bart and then?', { asks });
  view.noteKey(key('Enter'), ta, m);
  assert.deepEqual(asked.map((a) => [a.question, a.page, a.turns]), [['and then?', 2, [{ question: 'why?', answer: 'Because.' }]]]);
});

test('Shift+Enter is a new line; a note without @bart, a free note, an empty question or a key still being composed do not ask', () => {
  const cases = [
    ['@bart why', key('Enter', { shiftKey: true }), {}],
    ['why @bart', key('Enter'), {}],
    ['@bart why', key('Enter'), { free: true }],
    ['@bart why', key('Enter', { isComposing: true }), {}],
  ];
  for (const [typed, ev, options] of cases) {
    const { view, m, ta, asked } = viewer(typed, options);
    view.noteKey(ev, ta, m, 2);
    assert.equal(ev.prevented, false, `${typed}: a line break, as before`);
    assert.deepEqual(asked, []);
  }
  const empty = viewer('@bart   ');
  const enter = key('Enter');
  empty.view.noteKey(enter, empty.ta, empty.m, 2);
  assert.ok(enter.prevented, 'nothing to ask: Enter adds no line either');
  assert.deepEqual(empty.asked, []);
});

test('addAsk: a finished answer joins its mark once, is drawn and saved; a mark that is gone takes nothing', () => {
  const { view, m, drawn, saves } = viewer('@bart why?');
  view.syncOffscreen = () => {};
  const entry = { id: 'a1', question: 'why?', answer: 'Because.', meta: { name: 'Sonnet', effort: 'high' }, at: 'now', pos: null, collapsed: false };
  assert.equal(view.addAsk(2, 'm1', entry), true);
  assert.equal(view.addAsk(2, 'm1', entry), true);
  assert.deepEqual(m.asks, [entry]);
  assert.deepEqual(drawn, [2, 2]);
  assert.equal(saves(), 2);
  assert.equal(view.addAsk(2, 'gone', entry), false);
  assert.equal(view.addAsk(5, 'm1', entry), false);
});
