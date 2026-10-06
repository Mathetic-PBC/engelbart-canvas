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
function mounted(text = TEXT, props = {}) {
  const changes = [];
  const editor = new DocEditor({ docKey: 'k', text, onChange: (next) => changes.push(next), ...props });
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

// MATH-23: a note's or a workspace's mention clicked opens its document in the pane beside, ⌘-click still opens a note as
// a tab and goes to a workspace, and anything else is opened as before. An Escape the editor used (the caret leaving a
// line included, 2026-10-05) is marked as used, so the window's Escape (leaving the document's full screen) leaves it alone.

const LIBRARY = [
  { id: 'n1', name: 'Plan', type: 'md', tags: ['note'] },
  { id: 'p1', name: 'Paper', type: 'pdf', tags: ['paper'] },
];

/** An editor in a pane, with what it hands up recorded, and a mention of `name` in it to click. */
function inPane(props = {}) {
  const calls = { beside: [], item: [], ws: [] };
  const m = mounted(TEXT, {
    mentionable: LIBRARY,
    onOpenBeside: (row, link) => calls.beside.push([row.kind, row.id, link]),
    onOpenItem: (row) => calls.item.push(row.id),
    onOpenWorkspace: (id) => calls.ws.push(id),
    ...props,
  });
  const mention = (name, data = {}) => {
    const el = { dataset: { mention: name, ...data } };
    return { closest: (sel) => (sel === '[data-mention]' ? el : sel === '[data-editor]' ? m.root : null), matches: () => false };
  };
  const clickOn = (target, keys = {}) => { const e = { target, preventDefault() { e.prevented = true; }, ...keys }; m.editor.docListeners.click(e); return e; };
  return { ...m, calls, mention, clickOn };
}

test('a note\'s mention clicked opens the note beside the document, with the mention\'s text as its link', () => {
  const p = inPane();
  const e = p.clickOn(p.mention('Plan'));
  assert.deepEqual(p.calls.beside, [['note', 'n1', 'Plan']]);
  assert.deepEqual(p.calls.item, [], 'not as a tab');
  assert.equal(e.prevented, true);
});

test('⌘-click on a note\'s mention still opens it as a tab; other mentions open as before', () => {
  const p = inPane();
  p.clickOn(p.mention('Plan'), { metaKey: true });
  p.clickOn(p.mention('Paper'));
  p.clickOn(p.mention('Nothing by that name'));
  assert.deepEqual(p.calls.beside, []);
  assert.deepEqual(p.calls.item, ['n1', 'p1'], 'the note as a tab, the pdf on the Stage');
});

test('a workspace\'s mention clicked opens its document beside; ⌘-click goes to the workspace, as a click did before', () => {
  const p = inPane();
  const e = p.clickOn(p.mention('Elsewhere', { ws: 'w2' }));
  assert.deepEqual(p.calls.beside, [['workspace', 'w2', 'Elsewhere']]);
  assert.deepEqual(p.calls.ws, [], 'not gone to');
  assert.equal(e.prevented, true);
  p.clickOn(p.mention('Elsewhere', { ws: 'w2' }), { metaKey: true });
  assert.deepEqual(p.calls.ws, ['w2']);
  assert.equal(p.calls.beside.length, 1);
});

test('an editor with nowhere beside it (a post-it) opens a note\'s mention and goes to a workspace\'s as before', () => {
  const p = inPane({ onOpenBeside: undefined });
  p.clickOn(p.mention('Plan'));
  p.clickOn(p.mention('Elsewhere', { ws: 'w2' }));
  assert.deepEqual(p.calls.item, ['n1']);
  assert.deepEqual(p.calls.ws, ['w2']);
});

test('the mention whose note is open beside is marked, whatever its case; another, or a workspace\'s, is not', () => {
  const { editor } = mounted(TEXT, { besideLink: 'plan' });
  const mark = (mention, ws) => {
    const attrs = new Set();
    return { dataset: ws ? { mention, ws } : { mention }, hasAttribute: (name) => attrs.has(name), toggleAttribute: (name, on) => { if (on) attrs.add(name); else attrs.delete(name); return on; }, attrs };
  };
  const els = [mark('Plan'), mark('Paper'), mark('Plan', 'w1'), mark('PLAN')];
  editor.edRef = { current: { querySelectorAll: () => els } };
  editor.markBeside();
  assert.deepEqual(els.map((el) => el.attrs.has('data-beside')), [true, false, false, true]);
  editor.props = { ...editor.props, besideLink: null };
  editor.markBeside();
  assert.deepEqual(els.map((el) => el.attrs.has('data-beside')), [false, false, false, false], 'the pane beside closed: no mark is left');
});

test('the mention of the workspace open beside is marked by its id, not by its name', () => {
  const { editor } = mounted(TEXT, { besideWorkspace: 'w1' });
  const mark = (mention, ws) => {
    const attrs = new Set();
    return { dataset: ws ? { mention, ws } : { mention }, hasAttribute: (name) => attrs.has(name), toggleAttribute: (name, on) => { if (on) attrs.add(name); else attrs.delete(name); return on; }, attrs };
  };
  const els = [mark('Plan', 'w1'), mark('Plan'), mark('Plan', 'w2'), mark('Renamed since', 'w1')];
  editor.edRef = { current: { querySelectorAll: () => els } };
  editor.markBeside();
  assert.deepEqual(els.map((el) => el.attrs.has('data-beside')), [true, false, false, true]);
});

test('Escape in a field of the editor\'s own, or with a mention\'s card or the model selector open, is marked as used', () => {
  const field = (selector) => ({ closest: (sel) => (sel === '[data-editor]' ? field.root : null), matches: (sel) => sel.split(',').map((one) => one.trim()).includes(selector), dataset: { cardInput: '3', discoverInput: 't', buildInput: 'b1' }, blur() { this.blurred = true; } });
  for (const selector of ['[data-card-input]', '[data-follow-input]', '[data-discover-input]', '[data-build-input]']) {
    const { editor, root } = mounted();
    field.root = root;
    const target = field(selector);
    const e = { key: 'Escape', target, preventDefault() { e.prevented = true; } };
    editor.docListeners.keydown(e);
    assert.equal(e.prevented, true, selector);
    assert.equal(target.blurred, true, `${selector} is left`);
  }
  for (const open of [{ pop: { res: LIBRARY[0], anchor: {} } }, { picker: { kind: 'line', i: 0 } }]) {
    const { editor, line } = mounted();
    Object.assign(editor.state, open);
    const e = { key: 'Escape', target: line, preventDefault() { e.prevented = true; } };
    editor.docListeners.keydown(e);
    assert.equal(e.prevented, true, Object.keys(open)[0]);
    assert.equal(editor.state.pop || editor.state.picker || null, null, 'and it is shut');
  }
});

test('Escape on a line of the document takes the caret out of it and is marked as used: the full screen stays for the next one', () => {
  const { editor, root, line } = mounted();
  editor.caretInfo = () => ({ anchor: { line: 1, offset: 3 }, focus: { line: 1, offset: 3 } });
  root.blur = () => { root.blurred = true; };
  const e = { key: 'Escape', target: line, preventDefault() { e.prevented = true; } };
  editor.docListeners.keydown(e);
  assert.equal(e.prevented, true);
  assert.equal(root.blurred, true, 'the caret left the line');
});

test('the window\'s Escape with the key elsewhere shuts the editor\'s open menu first, and only then has nothing to shut', () => {
  for (const open of [{ mention: { line: 0 } }, { pop: { res: LIBRARY[0], anchor: {} } }, { picker: { kind: 'line', i: 0 } }]) {
    const { editor } = mounted();
    Object.assign(editor.state, open);
    assert.equal(editor.shutMenus(), true, Object.keys(open)[0]);
    assert.deepEqual([editor.state.mention, editor.state.pop, editor.state.picker], [null, null, null]);
    assert.equal(editor.shutMenus(), false, 'nothing left open');
  }
});
