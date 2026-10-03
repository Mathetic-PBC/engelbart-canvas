'use strict';

// A drag across lines in the workspace editor (src/renderer/workspace/DocEditor.jsx) keeps its highlight (2026-10-02).
// Chromium sends the click that ends a drag to what holds both ends: from one line to another that is the editor itself,
// and released past the editor, the page around it. Both clicks used to put the caret at the end of the last line.
// Now only a press there with nothing selected does. There is no document here: the editor's elements are stand-ins.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');

function load(file) {
  const filename = path.join(__dirname, `__${path.basename(file, '.jsx')}-click-unit.cjs`);
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace', file)], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty' } });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  compiled._compile(bundled.outputFiles[0].text, filename);
  return compiled.exports;
}

const DocEditor = load('DocEditor.jsx').default;
const TEXT = 'First line\nSecond line\nThird line';

/** An editor as mounted, with the editor, a line in it and the page around it as stand-ins, and a selection that is or is not collapsed. */
function mounted(text = TEXT) {
  const changes = [];
  const editor = new DocEditor({ docKey: 'k', text, onChange: (next) => changes.push(next) });
  const root = { closest: (sel) => (sel === '[data-editor]' ? root : null), matches: () => false, focus() {}, contains: () => true };
  const line = { closest: (sel) => (sel === '[data-editor]' ? root : null), matches: () => false };
  const page = { closest: () => null, matches: () => false };
  editor.edRef = { current: root };
  editor.scrollRef = { current: page };
  editor.setState = (patch) => Object.assign(editor.state, typeof patch === 'function' ? patch(editor.state) : patch);
  editor.syncEditor = () => {};
  editor.maybeRestoreView = () => {};
  const selection = { isCollapsed: true, rangeCount: 0 };
  globalThis.getSelection = () => selection;
  globalThis.document = { addEventListener() {}, removeEventListener() {}, hasFocus: () => true };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  editor.componentDidMount();
  const on = editor.docListeners;
  const press = (target) => on.mousedown({ target, button: 0, preventDefault() {} });
  const click = (target) => { const e = { target, preventDefault() {} }; on.click(e); if (target === page) editor.docClick({ ...e, currentTarget: page }); };
  return { editor, root, line, page, selection, press, click, changes };
}

test.afterEach(() => { delete globalThis.getSelection; delete globalThis.document; delete globalThis.window; });

test('a drag from one line to another ends in a click on the editor: the selection stays and the caret is not moved', () => {
  const { editor, root, line, selection, press, click } = mounted();
  press(line);
  selection.isCollapsed = false; // the drag selected across lines
  click(root);
  assert.equal(editor.caret, null, 'no caret is put anywhere');
  assert.equal(editor.state.activeLine, null, 'no line is opened');
  assert.equal(editor.wantFocus, false);
});

test('a drag released past the editor ends in a click on the page around it: the caret is not moved either', () => {
  const { editor, line, page, selection, press, click } = mounted();
  press(line);
  selection.isCollapsed = false;
  click(page);
  assert.equal(editor.caret, null);
  assert.equal(editor.state.activeLine, null);
});

test('a press on the empty space with something still selected (dragged back up into the text) leaves it selected', () => {
  for (const where of ['root', 'page']) {
    const m = mounted();
    m.press(m[where]);
    m.selection.isCollapsed = false;
    m.click(m[where]);
    assert.equal(m.editor.caret, null, where);
    assert.equal(m.editor.state.activeLine, null, where);
  }
});

test('a press on a line that ends on the editor with nothing selected does not move the caret to the end', () => {
  const { editor, root, line, press, click } = mounted();
  press(line);
  click(root);
  assert.equal(editor.caret, null);
  assert.equal(editor.state.activeLine, null);
});

test('a click on the empty space below the last line still puts the caret at the end of it', () => {
  for (const where of ['root', 'page']) {
    const m = mounted();
    m.press(m[where]);
    m.click(m[where]);
    assert.deepEqual(m.editor.caret, { line: 2, offset: 'Third line'.length }, where);
    assert.equal(m.editor.state.activeLine, 2, where);
  }
});

test('a click below a document that ends on a card still adds a line under it', () => {
  const m = mounted('First line\n@bart what is this\nbart> An answer');
  m.press(m.root);
  m.click(m.root);
  assert.deepEqual(m.changes, ['First line\n@bart what is this\nbart> An answer\n']);
  assert.deepEqual(m.editor.caret, { line: 3, offset: 0 });
});
