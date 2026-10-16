'use strict';

// Pasting into a quote (src/renderer/workspace/DocEditor.jsx editorPaste, 2026-10-07). A line that starts with `> ` is a
// quote; text of several lines pasted into it used to put only its first line there, and the rest came out below as
// plain lines. Now every pasted line is a quote line of its own. A `>` typed with no space before the paste makes the
// same quote (2026-10-16), and a quote is a line the person edits like any other: it is not locked, its `> ` shows with
// the caret on it, and Backspace at the start of its text makes it plain. There is no document here: the editor and the
// selection are stand-ins, as in doc-editor-edit.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');

function load(file) {
  const filename = path.join(__dirname, `__${path.basename(file, '.jsx')}-quote-paste-unit.cjs`);
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace', file)], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty' } });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  compiled._compile(bundled.outputFiles[0].text, filename);
  return compiled.exports;
}

const DocEditor = load('DocEditor.jsx').default;

/** An editor on `lines`, the caret on line `at` from offset `a` to `b` (the line's source, `> ` included). */
function mounted(lines, at, a, b = a) {
  const changes = [];
  const props = { docKey: 'k', text: lines.join('\n'), models: null, readOnly: false, onChange: (next) => { changes.push(next); props.text = next; } };
  const editor = new DocEditor(props);
  editor.props = props;
  editor.edRef = { current: { closest: () => null, matches: () => false, focus() {}, blur() {}, contains: () => false, querySelector: () => null } };
  editor.scrollRef = { current: { closest: () => null } };
  editor.setState = (patch) => Object.assign(editor.state, typeof patch === 'function' ? patch(editor.state) : patch);
  editor.forceUpdate = () => {};
  editor.syncEditor = () => {};
  editor.maybeRestoreView = () => {};
  globalThis.getSelection = () => ({ isCollapsed: true, rangeCount: 0 });
  globalThis.document = { addEventListener() {}, removeEventListener() {}, hasFocus: () => true, activeElement: null };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  editor.componentDidMount();
  editor.caretInfo = () => ({ anchor: { line: at, offset: a }, focus: { line: at, offset: b } });
  const paste = (text) => editor.editorPaste({ clipboardData: { files: [], getData: (type) => (type === 'text/plain' ? text : '') }, preventDefault() {} });
  const key = (name) => editor.editorKey({ key: name, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, preventDefault() {} });
  return { editor, paste, key, lines: () => editor.lines() };
}

test.afterEach(() => { delete globalThis.getSelection; delete globalThis.document; delete globalThis.window; });

test('several lines pasted after a typed `> ` are all in the quote', () => {
  const m = mounted(['Notes', '> ', 'After'], 1, 2);
  m.paste('first\nsecond\nthird');
  assert.deepEqual(m.lines(), ['Notes', '> first', '> second', '> third', 'After']);
  assert.deepEqual(m.editor.caret, { line: 3, offset: '> third'.length }, 'the caret ends the paste, after the `> `');
  assert.equal(m.editor.state.activeLine, 3);
});

test('a blank line inside the paste keeps the block whole; blank lines at its ends make no empty quote lines', () => {
  const m = mounted(['> '], 0, 2);
  m.paste('\n\none\n\ntwo\n\n');
  assert.deepEqual(m.lines(), ['> one', '>', '> two']);
  assert.deepEqual(m.editor.caret, { line: 2, offset: '> two'.length });
});

test('what followed the caret stays at the end of the last line of the quote, and carriage returns do not matter', () => {
  const m = mounted(['> keep this'], 0, 2);
  m.paste('a\r\nb');
  assert.deepEqual(m.lines(), ['> a', '> bkeep this']);
  assert.deepEqual(m.editor.caret, { line: 1, offset: '> b'.length }, 'the caret between what was pasted and what was there');
});

test('a selection inside the quote is replaced; one starting in its `> ` leaves the prefix alone', () => {
  const inside = mounted(['> one two three'], 0, 6, 9);
  inside.paste('x\ny');
  assert.deepEqual(inside.lines(), ['> one x', '> y three']);
  const prefix = mounted(['> kept'], 0, 0);
  prefix.paste('x\ny');
  assert.deepEqual(prefix.lines(), ['> x', '> ykept'], 'nothing goes in front of the `> `');
});

test('a single line pasted into a quote is just text in it, and pasting outside a quote is as it was', () => {
  const one = mounted(['> '], 0, 2);
  one.paste('only line\n');
  assert.deepEqual(one.lines(), ['> only line']);
  const plain = mounted(['para'], 0, 4);
  plain.paste('a\nb');
  assert.deepEqual(plain.lines(), ['paraa', 'b'], 'a paragraph takes lines as lines');
  const bullet = mounted(['- item'], 0, 6);
  bullet.paste('a\nb');
  assert.deepEqual(bullet.lines(), ['- itema', 'b'], 'a bullet is untouched too: the lines after the first are lines');
});

test('`>` with no space, then a paste: the quote is `> ` and what was pasted, one line or several', () => {
  const one = mounted(['Notes', '>'], 1, 1);
  one.paste('pasted words');
  assert.deepEqual(one.lines(), ['Notes', '> pasted words']);
  assert.deepEqual(one.editor.caret, { line: 1, offset: '> pasted words'.length });
  const several = mounted(['>'], 0, 1);
  several.paste('first\nsecond');
  assert.deepEqual(several.lines(), ['> first', '> second'], 'every line quoted, each with its space');
  const inside = mounted(['>kept'], 0, 1);
  inside.paste('x');
  assert.deepEqual(inside.lines(), ['> xkept'], 'a quote typed tight gets its space when something is pasted into it');
});

test('a quote is a line the person edits: not locked, drawn editable, its `> ` shown faint with the caret on it', () => {
  const m = mounted(['Notes', '> a quote', 'After'], 1, 4);
  const ls = m.lines(), p = { type: 'quote', text: 'a quote' };
  assert.equal(m.editor.lockedAt(ls, 1), false);
  assert.equal(m.editor.lockedAt(['>'], 0), false, 'a `>` just typed is not locked either');
  assert.equal(m.editor.endsOnCard(['Notes', '> a quote']), false, 'a document may end on a quote: no line is added under it');
  const drawn = m.editor.lineHtml(1, ls[1], p, false, false, undefined, false);
  assert.doesNotMatch(drawn, /contenteditable="false"|data-readonly/);
  assert.match(drawn, />a quote</);
  const active = m.editor.lineHtml(1, ls[1], p, true, false, undefined, false);
  assert.match(active, /data-src="&gt; " data-open="1" style="color:#b5b5b5">&gt; <\/span>/, 'the `> ` is the line\'s own first characters');
});

test('Backspace at the start of a quote\'s text makes it a plain line; elsewhere in it, it deletes as usual', () => {
  const m = mounted(['Notes', '> a quote'], 1, 2);
  m.key('Backspace');
  assert.deepEqual(m.lines(), ['Notes', 'a quote']);
  assert.deepEqual(m.editor.caret, { line: 1, offset: 0 });
  const tight = mounted(['>tight'], 0, 1);
  tight.key('Backspace');
  assert.deepEqual(tight.lines(), ['tight'], 'a quote typed without its space, the same');
  const mid = mounted(['> a quote'], 0, 5);
  mid.key('Backspace');
  assert.deepEqual(mid.lines(), ['> a quote'], 'inside the text the key is the browser\'s (nothing changed by the handler)');
});
