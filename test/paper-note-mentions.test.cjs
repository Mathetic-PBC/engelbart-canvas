'use strict';

// @ in a PDF margin note (src/renderer/pdf/PaperView.jsx, MATH-21, 2026-10-05): the menu keeps library items only, a pick
// writes `@[Name](lib:<id>)` into the note, the menu's keys come before the note's, and a note left with text in it is
// shown as text once there is somewhere for its links to go. There is no pdf here: the viewer and its note's field are
// stand-ins (pdf.js and rough.js are not loaded).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');

function load() {
  globalThis.document = { baseURI: 'file:///app/index.html' }; // PaperView finds pdf.js's worker beside index.html as it loads
  const filename = path.join(__dirname, '__PaperView-notes-unit.cjs');
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

// The workspace's @ menu for "tut" (model/rail.js mentionRows): verbs, the open page not yet saved, a workspace, items.
const ROWS = [
  { kind: 'verb', verb: 'bart', key: 'verb:bart', name: 'Bart' },
  { kind: 'verb', verb: 'note', key: 'verb:note', name: 'Note' },
  { kind: 'fresh', key: 'page:https://x.y', name: 'A page', input: 'https://x.y' },
  { kind: 'workspace', key: 'ws:w1', id: 'w1', name: 'Tutoring', above: [] },
  { kind: 'item', key: 'r1', row: { id: 'r1', name: 'TutorTrace' }, name: 'TutorTrace' },
  { kind: 'item', key: 'r2', row: { id: 'r2', name: 'Tutor notes' }, name: 'Tutor notes' },
  { kind: 'item', key: 'bad', row: null, name: 'No row' },
];

function field(value) {
  return {
    value, selectionStart: value.length, selectionEnd: value.length, style: {}, scrollHeight: 21, dataset: { mark: 'm1' }, isConnected: true, blurred: 0,
    getBoundingClientRect: () => ({ left: 10, top: 20, bottom: 41, right: 110 }),
    focus() { globalThis.document.activeElement = this; },
    blur() { this.blurred += 1; },
    setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; },
    setRangeText(text, a, b) { this.value = this.value.slice(0, a) + text + this.value.slice(b); this.selectionStart = this.selectionEnd = a + text.length; },
  };
}

/** A viewer with one free note on page 2 holding `typed`, its field focused, and the props given. */
function viewer(typed, props = {}) {
  const queries = [], drawn = [], frames = [];
  const all = { mentionItems: (q) => { queries.push(q); return ROWS; }, onOpenMention: () => {}, ...props };
  for (const key of Object.keys(all)) if (all[key] === undefined) delete all[key];
  const view = new PaperView(all);
  view.props = all;
  view.setState = (patch) => Object.assign(view.state, typeof patch === 'function' ? patch(view.state) : patch);
  const m = { id: 'm1', rects: [], side: null, y: 0.1, note: typed, text: '', pos: { x: 0.1, y: 0.1 } };
  view.marks = { 2: [m] };
  const ta = field(typed);
  view.find1 = (sel) => (sel === 'textarea[data-mark="m1"]' ? ta : null);
  view.renderMarks = (page) => drawn.push(page);
  let saves = 0;
  view.scheduleSave = () => { saves += 1; };
  globalThis.document = { activeElement: ta };
  globalThis.requestAnimationFrame = (fn) => frames.push(fn);
  return { view, m, ta, queries, drawn, frames, saves: () => saves };
}
const key = (k, more = {}) => ({ key: k, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...more });

test.afterEach(() => { delete globalThis.document; delete globalThis.requestAnimationFrame; });

test('@ in a note opens the menu at the caret, with library items only', () => {
  const { view, m, ta, queries } = viewer('see @Tut');
  view.noteMention(ta, m, 2);
  const open = view.state.mention;
  assert.deepEqual({ ...open, anchor: undefined }, { markId: 'm1', page: 2, query: 'Tut', start: 4, anchor: undefined });
  assert.ok(open.anchor && open.anchor.left === 10, 'hung from the field (its corner, when the caret cannot be measured)');
  assert.deepEqual(view.mentionList().map((r) => r.key), ['r1', 'r2'], 'no verbs, page, workspace, or row without an id');
  assert.equal(queries.at(-1), 'tut', 'asked as the document asks: lower case');
  ta.value = 'see @Tut x'; ta.selectionStart = ta.selectionEnd = ta.value.length;
  view.noteMention(ta, m, 2);
  assert.equal(view.state.mention, null, 'a space ends it');
});

test('without mentionItems a note has no menu', () => {
  const { view, m, ta } = viewer('see @tut', { mentionItems: undefined });
  view.noteMention(ta, m, 2);
  assert.equal(view.state.mention, null);
  assert.deepEqual(view.mentionList(), []);
});

test('↑ ↓ move through the menu, Enter picks: the token and a space go in, the note is saved and keeps the keyboard', () => {
  const { view, m, ta, saves } = viewer('see @tut');
  view.noteMention(ta, m, 2);
  for (const k of ['ArrowDown', 'ArrowDown', 'ArrowUp']) { const e = key(k); view.noteKey(e, ta, m); assert.ok(e.prevented && e.stopped, k); }
  assert.equal(view.state.mentionIdx, 1, 'down past the end wraps to the top; up from the top to the end');
  const enter = key('Enter');
  view.noteKey(enter, ta, m);
  assert.ok(enter.prevented);
  assert.equal(ta.value, 'see @[Tutor notes](lib:r2) ');
  assert.equal(m.note, ta.value, 'the mark holds what the field holds');
  assert.equal(ta.selectionStart, ta.value.length, 'the caret after the space');
  assert.equal(saves(), 1);
  assert.equal(view.state.mention, null);
  assert.equal(ta.blurred, 0, 'still typing in the note');
  assert.equal(globalThis.document.activeElement, ta);
});

test('a pick in the middle of a note replaces just the @word, stepping over the space after it; Tab picks too', () => {
  const { view, m, ta } = viewer('see @tut and more');
  ta.selectionStart = ta.selectionEnd = 'see @tut'.length;
  view.noteMention(ta, m, 2);
  view.noteKey(key('Tab'), ta, m);
  assert.equal(ta.value, 'see @[TutorTrace](lib:r1) and more');
  assert.equal(ta.selectionStart, 'see @[TutorTrace](lib:r1) '.length);
  assert.equal(m.note, ta.value);
});

test('a row clicked is picked the same way; nothing is added to the workspace', () => {
  const added = [];
  const { view, m, ta } = viewer('@tu', { onMentionPicked: (r) => added.push(r) });
  view.noteMention(ta, m, 2);
  view.pickMention(view.mentionList()[0]);
  assert.equal(m.note, '@[TutorTrace](lib:r1) ');
  assert.deepEqual(added, []);
});

test('Escape closes the menu alone; with no menu it leaves the note', () => {
  const { view, m, ta } = viewer('see @tut');
  view.noteMention(ta, m, 2);
  const esc = key('Escape');
  view.noteKey(esc, ta, m);
  assert.ok(esc.prevented);
  assert.equal(view.state.mention, null);
  assert.equal(ta.blurred, 0);
  view.noteKey(key('Escape'), ta, m);
  assert.equal(ta.blurred, 1);
  const enter = key('Enter');
  view.noteKey(enter, ta, m);
  assert.equal(enter.prevented, false, 'with no menu Enter is a line break, as before');
});

test('a note left with text in it is shown as text a frame later; one taken out to be drawn again is not left', () => {
  const { view, m, ta, drawn, frames } = viewer('see @[TutorTrace](lib:r1) ');
  view.editing = 'm1';
  view.redrawing = 1;
  view.leaveNote(ta, m, 2);
  assert.equal(view.editing, 'm1', 'a redraw: still being typed in');
  view.redrawing = 0;
  view.leaveNote(ta, m, 2);
  assert.equal(view.editing, 'm1', 'the app went to the background: the field keeps the keyboard when it comes back');
  globalThis.document.activeElement = null;
  view.leaveNote(ta, m, 2);
  assert.equal(view.editing, null);
  assert.deepEqual(drawn, []);
  frames.forEach((fn) => fn());
  assert.deepEqual(drawn, [2]);
  assert.deepEqual(view.marks[2], [m], 'kept');
});

test('a note left empty goes, as before', () => {
  const { view, m, ta, drawn, saves } = viewer('');
  view.editing = 'm1';
  globalThis.document.activeElement = null;
  view.leaveNote(ta, m, 2);
  assert.deepEqual(view.marks[2], []);
  assert.deepEqual(drawn, [2]);
  assert.equal(saves(), 1);
  assert.equal(view.editing, null);
});

test('the library\'s names for the mentioned items: now, gone (null), or unknown with no library', () => {
  const library = [{ id: 'r1', name: 'TutorTrace v2' }, { id: 'zz', name: 'Other' }];
  const { view, m } = viewer('see @[TutorTrace](lib:r1) and @[Gone](lib:r9)', { library });
  assert.equal(view.libName('r1'), 'TutorTrace v2');
  assert.equal(view.libName('r9'), null);
  const before = view.libKey();
  view.props = { ...view.props, library: [{ id: 'r1', name: 'TutorTrace v3' }] };
  assert.notEqual(view.libKey(), before, 'a rename changes what the notes are drawn with');
  view.props = { ...view.props, library: [{ id: 'r1', name: 'TutorTrace v3' }, { id: 'new', name: 'Unmentioned' }] };
  const same = view.libKey();
  view.props = { ...view.props, library: [{ id: 'r1', name: 'TutorTrace v3' }, { id: 'new', name: 'Renamed, unmentioned' }] };
  assert.equal(view.libKey(), same, 'an item no note mentions does not draw the notes again');
  view.props = { ...view.props, library: undefined };
  assert.equal(view.libName('r1'), undefined, 'no library: the name it was mentioned by');
  assert.ok(m);
});

test('notes are shown as text only when a mention has somewhere to go', () => {
  assert.equal(viewer('x').view.showsNotes(), true);
  assert.equal(viewer('x', { onOpenMention: undefined }).view.showsNotes(), false);
});
