'use strict';

// A drop on the document (MATH-19, 2026-10-05; src/renderer/workspace/DocEditor.jsx editorDrop): a picture goes in where it
// was let go, as a pasted one; anything else goes to props.onDropItems (the workspace adds it to the library and links
// it); a drop into one of the editor's fields is refused as before. There is no document here: the editor, its rows and
// the drop are stand-ins, as in doc-editor-edit.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');

function load(file) {
  const filename = path.join(__dirname, `__${path.basename(file, '.jsx')}-drop-unit.cjs`);
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace', file)], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty' } });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  compiled._compile(bundled.outputFiles[0].text, filename);
  return compiled.exports;
}

const DocEditor = load('DocEditor.jsx').default;

const paths = new Map(); // what Finder said each file is (preload's pathForFile)
const file = (name, type, where = null) => { const made = new File(['bytes'], name, { type }); if (where) paths.set(made, where); return made; };
const IN_LINE = { nodeType: 3, line: 1 }; // the text node under the pointer: in line 1
const OFF_LINES = { nodeType: 1 }; // somewhere in the editor that is not a line's text (a card's margin)

function mounted(lines, { readOnly = false, under = IN_LINE, caret = null } = {}) {
  const pasted = [], dropped = [];
  const props = { docKey: 'k', text: lines.join('\n'), readOnly, onChange: (next) => { props.text = next; }, onPasteImage: async () => null, onDropItems: async (items) => { dropped.push(items); }, pathForFile: (f) => paths.get(f) || null };
  const editor = new DocEditor(props);
  const root = { closest: (sel) => (sel === '[data-editor]' ? root : null), matches: () => false, focus() {}, blur() {}, contains: () => false, querySelector: () => null };
  editor.props = props;
  editor.edRef = { current: root };
  editor.scrollRef = { current: { closest: () => null } };
  editor.setState = (patch) => Object.assign(editor.state, typeof patch === 'function' ? patch(editor.state) : patch);
  editor.syncEditor = () => {};
  editor.maybeRestoreView = () => {};
  globalThis.getSelection = () => ({ isCollapsed: true, rangeCount: 0 });
  globalThis.document = { addEventListener() {}, removeEventListener() {}, hasFocus: () => true, activeElement: null, caretPositionFromPoint: (x, y) => (x >= 0 ? { offsetNode: under, offset: y } : null) };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  editor.componentDidMount();
  editor.pasteImages = async (files, at) => { pasted.push({ files, at }); };
  editor.caretAt = (node, offset) => (node && node.line != null ? { line: node.line, offset } : null);
  editor.caretInfo = () => (caret ? { anchor: caret, focus: caret } : null);
  // A drop at (x, y) of `files` and `data`, on the document's text or, `field`, on one of its inputs.
  const drop = ({ files = [], data = {}, field = false, x = 10, y = 4 } = {}) => {
    const target = { closest: (sel) => (sel === '[data-editor]' ? root : null), matches: () => field };
    const event = { target, clientX: x, clientY: y, dataTransfer: { files, types: [...(files.length ? ['Files'] : []), ...Object.keys(data)], getData: (type) => data[type] || '' }, prevented: false, preventDefault() { this.prevented = true; } };
    editor.docListeners.drop(event);
    return event;
  };
  return { editor, pasted, dropped, drop };
}

test.afterEach(() => { delete globalThis.getSelection; delete globalThis.document; delete globalThis.window; });

test('a picture from Finder or a browser goes in where it was let go; a pdf and a link go to the workspace', async () => {
  const m = mounted(['# Notes', 'first line', '']);
  const png = file('figure.png', 'image/png', '/Users/h/Desktop/figure.png');
  const pdf = file('paper.pdf', 'application/pdf', '/Users/h/Desktop/paper.pdf');
  const loose = file('image.webp', 'image/webp');
  const event = m.drop({ files: [png, pdf, loose], y: 4 });
  assert.equal(event.prevented, true);
  assert.equal(m.pasted.length, 1);
  assert.deepEqual(m.pasted[0].files, [png, loose], "a Finder path's own File, then the browser's bytes");
  assert.deepEqual(m.pasted[0].at, { line: 1, offset: 4 }, 'the point under the pointer');
  assert.deepEqual(m.dropped, [[{ kind: 'path', path: '/Users/h/Desktop/paper.pdf' }]]);

  const link = m.drop({ data: { 'text/uri-list': 'https://example.org/post' } });
  assert.equal(link.prevented, true);
  assert.equal(m.pasted.length, 1, 'a link is not a picture to paste');
  assert.deepEqual(m.dropped[1], [{ kind: 'url', url: 'https://example.org/post' }]);
});

test('off the lines the picture goes to the caret, else to the end of the document', () => {
  const caret = mounted(['a', 'bc'], { under: OFF_LINES, caret: { line: 0, offset: 1 } });
  caret.drop({ files: [file('a.png', 'image/png')] });
  assert.deepEqual(caret.pasted[0].at, { line: 0, offset: 1 });
  const end = mounted(['a', 'bc'], { under: OFF_LINES });
  end.drop({ files: [file('a.gif', 'image/gif')], x: -1 });
  assert.deepEqual(end.pasted[0].at, { line: 1, offset: 2 });
});

test('a picture the document does not take, a read-only document and a drop into a field', () => {
  const m = mounted(['a']);
  const svg = file('drawing.svg', 'image/svg+xml', '/Users/h/drawing.svg');
  m.drop({ files: [svg] });
  assert.equal(m.pasted.length, 0);
  assert.deepEqual(m.dropped, [[{ kind: 'path', path: '/Users/h/drawing.svg' }]], 'linked as a file of the library');

  const archived = mounted(['a'], { readOnly: true });
  archived.drop({ files: [file('a.png', 'image/png')] });
  assert.equal(archived.pasted.length, 0, 'nothing goes into a read-only document');
  assert.equal(archived.dropped.length, 1);

  const field = mounted(['a']);
  const event = field.drop({ files: [file('a.png', 'image/png')], data: { 'text/uri-list': 'https://example.org' }, field: true });
  assert.equal(event.prevented, true, 'refused, as before');
  assert.deepEqual([field.pasted.length, field.dropped.length], [0, 0]);

  const text = field.drop({ data: { 'text/plain': 'words' } });
  assert.equal(text.prevented, true, 'plain text is still not dropped into the document');
  assert.deepEqual([field.pasted.length, field.dropped.length], [0, 0]);
});
