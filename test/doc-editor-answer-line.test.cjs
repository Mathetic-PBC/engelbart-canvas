'use strict';

// The lines of an @bart answer (src/renderer/workspace/DocEditor.jsx): read only since 2026-10-16, drawn the same with the
// caret on them or not. A document's own lines are drawn as they were. There is no document here: the editor and its
// elements are stand-ins, as in doc-editor-cards.

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

// The mark's column (MATH-69).
const MARK_DRAWN = 'flex:none;min-width:1.75em;padding-right:0.25em;box-sizing:border-box';

const at = (editor, start) => editor.lines().findIndex((line) => line.includes(start));

// Since 2026-10-16 (David) an answer is never edited: each of its lines is read only, drawn the same with the caret on it
// or not, and shows no source.
test('an answer\'s heading, bullet and plain line are read only and drawn the same with the caret on them: no source', async () => {
  const editor = mounted(LINES);
  for (const start of ['## Reading', '- The highlight', 'Then a plain']) {
    const i = at(editor, start), shown = await drawn(editor, i, false), active = await drawn(editor, i, true);
    assert.match(shown.html, /contenteditable="false" data-readonly="1"/, `${start}: read only`);
    assert.equal(active.html, shown.html, `${start}: the caret on it changes nothing`);
    assert.equal(active.spans.length, 0, `${start}: no source spans`);
    assert.ok(editor.lockedAt(editor.lines(), i), `${start}: no typing in it`);
  }
  assert.match((await drawn(editor, at(editor, '## Reading'), true)).html, /font:600 17px/, 'the heading keeps its size');
  assert.doesNotMatch((await drawn(editor, at(editor, '## Reading'), true)).html, />## </, 'no `## `');
});

// MATH-69: the mark has one column, so a wrapped line hangs under the text.
const LIST = ['@bart lists?', ...replyLines('- A bullet that is long enough to wrap onto a second line of the card.\n  - A nested one.\n10. The tenth step.\n- [ ] A todo in an answer.', { level: { name: 'Sonnet', effort: 'high' }, trail: [], ms: 3000 }, { model: false }), ''];

test('an answer\'s bullet, number or todo puts its text after the mark\'s column, with the caret on it or not', async () => {
  const editor = mounted(LIST);
  for (const [start, depth] of [['- A bullet', 0], ['  - A nested', 18], ['10. The tenth', 0], ['- [ ] A todo', 0]]) {
    const i = at(editor, start);
    for (const active of [false, true]) {
      const { html } = await drawn(editor, i, active);
      const m = html.match(/<span style="display:flex;padding-left:(\d+)px"><span contenteditable="false" style="flex:none;min-width:([\d.]+em);/);
      assert.deepEqual(m && { depth: Number(m[1]), col: m[2] }, { depth, col: '1.75em' }, `${start}${active ? ', caret on it' : ''}`);
      assert.ok(html.includes(`style="${MARK_DRAWN};color:#8f8f8f;user-select:none"`), `${start}: the mark in its column`);
    }
  }
  assert.equal((await drawn(editor, at(editor, '10. The tenth'), false)).html.match(/user-select:none">([^<]*)</)[1], '10.', 'the number drawn as before');
});

test('a bullet in the document is drawn as it was', async () => {
  const editor = mounted(['- A document bullet', '  1. A numbered one', '']);
  for (const k of [0, 1]) for (const active of [false, true]) {
    const { html } = await drawn(editor, k, active);
    assert.match(html, /style="display:flex;align-items:flex-start;gap:10px;padding:4px 0 4px \d+px;min-height:35px"/);
    assert.match(html, /user-select:none;flex:none;(width|min-width):14px;text-align:(center|right)/);
    assert.doesNotMatch(html, /1\.75em/);
  }
});
