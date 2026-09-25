'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');

// Exercise the real editor's shortcut/history methods without mounting a browser or touching user documents.
const filename = path.join(__dirname, '__doc-editor-unit.cjs');
const built = buildSync({
  entryPoints: [path.join(__dirname, '../src/renderer/workspace/DocEditor.jsx')],
  bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false,
  external: ['react', 'react-dom'], loader: { '.png': 'dataurl', '.svg': 'dataurl', '.css': 'empty' },
});
const compiled = new Module(filename, module);
compiled.paths = module.paths;
compiled._compile(built.outputFiles[0].text, filename);
const DocEditor = compiled.exports.default;

function editor(text, selection) {
  const instance = new DocEditor({ docKey: 'test', text, onChange: (next) => { instance.props = { ...instance.props, text: next }; } });
  instance.caretInfo = () => selection;
  instance.setState = (change) => { instance.state = { ...instance.state, ...(typeof change === 'function' ? change(instance.state) : change) }; };
  return instance;
}
const range = (from, to, offset = 1) => ({ anchor: { line: from, offset: 0 }, focus: { line: to, offset } });

test('reply borders start 12px outside the user box without changing the text inset', () => {
  for (const answer of ['bart> First line\nbart> Second line', 'bart~> pending', 'bart> ```json\nbart> {}\nbart> ```']) {
    const ed = editor(`@bart Check this\n${answer}`);
    const html = ed.editorHtml();
    const question = html.match(/data-line="0"[^>]*style="([^"]*)"/)[1];
    const reply = html.match(/data-line="1"[^>]*style="([^"]*)"/)[1];
    assert.match(question, /background:#f5f5f5;/);
    assert.match(reply, /^margin-top:12px;margin-left:16px;padding:16px 0 \d+px 16px;border-left:2px solid #e2e2e2;/);
    if (answer.startsWith('bart> First')) {
      const continuation = html.match(/data-line="2"[^>]*style="([^"]*)"/)[1];
      assert.match(continuation, /^margin-top:0px;/, 'the rule remains continuous within a reply');
    }
  }
});

function shortcut(instance, options = {}) {
  let prevented = false;
  instance.editorKey({ key: 'J', metaKey: true, shiftKey: true, preventDefault: () => { prevented = true; }, ...options });
  return prevented;
}

test('Cmd+Shift+J is one undoable JSON edit and keeps the whole code body selected', () => {
  const text = 'Before\n{\n  "ok": true\n}\nAfter', ed = editor(text, range(1, 3));
  ed.state.statuses = { test: { 0: 'done', 4: 'done' } };
  assert.equal(shortcut(ed), true);
  const result = 'Before\n```json\n{\n  "ok": true\n}\n```\nAfter';
  assert.equal(ed.props.text, result);
  assert.equal(ed.history.length, 1);
  assert.deepEqual(ed.caret, { line: 2, sel: [0, 1], endLine: 4 });
  assert.deepEqual(ed.state.statuses.test, { 0: 'done', 6: 'done' });
  ed.undo(); assert.equal(ed.props.text, text);
  ed.redo(); assert.equal(ed.props.text, result);
});

test('Ctrl+Shift+J works too; ordinary typing, composition and held keys do not format', () => {
  const text = '{"ok":true}', ed = editor(text, range(0, 0, text.length));
  assert.equal(shortcut(ed, { metaKey: false, ctrlKey: true }), true);
  assert.match(ed.props.text, /^```json\n/);
  for (const options of [{ shiftKey: false }, { metaKey: false }, { altKey: true }, { isComposing: true }, { repeat: true }]) {
    const untouched = editor(text, range(0, 0, text.length));
    shortcut(untouched, options);
    assert.equal(untouched.props.text, text);
  }
  const composing = editor(text, range(0, 0)); composing.composing = true; shortcut(composing);
  assert.equal(composing.props.text, text);
});

test('formatting respects locked answers, attribution lines and running task rows', () => {
  for (const text of ['bart+> folded', 'bart> *Model · 1 s*', '> legacy reply', '@bart question\nbart~> pending']) {
    const ed = editor(text, range(0, 0)); shortcut(ed);
    assert.equal(ed.props.text, text); assert.equal(ed.history.length, 0);
  }
  const busy = editor('- [ ] working', range(0, 0)); busy.state.statuses = { test: { 0: 'building' } }; shortcut(busy);
  assert.equal(busy.props.text, '- [ ] working');
});

test('select-all on the editor root formats all lines and selection outside the editor is ignored', (t) => {
  const prior = global.getSelection;
  t.after(() => { if (prior === undefined) delete global.getSelection; else global.getSelection = prior; });
  const nodes = [0, 1, 2].map((line) => ({ dataset: { line: String(line) } }));
  const root = { contains: (node) => node === root, querySelectorAll: () => nodes };
  const selected = { startContainer: root, endContainer: root, intersectsNode: () => true };
  global.getSelection = () => ({ rangeCount: 1, isCollapsed: false, getRangeAt: () => selected });
  const ed = editor('{\n  "ok": true\n}', null); ed.editorEl = () => root;
  shortcut(ed);
  assert.equal(ed.props.text, '```json\n{\n  "ok": true\n}\n```\n');
  const oneRootEnd = editor('{\n  "ok": true\n}', range(0, 0)); oneRootEnd.editorEl = () => root;
  shortcut(oneRootEnd);
  assert.equal(oneRootEnd.props.text, ed.props.text, 'a root endpoint cannot fall back to formatting only the anchor line');
  const outside = editor('untouched', null); outside.editorEl = () => root; selected.endContainer = {};
  shortcut(outside); assert.equal(outside.props.text, 'untouched');
  const partial = editor('untouched', range(0, 0)); partial.editorEl = () => root;
  shortcut(partial); assert.equal(partial.props.text, 'untouched', 'a selection beginning inside but ending outside is ignored');
});

test('restoring a JSON selection uses the last selected line, not an offset on the first', () => {
  const ed = editor('', range(0, 0));
  ed.caret = { line: 2, sel: [0, 5], endLine: 6 };
  let applied;
  ed.setSelection = (...args) => { applied = args; };
  ed.applyCaret();
  assert.deepEqual(applied, [2, 0, 5, 6]);
  assert.equal(ed.caret, null);
});
