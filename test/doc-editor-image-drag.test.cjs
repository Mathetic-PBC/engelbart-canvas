'use strict';

// An image in the document is dragged to another place in it (2026-10-15, David: click, hold and drag it, in place of the
// zoom cursor; src/renderer/workspace/DocEditor.jsx startImgDrag). A press that does not move is a click, which still
// opens it large. It lands only between plain lines: never inside a conversation or a fenced code block (imgDropGaps).
// There is no document here: the editor and its elements are stand-ins, as in doc-editor-titles.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');
const { replyLines } = require('../src/main/bart/reply.cjs');
const { normalizeModels } = require('../src/main/bart/models.cjs');

function load(file) {
  const filename = path.join(__dirname, `__${path.basename(file, '.jsx')}-image-drag-unit.cjs`);
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace', file)], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty' } });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  compiled._compile(bundled.outputFiles[0].text, filename);
  return compiled.exports;
}

const { default: DocEditor, imgDropGaps, moveLineTo } = load('DocEditor.jsx');
const MODELS = normalizeModels(null);
const answer = (text) => replyLines([text], { level: { name: 'Sonnet', effort: 'high' }, trail: [], ms: 3000 }, { model: true });
const IMG = '![chart|w=320](https://example.org/chart.png)';

function mounted(lines, extra = {}) {
  const props = { ...extra, docKey: 'k', text: lines.join('\n'), models: MODELS, onChange: (next) => { props.text = next; }, onAsk: () => {}, onStopAsk: () => {} };
  const editor = new DocEditor(props);
  const listeners = {};
  const rows = [];
  const root = { closest: (sel) => (sel === '[data-editor]' ? root : null), matches: () => false, focus() {}, blur() {}, contains: () => false, querySelector: () => null, querySelectorAll: () => rows, getBoundingClientRect: () => ({ left: 100, width: 600, top: 0, bottom: 2000 }) };
  editor.props = props;
  editor.edRef = { current: root };
  editor.scrollRef = { current: { closest: () => null } };
  editor.setState = (patch) => Object.assign(editor.state, typeof patch === 'function' ? patch(editor.state) : patch);
  editor.forceUpdate = () => {};
  editor.syncEditor = () => {};
  editor.maybeRestoreView = () => {};
  editor.timer = (fn) => { fn(); return 0; };
  const made = [];
  globalThis.getSelection = () => ({ isCollapsed: true, rangeCount: 0 });
  globalThis.document = { addEventListener() {}, removeEventListener() {}, hasFocus: () => true, activeElement: null, createElement: () => { const el = { style: {}, remove() { el.removed = true; } }; made.push(el); return el; }, body: { appendChild() {} } };
  globalThis.window = { addEventListener: (type, fn) => { listeners[type] = fn; }, removeEventListener: (type) => { delete listeners[type]; } };
  editor.componentDidMount();
  // Each line drawn 40px tall, one under the other.
  rows.push(...lines.map((_, j) => ({ dataset: { line: String(j) }, getBoundingClientRect: () => ({ top: j * 40, bottom: j * 40 + 40, height: 40 }) })));
  return { editor, props, listeners, made, lines: () => editor.lines(), html: () => { editor.lastHtml = null; return editor.editorHtml(); } };
}

test('where a dragged image may land: before any plain line or at the end, never inside a conversation or a code block', () => {
  const ls = ['Notes', IMG, 'bart# [chat 2026-10-15T10:00:00Z] Retry', '@chat why?', ...answer('because'), 'After', '```js', 'x = 1', '```', 'End'];
  const gaps = imgDropGaps(ls), title = ls.indexOf('bart# [chat 2026-10-15T10:00:00Z] Retry'), after = ls.indexOf('After');
  assert.ok(gaps.has(0) && gaps.has(1) && gaps.has(2) && gaps.has(ls.length), 'the top, plain lines, the end');
  assert.ok(gaps.has(title), 'before a conversation, above its title');
  for (let j = title + 1; j < after; j++) assert.ok(!gaps.has(j), `not inside the conversation (${j})`);
  assert.ok(gaps.has(after), 'right after it');
  const open = ls.indexOf('```js');
  assert.ok(gaps.has(open) && !gaps.has(open + 1) && !gaps.has(open + 2), 'before the code block, not inside it (its line, its closing fence)');
  assert.ok(gaps.has(open + 3), 'right after its closing fence');
});

test('a line moved to stand before another, counted as before the move', () => {
  const ls = ['a', 'b', 'c', 'd'];
  assert.deepEqual(moveLineTo(ls, 0, 3), ['b', 'c', 'a', 'd'], 'down');
  assert.deepEqual(moveLineTo(ls, 3, 1), ['a', 'd', 'b', 'c'], 'up');
  assert.deepEqual(moveLineTo(ls, 1, 4), ['a', 'c', 'd', 'b'], 'to the end');
  assert.equal(moveLineTo(ls, 1, 1), ls, 'where it is');
  assert.equal(moveLineTo(ls, 1, 2), ls, 'just under itself: where it is');
});

test('an image shows the grab cursor, not the zoom one; a read-only document keeps the zoom', () => {
  assert.match(mounted(['Notes', IMG, 'End']).html(), /<img data-img="1"[^>]*cursor:grab"/);
  assert.match(mounted(['Notes', IMG, 'End'], { readOnly: true }).html(), /<img data-img="1"[^>]*cursor:zoom-in"/);
});

test('click, hold and drag: a small copy of the image follows the pointer, a dark grey line shows where it lands, letting go moves its line there; a click without a move still opens it large', () => {
  const m = mounted(['Notes', IMG, 'one', 'two', 'three', '']);
  const clones = [];
  const pic = { dataset: { img: '1' }, style: {}, getBoundingClientRect: () => ({ left: 100, top: 40, width: 600, height: 400 }), cloneNode: () => { const c = { style: {}, removeAttribute() {}, remove() {} }; clones.push(c); return c; } };
  m.editor.startImgDrag({ clientX: 120, clientY: 50 }, pic);
  m.listeners.mousemove({ clientX: 121, clientY: 51 });
  assert.equal(m.made.length, 0, 'a twitch is not a drag');
  m.listeners.mousemove({ clientX: 120, clientY: 158 });
  const bar = m.made[0];
  assert.ok(bar && bar.style.background === '#c9c9c9' && bar.style.display === 'block', 'the light grey line (2026-10-16)');
  assert.equal(bar.style.top, '159px', 'at the top of line 4, the nearest place');
  assert.equal(pic.style.filter, 'brightness(0) invert(.93)', 'the image left behind, light grey');
  assert.equal(clones[0].style.width, '220px', 'what follows the pointer is a small copy, at most 220px wide');
  assert.equal(clones[0].style.opacity, '1', 'and solid');
  m.listeners.mouseup();
  assert.deepEqual(m.lines(), ['Notes', 'one', 'two', IMG, 'three', '']);
  assert.ok(bar.removed && pic.style.filter === '', 'the line goes, the image is whole again');
  assert.ok(!m.listeners.mousemove, 'the drag is over');
  // The click that follows a drag opens nothing.
  m.editor.imgDragged = true;
  m.editor.editorClick({ target: { closest: (sel) => (sel === '[data-img]' ? { getAttribute: () => 'x' } : null) }, preventDefault() {} });
  assert.equal(m.editor.state.lightbox, null);
  m.editor.imgDragged = false;
  m.editor.editorClick({ target: { closest: (sel) => (sel === '[data-img]' ? { getAttribute: (a) => (a === 'src' ? 'https://example.org/chart.png' : 'chart') } : null) }, preventDefault() {} });
  assert.equal(m.editor.state.lightbox.src, 'https://example.org/chart.png', 'a plain click: large');
});

test('Escape, or letting go where it already is, leaves the image where it was', () => {
  const m = mounted(['Notes', IMG, 'one', 'two', '']);
  const pic = { dataset: { img: '1' }, style: {}, getBoundingClientRect: () => ({ left: 100, top: 40 }), cloneNode: () => ({ style: {}, removeAttribute() {}, remove() {} }) };
  m.editor.startImgDrag({ clientX: 120, clientY: 50 }, pic);
  m.listeners.mousemove({ clientX: 120, clientY: 125 });
  let stopped = false;
  m.listeners.keydown({ key: 'Escape', preventDefault() {}, stopPropagation() { stopped = true; } });
  assert.ok(stopped);
  assert.deepEqual(m.lines(), ['Notes', IMG, 'one', 'two', '']);
  m.editor.startImgDrag({ clientX: 120, clientY: 50 }, pic);
  m.listeners.mousemove({ clientX: 120, clientY: 45 });
  m.listeners.mouseup();
  assert.deepEqual(m.lines(), ['Notes', IMG, 'one', 'two', ''], 'just above or under itself: no move');
});
