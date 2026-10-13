'use strict';

// A click in the space under a card in the workspace editor (src/renderer/workspace/DocEditor.jsx, 2026-10-13) puts the
// caret on a line there: the empty line under the card when there is one, else a new one. The space is the card's bottom
// margin (a click on the editor itself, placed by its height among the rows) or a heading's own space above its text.
// There is no document here: the editor, its rows and their places on the page are stand-ins, laid out from the text.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');

function load(file) {
  const filename = path.join(__dirname, `__${path.basename(file, '.jsx')}-gap-unit.cjs`);
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace', file)], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty' } });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  compiled._compile(bundled.outputFiles[0].text, filename);
  return compiled.exports;
}

const DocEditor = load('DocEditor.jsx').default;
const ANSWERED = ['@chat what is this', 'bart> An answer', 'bart> *Chat · 3 s*'];

/**
 * An editor as mounted, its text following its changes. Rows are laid out from the text as the page would: 30px a line,
 * a heading 44px plus the space above its text (12px right under a card, else 4px), and 8px under every card's last line.
 */
function mounted(lines, props = {}) {
  const changes = [];
  const editor = new DocEditor({ docKey: 'k', text: lines.join('\n'), onChange: (next) => { changes.push(next); editor.props = { ...editor.props, text: next }; }, ...props });
  const root = {
    closest: (sel) => (sel === '[data-editor]' ? root : null), matches: () => false, focus() {}, contains: () => true,
    querySelectorAll: (sel) => (sel === '[data-line]' ? rows() : []),
  };
  function rows() {
    const ends = editor.cardEnds(); let y = 0;
    return editor.lines().map((line, i) => {
      const heading = /^#{1,3} /.test(line), lead = heading ? (i > 0 && ends[i - 1] === i - 1 ? 12 : 4) : 0, h = heading ? 44 + lead : 30, top = y;
      y += h + (ends[i] === i ? 8 : 0);
      const row = { dataset: { line: String(i) }, getBoundingClientRect: () => ({ top, bottom: top + h, height: h }) };
      const t = { getBoundingClientRect: () => ({ top: top + lead, bottom: top + h - 4 }), matches: () => false, closest: (sel) => (sel === '[data-line]' ? row : sel === '[data-editor]' ? root : null) };
      Object.assign(row, { matches: (sel) => sel === '[data-line]', closest: (sel) => (sel === '[data-line]' ? row : sel === '[data-editor]' ? root : null), querySelector: (sel) => (sel === '.t' ? t : null), t });
      return row;
    });
  }
  editor.edRef = { current: root };
  editor.scrollRef = { current: { closest: () => null, matches: () => false } };
  editor.setState = (patch) => Object.assign(editor.state, typeof patch === 'function' ? patch(editor.state) : patch);
  editor.syncEditor = () => {};
  editor.maybeRestoreView = () => {};
  editor.applyCaret = () => {};
  const selection = { isCollapsed: true, rangeCount: 0 };
  globalThis.getSelection = () => selection;
  globalThis.document = { addEventListener() {}, removeEventListener() {}, hasFocus: () => true };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  editor.componentDidMount();
  const on = editor.docListeners;
  const row = (i) => rows()[i];
  /** A press and its click at height y on `target` (the editor's own space when none). → whether the press was kept from the browser */
  const clickAt = (y, target = root) => {
    const down = { target, button: 0, clientY: y, prevented: false, preventDefault() { down.prevented = true; } };
    on.mousedown(down);
    on.click({ target, clientY: y, preventDefault() {} });
    return down.prevented;
  };
  /** The height between row i's bottom and the next drawn row's top. */
  const under = (i) => row(i).getBoundingClientRect().bottom + 4;
  return { editor, root, row, rows, clickAt, under, selection, changes };
}

test.afterEach(() => { delete globalThis.getSelection; delete globalThis.document; delete globalThis.window; });

test('a click in the space under an answer, a heading below it, makes a line there; a second click there makes no second one', () => {
  const m = mounted([...ANSWERED, '## Heading']);
  m.clickAt(m.under(2));
  assert.deepEqual(m.changes, [[...ANSWERED, '', '## Heading'].join('\n')]);
  assert.deepEqual(m.editor.caret, { line: 3, offset: 0 });
  assert.equal(m.editor.state.activeLine, 3);
  m.editor.state.activeLine = null; m.editor.caret = null;
  m.clickAt(m.under(2));
  assert.equal(m.changes.length, 1, 'the empty line is there: no other is made');
  assert.deepEqual(m.editor.caret, { line: 3, offset: 0 });
  assert.equal(m.editor.state.activeLine, 3);
  m.editor.undo();
  assert.equal(m.editor.props.text, [...ANSWERED, '## Heading'].join('\n'), 'one undo takes the line away');
});

test('with an empty line already under the answer, the click puts the caret on it and adds nothing', () => {
  const m = mounted([...ANSWERED, '', '## Heading']);
  m.clickAt(m.under(2));
  assert.deepEqual(m.changes, []);
  assert.deepEqual(m.editor.caret, { line: 3, offset: 0 });
  assert.equal(m.editor.state.activeLine, 3);
});

test('a heading right under a card has 12px above its text, and a press there makes the line instead of opening the heading', () => {
  const m = mounted([...ANSWERED, '## Heading', 'Text', '## Later']);
  const html = (i) => m.editor.lineHtml(i, m.editor.lines()[i], m.editor.parsedOf(m.editor.lines())[i], false, false, null, false);
  assert.match(html(3), /padding:12px 0 4px/);
  assert.match(html(5), /padding:4px 0;/, 'a heading under text keeps its spacing');
  const h = m.row(3), top = h.getBoundingClientRect().top;
  const prevented = m.clickAt(top + 6, h);
  assert.equal(prevented, true, 'the browser does not put the caret in the heading');
  assert.deepEqual(m.changes, [[...ANSWERED, '', '## Heading', 'Text', '## Later'].join('\n')]);
  assert.deepEqual(m.editor.caret, { line: 3, offset: 0 });
});

test('a click on the heading\'s text still edits the heading', () => {
  const m = mounted([...ANSWERED, '## Heading']);
  const h = m.row(3), y = h.t.getBoundingClientRect().top + 5;
  assert.equal(m.clickAt(y, h.t), false, 'the press is the browser\'s, which puts the caret in the heading');
  assert.equal(m.clickAt(y, h), false, 'beside the text too');
  assert.deepEqual(m.changes, []);
  assert.equal(m.editor.caret, null);
});

test('a click below the last line still goes to the end', () => {
  const m = mounted([...ANSWERED, '## Heading']);
  m.clickAt(m.under(3) + 100);
  assert.deepEqual(m.changes, []);
  assert.equal(m.editor.caret.line, 3, 'the end of the last line');
  assert.equal(m.editor.state.activeLine, 3);
});

test('the space under a code block and under a checklist works the same; the space between two lines of text does not', () => {
  const code = mounted(['```js', 'x = 1', '```', '## Next']);
  code.clickAt(code.under(2));
  assert.deepEqual(code.changes, [['```js', 'x = 1', '```', '', '## Next'].join('\n')]);
  const todos = mounted(['- [ ] one', '- [ ] two', 'After']);
  todos.clickAt(todos.under(1));
  assert.deepEqual(todos.changes, [['- [ ] one', '- [ ] two', '', 'After'].join('\n')]);
  assert.deepEqual(todos.editor.caret, { line: 2, offset: 0 });
  const plain = mounted(['One', 'Two', '## Three']);
  plain.clickAt(plain.under(0));
  assert.deepEqual(plain.changes, []);
  assert.equal(plain.editor.caret, null, 'not sent to the end either');
});

test('a drag that ends in the space under a card selects; it makes no line', () => {
  const m = mounted([...ANSWERED, '## Heading']);
  const on = m.editor.docListeners, y = m.under(2);
  on.mousedown({ target: m.row(1), button: 0, clientY: 45, preventDefault() {} });
  m.selection.isCollapsed = false;
  on.click({ target: m.root, clientY: y, preventDefault() {} });
  assert.deepEqual(m.changes, []);
  assert.equal(m.editor.caret, null);
});

test('a document that cannot be written in is not changed', () => {
  const m = mounted([...ANSWERED, '## Heading'], { readOnly: true });
  m.clickAt(m.under(2));
  const h = m.row(3);
  assert.equal(m.clickAt(h.getBoundingClientRect().top + 6, h), false);
  assert.deepEqual(m.changes, []);
});
