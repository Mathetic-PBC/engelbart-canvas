'use strict';

// The line of an @bart answer the caret is on (src/renderer/workspace/DocEditor.jsx, 2026-10-05): it shows its source, as
// any line being edited does, but keeps its look. A heading keeps its size with its `## ` faint before it; a bullet keeps
// its place with its `- ` faint where the dot stood. The characters are the line's own, in order, so the caret's offsets
// are what they were. There is no document here: the editor and its elements are stand-ins, as in doc-editor-cards.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const { buildSync } = require('esbuild');
const { replyLines } = require('../src/main/bart/reply.cjs');

function load(file) {
  const filename = path.join(__dirname, `__${path.basename(file, '.jsx')}-answer-line-unit.cjs`);
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace', file)], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.js': 'jsx' }, logLevel: 'silent' });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  compiled._compile(bundled.outputFiles[0].text, filename);
  return compiled.exports;
}

const DocEditor = load('DocEditor.jsx').default;
const LINES = ['@bart how does reading work?', ...replyLines('## Reading a PDF\n- The highlight keeps its **zigzag** ink.\nThen a plain line.', { level: { name: 'Sonnet', effort: 'high' }, trail: [], ms: 3000 }, { model: false }), ''];

function mounted(lines) {
  const props = { docKey: 'k', text: lines.join('\n'), onChange: (next) => { props.text = next; } };
  const editor = new DocEditor(props);
  const root = { closest: (sel) => (sel === '[data-editor]' ? root : null), matches: () => false, focus() {}, blur() {}, contains: () => false, querySelector: () => null };
  editor.props = props;
  editor.edRef = { current: root };
  editor.scrollRef = { current: { closest: () => null } };
  editor.setState = (patch) => Object.assign(editor.state, typeof patch === 'function' ? patch(editor.state) : patch);
  editor.syncEditor = () => {};
  editor.maybeRestoreView = () => {};
  globalThis.getSelection = () => ({ isCollapsed: true, rangeCount: 0 });
  globalThis.document = { addEventListener() {}, removeEventListener() {}, hasFocus: () => true, activeElement: null };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  editor.componentDidMount();
  return editor;
}

/** Line `i` drawn, the caret on it (`active`) or not; with the text its spans stand for, in order. */
async function drawn(editor, i, active) {
  const { parseLine } = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);
  const ls = editor.lines(), p = parseLine(ls[i]);
  const html = editor.lineHtml(i, ls[i], p, active, false, editor.layout(ls).get(i), false);
  const spans = [...html.matchAll(/<span data-src="([^"]*)" data-open="\d" style="([^"]*)"|<span data-src="([^"]*)"/g)].map((m) => ({ src: m[1] ?? m[3], style: m[2] || '' }));
  return { html, p, spans };
}

const at = (editor, start) => editor.lines().findIndex((line) => line.includes(start));

test('a heading in an answer keeps its size while the caret is on it, its `## ` faint before it', async () => {
  const editor = mounted(LINES), i = at(editor, '## Reading');
  const { html, p, spans } = await drawn(editor, i, true);
  assert.match(html, /font:600 17px/, 'the heading\'s size, as when it is not being edited');
  assert.deepEqual(spans[0], { src: '## ', style: 'color:#b5b5b5;' });
  assert.equal(spans.map((s) => s.src).join(''), p.text, 'the line\'s own characters, in order');
  assert.doesNotMatch((await drawn(editor, i, false)).html, />## </, 'not being edited: no mark');
});

test('a bullet in an answer keeps its place while the caret is on it, its `- ` faint where the dot stood', async () => {
  const editor = mounted(LINES), i = at(editor, '- The highlight');
  const { html, p, spans } = await drawn(editor, i, true);
  assert.deepEqual(spans[0], { src: '- ', style: 'color:#b5b5b5;margin-right:4px;' });
  assert.equal(spans.map((s) => s.src).join(''), p.text);
  assert.match(html, /padding-left:0px;/, 'its depth\'s indent');
  assert.match(html, /background:#f5f5f5/, 'the light focus tint');
});

test('a plain line of an answer is edited as before: no faint mark', async () => {
  const editor = mounted(LINES), i = at(editor, 'Then a plain');
  const { p, spans, html } = await drawn(editor, i, true);
  assert.ok(spans.every((s) => !s.style.includes('#b5b5b5')));
  assert.equal(spans.map((s) => s.src).join(''), p.text);
  assert.doesNotMatch(html, /padding-left:\d+px;padding/, 'no bullet indent');
});
