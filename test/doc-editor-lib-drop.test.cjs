'use strict';

// A row of the sidebar dragged onto the document (2026-10-17; src/renderer/model/mention.js, DocEditor.jsx libDrop): it is
// written as the @ menu writes it when picked (a picture too, by its id: 2026-10-17), where it was let go, and a drop of rows never
// reaches props.onDropItems (which would add the row to the library again). As in doc-editor-drop, the editor, its lines
// and the drop are stand-ins.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');

function load(file) {
  const filename = path.join(__dirname, `__${path.basename(file).replace(/\.\w+$/, '')}-lib-drop-unit.cjs`);
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer', file)], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty' } });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  compiled._compile(bundled.outputFiles[0].text, filename);
  return compiled.exports;
}

const DocEditor = load('workspace/DocEditor.jsx').default;
const { LIB_DRAG_TYPE, writeLibDrag, readLibDrag, mentionToken, menuItem } = load('model/mention.js');

const PDF = { id: 'pdf-1', name: 'Attention Is All You Need', type: 'pdf', path: '/Users/h/Papers/attention.pdf' };
const WEB = { id: 'web-1', name: 'How transformers read', type: 'website', url: 'https://example.org/transformers' };
const NOTE = { id: 'note-1', name: 'Reading notes', type: 'note', project_id: 'p' };
const FOLDER = { id: 'dir-1', name: 'data', type: 'folder', folder_path: '/Users/h/data' };
const IMAGE = { id: 'img-1', name: 'figure.png', type: 'image', path: '/Users/h/Desktop/figure.png' };
const LIBRARY = [PDF, WEB, NOTE, FOLDER, IMAGE];

const IN_LINE = (line) => ({ nodeType: 3, line });

function mounted(lines, { readOnly = false, mentionable = LIBRARY, under = 0 } = {}) {
  const dropped = [], picked = [], asked = [];
  const props = {
    docKey: 'k', text: lines.join('\n'), readOnly, mentionable,
    onChange: (next) => { props.text = next; },
    onPasteImage: async () => ({ id: IMAGE.id }),
    onDropItems: async (items) => { dropped.push(items); },
    onMentionPicked: (item) => { picked.push(item); },
    onAsk: (...args) => { asked.push(args); },
    pathForFile: () => null,
  };
  const editor = new DocEditor(props);
  const root = { closest: (sel) => (sel === '[data-editor]' ? root : null), matches: () => false, focus() {}, blur() {}, contains: () => false, querySelector: () => null };
  editor.props = props;
  editor.edRef = { current: root };
  editor.scrollRef = { current: { closest: () => null, contains: () => false } };
  editor.setState = (patch) => Object.assign(editor.state, typeof patch === 'function' ? patch(editor.state) : patch);
  editor.syncEditor = () => {};
  editor.maybeRestoreView = () => {};
  globalThis.getSelection = () => ({ isCollapsed: true, rangeCount: 0 });
  const point = { line: under };
  globalThis.document = { addEventListener() {}, removeEventListener() {}, hasFocus: () => true, activeElement: null, caretPositionFromPoint: (x, y) => ({ offsetNode: IN_LINE(point.line), offset: y }) };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  editor.componentDidMount();
  editor.caretAt = (node, offset) => (node && node.line != null ? { line: node.line, offset } : null);
  editor.caretInfo = () => null;
  // Rows of the sidebar let go at (line, offset): their drag is what Rail writes (writeLibDrag). `field`: a follow-up's
  // field (or, with `other`, another field of the editor's) to let them go on.
  const drop = (rows, { line = point.line, offset = 0, field = null } = {}) => {
    point.line = line;
    const data = {};
    const dataTransfer = { setData: (type, value) => { data[type] = value; }, getData: (type) => data[type] || '', files: [] };
    writeLibDrag(dataTransfer, rows);
    dataTransfer.types = Object.keys(data);
    const target = field || { closest: (sel) => (sel === '[data-editor]' ? root : null), matches: () => false };
    const event = { target, clientX: 10, clientY: offset, dataTransfer, prevented: false, preventDefault() { this.prevented = true; } };
    const over = { ...event, dataTransfer: { ...dataTransfer }, preventDefault() { event.dragoverPrevented = true; } };
    editor.docListeners.dragover(over);
    event.dropEffect = over.dataTransfer.dropEffect;
    editor.docListeners.drop(event);
    return event;
  };
  // What the @ menu writes when `row` is picked from it at (line, offset), on the same document.
  const pick = (row, { line, offset }) => {
    editor.writeText(line, editor.lines()[line].slice(0, offset) + '@', { line, offset: offset + 1 });
    editor.state.mention = { i: line, start: offset, caret: offset + 1 };
    editor.pickMention(menuItem(row));
  };
  return { editor, props, dropped, picked, asked, drop, pick };
}

test.afterEach(() => { delete globalThis.getSelection; delete globalThis.document; delete globalThis.window; });

test('a pdf, a web page, a note, a folder and a picture dropped read as the @ menu writes them', () => {
  for (const row of [PDF, WEB, NOTE, FOLDER, IMAGE]) {
    const menu = mounted(['Read ', '']);
    menu.pick(row, { line: 0, offset: 5 });
    const dropped = mounted(['Read ', '']);
    const event = dropped.drop([row], { line: 0, offset: 5 });
    assert.equal(event.prevented, true);
    assert.equal(event.dragoverPrevented, true, 'taken, not sent flying back');
    assert.equal(event.dropEffect, 'copy');
    assert.equal(dropped.props.text, menu.props.text, `${row.type}: the same text as the @ menu`);
    assert.equal(dropped.props.text.split('\n')[0], `Read ${mentionToken(menuItem(row))}`);
    assert.deepEqual(dropped.picked.map((item) => item.row.id), [row.id], 'linked to the workspace, as a pick is');
    assert.deepEqual(dropped.dropped, [], 'never handed to onDropItems');
  }
  const web = mounted(['']);
  web.drop([WEB]);
  assert.equal(web.props.text, '@[How transformers read](lib:web-1)', 'a page by its title and id, never its address');
});

test('a picture is mentioned by its id under its name, as the @ menu writes it', () => {
  const m = mounted(['see ', '']);
  m.drop([IMAGE], { line: 0, offset: 4 });
  assert.equal(m.props.text, 'see @[figure.png](lib:img-1)\n');
  assert.deepEqual(m.picked.map((item) => item.row.id), ['img-1']);
  assert.deepEqual(m.dropped, []);
});

test('a drop of rows never reaches onDropItems, wherever it lands', () => {
  const m = mounted(['a line', '@bart why?', 'bart> because', 'bart> *Sonnet · high · 3 s*', '']);
  m.drop([PDF], { line: 0, offset: 2 });
  m.drop([NOTE], { line: 2, offset: 0 });
  m.drop([IMAGE], { line: 4, offset: 0 });
  assert.deepEqual(m.dropped, []);

  const archived = mounted(['a'], { readOnly: true });
  const event = archived.drop([PDF]);
  assert.equal(event.dragoverPrevented, undefined, 'a read-only document refuses it');
  assert.equal(archived.props.text, 'a');
  assert.deepEqual([archived.dropped.length, archived.picked.length], [0, 0]);
});

test('on an @bart line it is written into the question, and nothing is asked', () => {
  const m = mounted(['@bart what does say?', '']);
  m.drop([PDF], { line: 0, offset: 10 });
  assert.equal(m.props.text.split('\n')[0], '@bart what @[Attention Is All You Need] does say?');
  assert.deepEqual(m.asked, []);

  const asked = mounted(['@bart why?', 'bart> because', 'bart> *Sonnet · high · 3 s*', '', 'after']);
  asked.drop([WEB], { line: 0, offset: 3 });
  assert.deepEqual(asked.props.text.split('\n'), ['@bart why?', 'bart> because', 'bart> *Sonnet · high · 3 s*', '@[How transformers read](lib:web-1)', '', 'after'], 'an asked question is not typed in: under its conversation');
});

test("in a follow-up's field it goes in at the caret and is not sent; another field refuses it", () => {
  const m = mounted(['@bart why?', 'bart> because', 'bart> *Sonnet · high · 3 s*', '']);
  const typed = [];
  m.editor.followInput = (input) => { typed.push(input.value); };
  const field = {
    value: 'compare with', selectionStart: 12, selectionEnd: 12, dataset: { followInput: '0' },
    matches: (sel) => sel.split(', ').includes('[data-follow-input]'),
    closest: (sel) => (sel === '[data-editor]' ? m.editor.edRef.current : null),
    focus() { globalThis.document.activeElement = field; },
    setRangeText(text, a, b) { this.value = this.value.slice(0, a) + text + this.value.slice(b); this.selectionStart = this.selectionEnd = a + text.length; },
  };
  const event = m.drop([NOTE, PDF], { field });
  assert.equal(event.prevented, true);
  assert.equal(field.value, 'compare with @[Reading notes] @[Attention Is All You Need]', 'one mention per row');
  assert.deepEqual(typed, [field.value]);
  assert.deepEqual(m.asked, [], 'not sent');
  assert.equal(m.props.text, '@bart why?\nbart> because\nbart> *Sonnet · high · 3 s*\n', 'the document is untouched');
  assert.deepEqual(m.dropped, []);

  const build = { ...field, value: 'x', matches: (sel) => sel.split(', ').includes('[data-build-input]') };
  const refused = m.drop([NOTE], { field: build });
  assert.equal(refused.dragoverPrevented, undefined);
  assert.equal(build.value, 'x');
});

test('the drag carries the rows and their mentions as plain text', () => {
  const data = {};
  const dataTransfer = { setData: (type, value) => { data[type] = value; }, getData: (type) => data[type] || '' };
  writeLibDrag(dataTransfer, [PDF, WEB]);
  assert.equal(dataTransfer.effectAllowed, 'copy');
  assert.equal(data['text/plain'], '@[Attention Is All You Need] @[How transformers read](lib:web-1)');
  assert.deepEqual(readLibDrag(dataTransfer).map((row) => row.id), ['pdf-1', 'web-1']);
  assert.ok(LIB_DRAG_TYPE in data);
  assert.deepEqual(readLibDrag({ getData: () => 'not json' }), []);
});
